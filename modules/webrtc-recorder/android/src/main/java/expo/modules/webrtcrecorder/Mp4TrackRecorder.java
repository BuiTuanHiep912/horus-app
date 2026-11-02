package expo.modules.webrtcrecorder;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.opengl.GLES20;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;
import android.view.Surface;

import com.oney.WebRTCModule.EglUtils;

import org.webrtc.EglBase;
import org.webrtc.GlRectDrawer;
import org.webrtc.VideoFrame;
import org.webrtc.VideoFrameDrawer;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Active recording session:
 * <ul>
 *   <li>Receives raw {@link VideoFrame}s from the processor tap, drops without blocking if the
 *       encoder thread is still busy with the previous frame, and renders the texture into an
 *       H.264 {@link MediaCodec} input {@link Surface} using the shared root EGL context.
 *   <li>Receives raw PCM audio from {@link AudioSampleDispatcher}, encodes to AAC-LC, and muxes
 *       both tracks into rolling {@code segment_NNNN.mp4} files.
 *   <li>On {@link #stop()}, finalizes the current segment and uses {@link SegmentStitcher} to
 *       losslessly remux all segments into a single playable MP4.
 * </ul>
 */
final class Mp4TrackRecorder implements AudioSampleDispatcher.Listener {
    private static final String TAG = "WebrtcRecorderRec";
    private static final String VIDEO_MIME = MediaFormat.MIMETYPE_VIDEO_AVC;
    private static final String AUDIO_MIME = MediaFormat.MIMETYPE_AUDIO_AAC;
    private static final int I_FRAME_INTERVAL_SEC = 1;
    private static final long AUDIO_WAIT_FOR_VIDEO_TIMEOUT_NS = 750_000_000L; // 750 ms

    interface ErrorCallback {
        void onError(String recordingId, String message);
    }

    static final class Config {
        final String recordingId;
        final String trackId;
        final File outputDir;
        final int requestedWidth;
        final int requestedHeight;
        final int fps;
        final int videoBitrate;
        final int audioBitrate;
        final int segmentSeconds;

        Config(
                String recordingId,
                String trackId,
                File outputDir,
                int requestedWidth,
                int requestedHeight,
                int fps,
                int videoBitrate,
                int audioBitrate,
                int segmentSeconds) {
            this.recordingId = recordingId;
            this.trackId = trackId;
            this.outputDir = outputDir;
            this.requestedWidth = requestedWidth;
            this.requestedHeight = requestedHeight;
            this.fps = fps > 0 ? fps : 30;
            this.videoBitrate = videoBitrate > 0 ? videoBitrate : 6_000_000;
            this.audioBitrate = audioBitrate > 0 ? audioBitrate : 128_000;
            this.segmentSeconds = segmentSeconds > 0 ? segmentSeconds : 20;
        }
    }

    static final class StopSummary {
        final String uri;
        final long durationMs;
        final long sizeBytes;

        StopSummary(String uri, long durationMs, long sizeBytes) {
            this.uri = uri;
            this.durationMs = durationMs;
            this.sizeBytes = sizeBytes;
        }
    }

    private final Config config;
    private final FrameStats stats;
    private final ErrorCallback errorCallback;
    private final File sessionDir;
    private final File finalOutputFile;

    private final HandlerThread videoThread;
    private final Handler videoHandler;
    private final HandlerThread audioThread;
    private final Handler audioHandler;

    private final AtomicBoolean active = new AtomicBoolean(false);
    private final AtomicReference<VideoFrame> pendingVideoFrame = new AtomicReference<>(null);
    private final Object muxerLock = new Object();

    // Video encoder + EGL state (owned by videoThread)
    private EglBase eglBase;
    private GlRectDrawer glDrawer;
    private VideoFrameDrawer frameDrawer;
    private MediaCodec videoEncoder;
    private Surface videoInputSurface;
    private MediaFormat pendingVideoFormat;
    private int encodedWidth;
    private int encodedHeight;
    private int currentRotation;

    // Audio encoder state (owned by audioThread)
    private MediaCodec audioEncoder;
    private MediaFormat pendingAudioFormat;
    private int audioSampleRate;
    private int audioChannels;
    private boolean expectAudioTrack;
    private long audioInstalledAtNs;
    private long audioStartMonotonicNs = -1L;
    private long audioSamplesFed = 0L;

    // Shared timestamp anchor (guarded by muxerLock)
    private long firstVideoFrameTimestampNs = -1L;
    private long firstVideoFrameMonotonicNs = -1L;

    // Rolling segment muxer state (guarded by muxerLock)
    private int currentSegmentIndex = 0;
    private File currentSegmentTmpFile;
    private MediaMuxer muxer;
    private boolean muxerStarted = false;
    private int muxerVideoTrack = -1;
    private int muxerAudioTrack = -1;
    private long segmentFirstVideoPtsUs = -1L;
    private long lastVideoPtsUs = -1L;
    private long lastAudioPtsUs = -1L;
    private long startedAtElapsedMs;

    Mp4TrackRecorder(Config config, FrameStats stats, ErrorCallback errorCallback)
            throws IOException {
        this.config = config;
        this.stats = stats;
        this.errorCallback = errorCallback;

        if (!config.outputDir.exists() && !config.outputDir.mkdirs()) {
            throw new IOException(
                    "Cannot create outputDir: " + config.outputDir.getAbsolutePath());
        }
        this.sessionDir = new File(config.outputDir, "rec_" + config.recordingId);
        if (!this.sessionDir.exists() && !this.sessionDir.mkdirs()) {
            throw new IOException(
                    "Cannot create sessionDir: " + this.sessionDir.getAbsolutePath());
        }
        this.finalOutputFile = new File(config.outputDir, "rec_" + config.recordingId + ".mp4");

        this.videoThread = new HandlerThread("WebrtcRecVideo-" + config.recordingId);
        this.videoThread.start();
        this.videoHandler = new Handler(this.videoThread.getLooper());

        this.audioThread = new HandlerThread("WebrtcRecAudio-" + config.recordingId);
        this.audioThread.start();
        this.audioHandler = new Handler(this.audioThread.getLooper());
    }

    String getRecordingId() {
        return config.recordingId;
    }

    void start() {
        startedAtElapsedMs = SystemClock.elapsedRealtime();
        expectAudioTrack =
                config.audioBitrate > 0 && AudioSampleDispatcher.INSTANCE.isCallbackWired();
        audioInstalledAtNs = System.nanoTime();
        active.set(true);
        if (expectAudioTrack) {
            AudioSampleDispatcher.INSTANCE.addListener(this);
        } else {
            Log.i(TAG, "Audio tap not active; recording video-only MP4");
        }
        Log.i(
                TAG,
                "Recorder started id="
                        + config.recordingId
                        + " dir="
                        + sessionDir.getAbsolutePath()
                        + " expectAudio="
                        + expectAudioTrack);
    }

    /**
     * Called on the WebRTC capture thread for every camera frame. Never blocks: if the encoder
     * thread has not yet consumed the previous frame, the older pending frame is dropped and
     * counted in {@link FrameStats#onDropped()}.
     */
    void onVideoFrame(VideoFrame frame) {
        if (!active.get()) return;
        frame.retain();
        VideoFrame displaced = pendingVideoFrame.getAndSet(frame);
        if (displaced != null) {
            displaced.release();
            stats.onDropped();
            return;
        }
        if (!videoHandler.post(this::processPendingVideoFrame)) {
            VideoFrame leaked = pendingVideoFrame.getAndSet(null);
            if (leaked != null) leaked.release();
        }
    }

    @Override
    public void onAudioSamples(
            int audioFormat,
            int channelCount,
            int sampleRate,
            byte[] data,
            long captureMonotonicNs) {
        if (!active.get() || !expectAudioTrack) return;
        final byte[] pcmCopy = data.clone();
        audioHandler.post(
                () ->
                        encodeAudioOnThread(
                                audioFormat, channelCount, sampleRate, pcmCopy, captureMonotonicNs));
    }

    StopSummary stop() throws IOException {
        if (!active.compareAndSet(true, false)) {
            throw new IOException("Recorder " + config.recordingId + " is not active");
        }
        AudioSampleDispatcher.INSTANCE.removeListener(this);

        // Release any queued frame that hasn't started encoding yet.
        VideoFrame leftover = pendingVideoFrame.getAndSet(null);
        if (leftover != null) {
            leftover.release();
        }

        // 1. Drain audio encoder on audioThread.
        CountDownLatch audioDone = new CountDownLatch(1);
        audioHandler.post(
                () -> {
                    try {
                        finishAudioEncoderOnThread();
                    } catch (Throwable t) {
                        Log.w(TAG, "finishAudioEncoderOnThread error", t);
                    } finally {
                        audioDone.countDown();
                    }
                });
        try {
            audioDone.await(3, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }

        // 2. Drain video encoder & close active segment on videoThread.
        CountDownLatch videoDone = new CountDownLatch(1);
        videoHandler.post(
                () -> {
                    try {
                        finishVideoAndSegmentOnThread();
                    } catch (Throwable t) {
                        Log.w(TAG, "finishVideoAndSegmentOnThread error", t);
                    } finally {
                        videoDone.countDown();
                    }
                });
        try {
            videoDone.await(5, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }

        videoThread.quitSafely();
        audioThread.quitSafely();

        long wallDurationMs = Math.max(500L, SystemClock.elapsedRealtime() - startedAtElapsedMs);
        SegmentStitcher.StitchResult stitched =
                SegmentStitcher.stitchSessionDir(sessionDir, finalOutputFile);
        long durationMs = stitched.durationMs > 0 ? stitched.durationMs : wallDurationMs;
        String uri = "file://" + stitched.outputFile.getAbsolutePath();
        Log.i(
                TAG,
                "Recorder stopped id="
                        + config.recordingId
                        + " uri="
                        + uri
                        + " durationMs="
                        + durationMs
                        + " size="
                        + stitched.sizeBytes
                        + " segments="
                        + stitched.segmentCount);
        return new StopSummary(uri, durationMs, stitched.sizeBytes);
    }

    // --- Video encoding thread -----------------------------------------------------------------

    private void processPendingVideoFrame() {
        VideoFrame frame = pendingVideoFrame.getAndSet(null);
        if (frame == null) return;
        try {
            if (!active.get()) return;
            long nowMonoNs = System.nanoTime();
            int bufW = evenDimension(frame.getBuffer().getWidth());
            int bufH = evenDimension(frame.getBuffer().getHeight());
            int rot = frame.getRotation();

            if (videoEncoder == null) {
                initVideoEncoderOnThread(bufW, bufH, rot);
            } else if (bufW != encodedWidth || bufH != encodedHeight || rot != currentRotation) {
                // Camera resolution/orientation changed mid-recording: finalize current segment and
                // re-create encoder for the new dimensions.
                Log.i(
                        TAG,
                        "Video geometry changed "
                                + encodedWidth
                                + "x"
                                + encodedHeight
                                + "@"
                                + currentRotation
                                + " -> "
                                + bufW
                                + "x"
                                + bufH
                                + "@"
                                + rot
                                + "; rolling segment");
                rollSegmentForGeometryChangeOnThread(bufW, bufH, rot);
            }

            long ptsUs;
            boolean rollNow;
            synchronized (muxerLock) {
                if (firstVideoFrameTimestampNs < 0) {
                    firstVideoFrameTimestampNs = frame.getTimestampNs();
                    firstVideoFrameMonotonicNs = nowMonoNs;
                }
                ptsUs =
                        RecorderTiming.videoPtsUs(
                                frame.getTimestampNs(),
                                firstVideoFrameTimestampNs,
                                lastVideoPtsUs);
                lastVideoPtsUs = ptsUs;
                if (segmentFirstVideoPtsUs < 0) {
                    segmentFirstVideoPtsUs = ptsUs;
                }
                rollNow =
                        muxerStarted
                                && RecorderTiming.shouldRollSegment(
                                        segmentFirstVideoPtsUs, ptsUs, config.segmentSeconds);
            }

            if (rollNow) {
                rollSegmentOnVideoThread(ptsUs);
            }

            // Render unrotated buffer into MediaCodec input surface; rotation is written into the
            // MP4 header via muxer.setOrientationHint(currentRotation) so there is no crop or stretch.
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
            VideoFrame unrotated =
                    new VideoFrame(frame.getBuffer(), 0, frame.getTimestampNs());
            frameDrawer.drawFrame(unrotated, glDrawer, null, 0, 0, encodedWidth, encodedHeight);
            eglBase.swapBuffers(TimeUnit.MICROSECONDS.toNanos(ptsUs));

            drainVideoEncoderOnThread(false);
        } catch (Throwable t) {
            Log.e(TAG, "Video frame encode failed", t);
            notifyError("Video encode error: " + t.getMessage());
        } finally {
            frame.release();
        }
    }

    private void initVideoEncoderOnThread(int width, int height, int rotation) throws IOException {
        this.encodedWidth = width;
        this.encodedHeight = height;
        this.currentRotation = rotation;

        MediaFormat format = MediaFormat.createVideoFormat(VIDEO_MIME, width, height);
        format.setInteger(
                MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        format.setInteger(MediaFormat.KEY_BIT_RATE, config.videoBitrate);
        format.setInteger(MediaFormat.KEY_FRAME_RATE, config.fps);
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, I_FRAME_INTERVAL_SEC);

        videoEncoder = MediaCodec.createEncoderByType(VIDEO_MIME);
        videoEncoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        videoInputSurface = videoEncoder.createInputSurface();

        EglBase.Context sharedContext = EglUtils.getRootEglBaseContext();
        eglBase = EglBase.create(sharedContext, EglBase.CONFIG_RECORDABLE);
        eglBase.createSurface(videoInputSurface);
        eglBase.makeCurrent();

        if (glDrawer == null) glDrawer = new GlRectDrawer();
        if (frameDrawer == null) frameDrawer = new VideoFrameDrawer();

        videoEncoder.start();

        synchronized (muxerLock) {
            if (muxer == null) {
                openNextSegmentMuxerLocked();
            }
        }
        Log.i(
                TAG,
                "Initialized H.264 encoder "
                        + width
                        + "x"
                        + height
                        + " rot="
                        + rotation
                        + " bitrate="
                        + config.videoBitrate
                        + " fps="
                        + config.fps);
    }

    private void drainVideoEncoderOnThread(boolean endOfStream) {
        if (videoEncoder == null) return;
        if (endOfStream) {
            try {
                videoEncoder.signalEndOfInputStream();
            } catch (Throwable t) {
                Log.w(TAG, "signalEndOfInputStream failed", t);
                return;
            }
        }
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        int loops = 0;
        while (loops++ < 200) {
            int outIndex = videoEncoder.dequeueOutputBuffer(info, endOfStream ? 10_000 : 0);
            if (outIndex == MediaCodec.INFO_TRY_AGAIN_LATER) {
                break;
            } else if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                MediaFormat newFormat = videoEncoder.getOutputFormat();
                synchronized (muxerLock) {
                    pendingVideoFormat = newFormat;
                    tryStartMuxerLocked();
                }
            } else if (outIndex >= 0) {
                ByteBuffer encoded = videoEncoder.getOutputBuffer(outIndex);
                if (encoded != null
                        && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0
                        && info.size > 0) {
                    synchronized (muxerLock) {
                        if (!muxerStarted) {
                            tryStartMuxerLocked();
                        }
                        if (muxerStarted && muxer != null && muxerVideoTrack >= 0) {
                            encoded.position(info.offset);
                            encoded.limit(info.offset + info.size);
                            try {
                                muxer.writeSampleData(muxerVideoTrack, encoded, info);
                            } catch (Throwable t) {
                                Log.w(TAG, "muxer.writeSampleData (video) failed", t);
                            }
                        }
                    }
                }
                videoEncoder.releaseOutputBuffer(outIndex, false);
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                    break;
                }
            }
        }
    }

    private void rollSegmentOnVideoThread(long nextFramePtsUs) {
        try {
            requestSyncFrame();
            synchronized (muxerLock) {
                closeCurrentSegmentMuxerLocked();
                segmentFirstVideoPtsUs = nextFramePtsUs;
                openNextSegmentMuxerLocked();
                tryStartMuxerLocked();
            }
        } catch (Throwable t) {
            Log.e(TAG, "Failed to roll segment", t);
        }
    }

    private void rollSegmentForGeometryChangeOnThread(int newW, int newH, int newRot)
            throws IOException {
        drainVideoEncoderOnThread(true);
        releaseVideoEncoderOnlyOnThread();
        synchronized (muxerLock) {
            closeCurrentSegmentMuxerLocked();
            pendingVideoFormat = null;
            segmentFirstVideoPtsUs = -1L;
        }
        initVideoEncoderOnThread(newW, newH, newRot);
    }

    private void requestSyncFrame() {
        if (videoEncoder == null) return;
        try {
            android.os.Bundle params = new android.os.Bundle();
            params.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
            videoEncoder.setParameters(params);
        } catch (Throwable ignored) {
        }
    }

    private void finishVideoAndSegmentOnThread() {
        try {
            drainVideoEncoderOnThread(true);
        } catch (Throwable t) {
            Log.w(TAG, "drainVideoEncoderOnThread(true) failed", t);
        }
        releaseVideoEncoderOnlyOnThread();
        if (glDrawer != null) {
            try {
                glDrawer.release();
            } catch (Throwable ignored) {
            }
            glDrawer = null;
        }
        if (frameDrawer != null) {
            try {
                frameDrawer.release();
            } catch (Throwable ignored) {
            }
            frameDrawer = null;
        }
        synchronized (muxerLock) {
            closeCurrentSegmentMuxerLocked();
        }
    }

    private void releaseVideoEncoderOnlyOnThread() {
        if (eglBase != null) {
            try {
                eglBase.releaseSurface();
            } catch (Throwable ignored) {
            }
            try {
                eglBase.release();
            } catch (Throwable ignored) {
            }
            eglBase = null;
        }
        if (videoEncoder != null) {
            try {
                videoEncoder.stop();
            } catch (Throwable ignored) {
            }
            try {
                videoEncoder.release();
            } catch (Throwable ignored) {
            }
            videoEncoder = null;
        }
        if (videoInputSurface != null) {
            try {
                videoInputSurface.release();
            } catch (Throwable ignored) {
            }
            videoInputSurface = null;
        }
    }

    // --- Audio encoding thread -----------------------------------------------------------------

    private void encodeAudioOnThread(
            int audioFormat,
            int channelCount,
            int sampleRate,
            byte[] pcmData,
            long captureMonotonicNs) {
        if (!active.get()) return;
        try {
            long anchorMonoNs;
            synchronized (muxerLock) {
                if (firstVideoFrameMonotonicNs < 0) {
                    // Wait until the first video frame establishes the t=0 anchor so audio and
                    // video start aligned.
                    return;
                }
                anchorMonoNs = firstVideoFrameMonotonicNs;
            }

            if (audioEncoder == null) {
                initAudioEncoderOnThread(sampleRate, channelCount);
                int samplesInChunk =
                        RecorderTiming.pcm16SamplesPerChannel(pcmData.length, channelCount);
                long chunkDurationNs =
                        sampleRate > 0
                                ? (samplesInChunk * RecorderTiming.NANOS_PER_SECOND) / sampleRate
                                : 0L;
                audioStartMonotonicNs = Math.max(anchorMonoNs, captureMonotonicNs - chunkDurationNs);
                audioSamplesFed = 0L;
            }

            int offset = 0;
            while (offset < pcmData.length && active.get()) {
                int inIndex = audioEncoder.dequeueInputBuffer(5_000);
                if (inIndex < 0) {
                    drainAudioEncoderOnThread(false);
                    break;
                }
                ByteBuffer inBuf = audioEncoder.getInputBuffer(inIndex);
                if (inBuf == null) break;
                inBuf.clear();
                int toCopy = Math.min(inBuf.remaining(), pcmData.length - offset);
                inBuf.put(pcmData, offset, toCopy);

                long ptsUs;
                synchronized (muxerLock) {
                    ptsUs =
                            RecorderTiming.audioPtsUs(
                                    audioStartMonotonicNs,
                                    anchorMonoNs,
                                    audioSamplesFed,
                                    audioSampleRate,
                                    lastAudioPtsUs);
                    lastAudioPtsUs = ptsUs;
                }
                int samplesCopied =
                        RecorderTiming.pcm16SamplesPerChannel(toCopy, audioChannels);
                audioSamplesFed += samplesCopied;
                offset += toCopy;

                audioEncoder.queueInputBuffer(inIndex, 0, toCopy, ptsUs, 0);
                drainAudioEncoderOnThread(false);
            }
        } catch (Throwable t) {
            Log.e(TAG, "Audio encode failed", t);
        }
    }

    private void initAudioEncoderOnThread(int sampleRate, int channelCount) throws IOException {
        this.audioSampleRate = sampleRate > 0 ? sampleRate : 48_000;
        this.audioChannels = channelCount > 0 ? channelCount : 1;

        MediaFormat format =
                MediaFormat.createAudioFormat(AUDIO_MIME, this.audioSampleRate, this.audioChannels);
        format.setInteger(
                MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        format.setInteger(MediaFormat.KEY_BIT_RATE, config.audioBitrate);
        format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16_384);

        audioEncoder = MediaCodec.createEncoderByType(AUDIO_MIME);
        audioEncoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        audioEncoder.start();
        Log.i(
                TAG,
                "Initialized AAC encoder sr="
                        + this.audioSampleRate
                        + " ch="
                        + this.audioChannels
                        + " bitrate="
                        + config.audioBitrate);
    }

    private void drainAudioEncoderOnThread(boolean endOfStream) {
        if (audioEncoder == null) return;
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        int loops = 0;
        while (loops++ < 200) {
            int outIndex = audioEncoder.dequeueOutputBuffer(info, endOfStream ? 5_000 : 0);
            if (outIndex == MediaCodec.INFO_TRY_AGAIN_LATER) {
                break;
            } else if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                MediaFormat newFormat = audioEncoder.getOutputFormat();
                synchronized (muxerLock) {
                    pendingAudioFormat = newFormat;
                    tryStartMuxerLocked();
                }
            } else if (outIndex >= 0) {
                ByteBuffer encoded = audioEncoder.getOutputBuffer(outIndex);
                if (encoded != null
                        && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0
                        && info.size > 0) {
                    synchronized (muxerLock) {
                        if (muxerStarted && muxer != null && muxerAudioTrack >= 0) {
                            encoded.position(info.offset);
                            encoded.limit(info.offset + info.size);
                            try {
                                muxer.writeSampleData(muxerAudioTrack, encoded, info);
                            } catch (Throwable t) {
                                Log.w(TAG, "muxer.writeSampleData (audio) failed", t);
                            }
                        }
                    }
                }
                audioEncoder.releaseOutputBuffer(outIndex, false);
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                    break;
                }
            }
        }
    }

    private void finishAudioEncoderOnThread() {
        if (audioEncoder == null) return;
        try {
            int inIndex = audioEncoder.dequeueInputBuffer(5_000);
            if (inIndex >= 0) {
                audioEncoder.queueInputBuffer(
                        inIndex,
                        0,
                        0,
                        Math.max(0L, lastAudioPtsUs + 1L),
                        MediaCodec.BUFFER_FLAG_END_OF_STREAM);
            }
            drainAudioEncoderOnThread(true);
        } catch (Throwable t) {
            Log.w(TAG, "Audio EOS drain failed", t);
        } finally {
            try {
                audioEncoder.stop();
            } catch (Throwable ignored) {
            }
            try {
                audioEncoder.release();
            } catch (Throwable ignored) {
            }
            audioEncoder = null;
        }
    }

    // --- Rolling segment MediaMuxer management (must hold muxerLock) ---------------------------

    private void openNextSegmentMuxerLocked() throws IOException {
        String finalName = RecorderTiming.segmentFileName(currentSegmentIndex);
        currentSegmentTmpFile = new File(sessionDir, finalName + ".tmp");
        if (currentSegmentTmpFile.exists()) currentSegmentTmpFile.delete();
        muxer =
                new MediaMuxer(
                        currentSegmentTmpFile.getAbsolutePath(),
                        MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
        muxer.setOrientationHint(currentRotation);
        muxerStarted = false;
        muxerVideoTrack = -1;
        muxerAudioTrack = -1;
    }

    private void tryStartMuxerLocked() {
        if (muxer == null || muxerStarted || pendingVideoFormat == null) return;

        // If audio is expected, wait up to AUDIO_WAIT_FOR_VIDEO_TIMEOUT_NS for the AAC format; if
        // mic capture has not produced samples by then (e.g. muted/disabled), start video-only so
        // recording never stalls.
        if (expectAudioTrack && pendingAudioFormat == null) {
            long waitedNs = System.nanoTime() - audioInstalledAtNs;
            if (waitedNs < AUDIO_WAIT_FOR_VIDEO_TIMEOUT_NS) {
                return;
            }
            Log.w(TAG, "Audio format not ready after 750ms; starting segment video-only");
            expectAudioTrack = false;
        }

        muxerVideoTrack = muxer.addTrack(pendingVideoFormat);
        if (expectAudioTrack && pendingAudioFormat != null) {
            muxerAudioTrack = muxer.addTrack(pendingAudioFormat);
        }
        muxer.start();
        muxerStarted = true;
    }

    private void closeCurrentSegmentMuxerLocked() {
        if (muxer == null) return;
        boolean wasStarted = muxerStarted;
        File tmpFile = currentSegmentTmpFile;
        int finishedIndex = currentSegmentIndex;
        try {
            if (wasStarted) {
                muxer.stop();
            }
        } catch (Throwable t) {
            Log.w(TAG, "muxer.stop failed for segment " + finishedIndex, t);
            wasStarted = false;
        }
        try {
            muxer.release();
        } catch (Throwable ignored) {
        }
        muxer = null;
        muxerStarted = false;
        muxerVideoTrack = -1;
        muxerAudioTrack = -1;
        currentSegmentTmpFile = null;

        if (tmpFile != null && tmpFile.exists()) {
            if (wasStarted && tmpFile.length() > 0) {
                File finalized =
                        new File(sessionDir, RecorderTiming.segmentFileName(finishedIndex));
                if (finalized.exists()) finalized.delete();
                if (!tmpFile.renameTo(finalized)) {
                    try {
                        SegmentStitcher.moveOrCopy(tmpFile, finalized);
                    } catch (IOException e) {
                        Log.w(TAG, "Failed to finalize segment " + finishedIndex, e);
                    }
                }
                currentSegmentIndex++;
            } else {
                tmpFile.delete();
            }
        }
    }

    private void notifyError(String message) {
        if (errorCallback != null) {
            errorCallback.onError(config.recordingId, message);
        }
    }

    private static int evenDimension(int v) {
        int even = v & ~1;
        return Math.max(2, even);
    }
}
