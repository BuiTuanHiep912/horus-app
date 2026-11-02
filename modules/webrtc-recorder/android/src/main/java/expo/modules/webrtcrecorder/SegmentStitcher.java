package expo.modules.webrtcrecorder;

import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMetadataRetriever;
import android.media.MediaMuxer;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.ArrayList;
import java.util.List;

/**
 * Lossless segment stitcher and crash-recovery helper using {@link MediaExtractor} +
 * {@link MediaMuxer} (no re-encoding).
 *
 * <p>Note on fragmented MP4: {@code MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4} writes a standard
 * MP4 (moov atom finalized only in {@code stop()}); Android's {@code MediaMuxer} does not expose a
 * public fragmented-MP4 output format across API 24-34, so rolling finalized segments + lossless
 * remux on stop/recovery is required for crash safety.
 */
final class SegmentStitcher {
    private static final String TAG = "WebrtcRecorderStitch";
    private static final int COPY_BUFFER_BYTES = 1024 * 1024; // 1 MiB
    private static final long DEFAULT_FRAME_DELTA_US = 33_333L;

    static final class StitchResult {
        final File outputFile;
        final long durationMs;
        final long sizeBytes;
        final int segmentCount;

        StitchResult(File outputFile, long durationMs, long sizeBytes, int segmentCount) {
            this.outputFile = outputFile;
            this.durationMs = durationMs;
            this.sizeBytes = sizeBytes;
            this.segmentCount = segmentCount;
        }
    }

    private SegmentStitcher() {}

    /**
     * Stitches all finalized {@code segment_NNNN.mp4} files in {@code sessionDir} into
     * {@code destFile}. If there is only one segment, moves/copies it directly without remuxing.
     * Deletes segment files and {@code sessionDir} once {@code destFile} is finalized.
     */
    static StitchResult stitchSessionDir(File sessionDir, File destFile) throws IOException {
        List<File> segments = RecorderTiming.listFinalizedSegments(sessionDir);
        if (segments.isEmpty()) {
            throw new IOException(
                    "No finalized segments in "
                            + (sessionDir != null ? sessionDir.getAbsolutePath() : "null"));
        }

        File parent = destFile.getParentFile();
        if (parent != null && !parent.exists()) {
            parent.mkdirs();
        }

        long durationMs;
        if (segments.size() == 1) {
            File only = segments.get(0);
            durationMs = probeDurationMs(only);
            moveOrCopy(only, destFile);
        } else {
            durationMs = remuxSegments(segments, destFile);
            if (durationMs <= 0) {
                durationMs = probeDurationMs(destFile);
            }
        }

        deleteDirectoryQuietly(sessionDir);
        return new StitchResult(destFile, durationMs, destFile.length(), segments.size());
    }

    /**
     * Scans {@code rootOutputDir} for leftover {@code rec_*} segment folders from a previous crash
     * or process kill, stitches each one that has at least one finalized segment into
     * {@code <rootOutputDir>/recovered_<folderName>.mp4}, and deletes empty/corrupt folders.
     */
    static List<StitchResult> recoverLeftoverSessions(File rootOutputDir) {
        List<StitchResult> recovered = new ArrayList<>();
        if (rootOutputDir == null || !rootOutputDir.isDirectory()) return recovered;
        File[] children = rootOutputDir.listFiles();
        if (children == null) return recovered;

        for (File child : children) {
            if (!child.isDirectory() || !child.getName().startsWith("rec_")) continue;
            List<File> segments = RecorderTiming.listFinalizedSegments(child);
            if (segments.isEmpty()) {
                deleteDirectoryQuietly(child);
                continue;
            }
            File out = new File(rootOutputDir, "recovered_" + child.getName() + ".mp4");
            try {
                StitchResult res = stitchSessionDir(child, out);
                Log.i(
                        TAG,
                        "Recovered crashed session "
                                + child.getName()
                                + " -> "
                                + out.getName()
                                + " ("
                                + res.segmentCount
                                + " segments, "
                                + res.durationMs
                                + " ms)");
                recovered.add(res);
            } catch (Throwable t) {
                Log.w(TAG, "Failed to stitch leftover session " + child.getName(), t);
            }
        }
        return recovered;
    }

    private static long remuxSegments(List<File> segments, File destFile) throws IOException {
        File tmpFile = new File(destFile.getParentFile(), destFile.getName() + ".stitching.tmp");
        if (tmpFile.exists()) tmpFile.delete();

        MediaMuxer muxer =
                new MediaMuxer(
                        tmpFile.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
        boolean muxerStarted = false;
        int muxerVideoTrack = -1;
        int muxerAudioTrack = -1;
        int videoWidth = -1;
        int videoHeight = -1;
        ByteBuffer buffer = ByteBuffer.allocateDirect(COPY_BUFFER_BYTES);
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();

        long videoOffsetUs = 0L;
        long audioOffsetUs = 0L;
        long lastMuxedVideoPtsUs = -1L;
        long lastMuxedAudioPtsUs = -1L;

        try {
            // Pass 1: discover video & audio formats and orientation from the first segment that
            // has them.
            for (File seg : segments) {
                MediaExtractor ex = new MediaExtractor();
                try {
                    ex.setDataSource(seg.getAbsolutePath());
                    int count = ex.getTrackCount();
                    for (int i = 0; i < count; i++) {
                        MediaFormat fmt = ex.getTrackFormat(i);
                        String mime = fmt.getString(MediaFormat.KEY_MIME);
                        if (mime == null) continue;
                        if (mime.startsWith("video/") && muxerVideoTrack < 0) {
                            muxerVideoTrack = muxer.addTrack(fmt);
                            if (fmt.containsKey(MediaFormat.KEY_WIDTH)) {
                                videoWidth = fmt.getInteger(MediaFormat.KEY_WIDTH);
                            }
                            if (fmt.containsKey(MediaFormat.KEY_HEIGHT)) {
                                videoHeight = fmt.getInteger(MediaFormat.KEY_HEIGHT);
                            }
                            if (fmt.containsKey(MediaFormat.KEY_ROTATION)) {
                                muxer.setOrientationHint(fmt.getInteger(MediaFormat.KEY_ROTATION));
                            } else {
                                int rot = probeRotation(seg);
                                if (rot != 0) muxer.setOrientationHint(rot);
                            }
                        } else if (mime.startsWith("audio/") && muxerAudioTrack < 0) {
                            muxerAudioTrack = muxer.addTrack(fmt);
                        }
                    }
                } finally {
                    ex.release();
                }
                if (muxerVideoTrack >= 0 && muxerAudioTrack >= 0) break;
            }

            if (muxerVideoTrack < 0) {
                throw new IOException("No video track found in any segment");
            }

            muxer.start();
            muxerStarted = true;

            // Pass 2: copy samples from each segment in order, shifting timestamps so the timeline
            // is continuous across segment boundaries.
            for (File seg : segments) {
                MediaExtractor ex = new MediaExtractor();
                try {
                    ex.setDataSource(seg.getAbsolutePath());
                    int srcVideo = -1;
                    int srcAudio = -1;
                    int count = ex.getTrackCount();
                    for (int i = 0; i < count; i++) {
                        MediaFormat fmt = ex.getTrackFormat(i);
                        String mime = fmt.getString(MediaFormat.KEY_MIME);
                        if (mime == null) continue;
                        if (mime.startsWith("video/") && srcVideo < 0) {
                            // Guard against mid-recording resolution changes: MediaMuxer cannot
                            // switch SPS/PPS mid-file without a new track.
                            int w =
                                    fmt.containsKey(MediaFormat.KEY_WIDTH)
                                            ? fmt.getInteger(MediaFormat.KEY_WIDTH)
                                            : videoWidth;
                            int h =
                                    fmt.containsKey(MediaFormat.KEY_HEIGHT)
                                            ? fmt.getInteger(MediaFormat.KEY_HEIGHT)
                                            : videoHeight;
                            if (w == videoWidth && h == videoHeight) {
                                srcVideo = i;
                            } else {
                                Log.w(
                                        TAG,
                                        "Skipping segment with changed resolution "
                                                + w
                                                + "x"
                                                + h
                                                + " (expected "
                                                + videoWidth
                                                + "x"
                                                + videoHeight
                                                + ")");
                            }
                        } else if (mime.startsWith("audio/")
                                && srcAudio < 0
                                && muxerAudioTrack >= 0) {
                            srcAudio = i;
                        }
                    }

                    long segFirstVideoPts = -1L;
                    long segLastVideoPts = -1L;
                    if (srcVideo >= 0) {
                        ex.selectTrack(srcVideo);
                        while (true) {
                            buffer.clear();
                            int sampleSize = ex.readSampleData(buffer, 0);
                            if (sampleSize < 0) break;
                            long sampleTime = ex.getSampleTime();
                            if (segFirstVideoPts < 0) segFirstVideoPts = sampleTime;
                            segLastVideoPts = sampleTime;
                            long pts = videoOffsetUs + Math.max(0L, sampleTime - segFirstVideoPts);
                            if (lastMuxedVideoPtsUs >= 0 && pts <= lastMuxedVideoPtsUs) {
                                pts = lastMuxedVideoPtsUs + 1L;
                            }
                            lastMuxedVideoPtsUs = pts;
                            info.offset = 0;
                            info.size = sampleSize;
                            info.presentationTimeUs = pts;
                            info.flags = mapExtractorFlags(ex.getSampleFlags());
                            muxer.writeSampleData(muxerVideoTrack, buffer, info);
                            ex.advance();
                        }
                        ex.unselectTrack(srcVideo);
                    }

                    long segFirstAudioPts = -1L;
                    long segLastAudioPts = -1L;
                    if (srcAudio >= 0) {
                        ex.selectTrack(srcAudio);
                        while (true) {
                            buffer.clear();
                            int sampleSize = ex.readSampleData(buffer, 0);
                            if (sampleSize < 0) break;
                            long sampleTime = ex.getSampleTime();
                            if (segFirstAudioPts < 0) segFirstAudioPts = sampleTime;
                            segLastAudioPts = sampleTime;
                            long pts = audioOffsetUs + Math.max(0L, sampleTime - segFirstAudioPts);
                            if (lastMuxedAudioPtsUs >= 0 && pts <= lastMuxedAudioPtsUs) {
                                pts = lastMuxedAudioPtsUs + 1L;
                            }
                            lastMuxedAudioPtsUs = pts;
                            info.offset = 0;
                            info.size = sampleSize;
                            info.presentationTimeUs = pts;
                            info.flags = mapExtractorFlags(ex.getSampleFlags());
                            muxer.writeSampleData(muxerAudioTrack, buffer, info);
                            ex.advance();
                        }
                        ex.unselectTrack(srcAudio);
                    }

                    long segSpanUs =
                            (segFirstVideoPts >= 0 && segLastVideoPts >= segFirstVideoPts)
                                    ? (segLastVideoPts - segFirstVideoPts + DEFAULT_FRAME_DELTA_US)
                                    : (segFirstAudioPts >= 0 && segLastAudioPts >= segFirstAudioPts)
                                            ? (segLastAudioPts
                                                    - segFirstAudioPts
                                                    + DEFAULT_FRAME_DELTA_US)
                                            : 0L;
                    videoOffsetUs =
                            Math.max(
                                    videoOffsetUs + segSpanUs,
                                    lastMuxedVideoPtsUs >= 0
                                            ? lastMuxedVideoPtsUs + DEFAULT_FRAME_DELTA_US
                                            : 0L);
                    audioOffsetUs =
                            Math.max(
                                    audioOffsetUs + segSpanUs,
                                    lastMuxedAudioPtsUs >= 0 ? lastMuxedAudioPtsUs + 21_333L : 0L);
                } finally {
                    ex.release();
                }
            }
        } finally {
            try {
                if (muxerStarted) muxer.stop();
            } catch (Throwable t) {
                Log.w(TAG, "muxer.stop in stitcher failed", t);
            }
            try {
                muxer.release();
            } catch (Throwable ignored) {
            }
        }

        moveOrCopy(tmpFile, destFile);
        return Math.max(0L, lastMuxedVideoPtsUs / 1000L);
    }

    private static int mapExtractorFlags(int sampleFlags) {
        int flags = 0;
        if ((sampleFlags & MediaExtractor.SAMPLE_FLAG_SYNC) != 0) {
            flags |= MediaCodec.BUFFER_FLAG_KEY_FRAME;
        }
        if ((sampleFlags & MediaExtractor.SAMPLE_FLAG_PARTIAL_FRAME) != 0) {
            flags |= MediaCodec.BUFFER_FLAG_PARTIAL_FRAME;
        }
        return flags;
    }

    static long probeDurationMs(File mp4) {
        MediaMetadataRetriever mmr = new MediaMetadataRetriever();
        try {
            mmr.setDataSource(mp4.getAbsolutePath());
            String d = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            return d != null ? Long.parseLong(d) : 0L;
        } catch (Throwable t) {
            return 0L;
        } finally {
            try {
                mmr.release();
            } catch (Throwable ignored) {
            }
        }
    }

    private static int probeRotation(File mp4) {
        MediaMetadataRetriever mmr = new MediaMetadataRetriever();
        try {
            mmr.setDataSource(mp4.getAbsolutePath());
            String r = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
            return r != null ? Integer.parseInt(r) : 0;
        } catch (Throwable t) {
            return 0;
        } finally {
            try {
                mmr.release();
            } catch (Throwable ignored) {
            }
        }
    }

    static void moveOrCopy(File src, File dst) throws IOException {
        if (dst.exists()) dst.delete();
        if (src.renameTo(dst)) return;
        try (FileInputStream in = new FileInputStream(src);
                FileOutputStream out = new FileOutputStream(dst);
                FileChannel inCh = in.getChannel();
                FileChannel outCh = out.getChannel()) {
            long size = inCh.size();
            long pos = 0;
            while (pos < size) {
                pos += inCh.transferTo(pos, size - pos, outCh);
            }
        }
        src.delete();
    }

    static void deleteDirectoryQuietly(File dir) {
        if (dir == null || !dir.exists()) return;
        File[] children = dir.listFiles();
        if (children != null) {
            for (File c : children) {
                if (c.isDirectory()) {
                    deleteDirectoryQuietly(c);
                } else {
                    c.delete();
                }
            }
        }
        dir.delete();
    }
}
