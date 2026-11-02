package expo.modules.webrtcrecorder;

import com.oney.WebRTCModule.videoEffects.VideoEffectProcessor;
import com.oney.WebRTCModule.videoEffects.VideoFrameProcessor;

import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoFrame;

import java.lang.reflect.Field;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Frame processor registered under {@link #PROCESSOR_NAME}. Measures every frame in
 * {@link FrameStats}, forwards it to the active {@link Mp4TrackRecorder} if recording, and returns
 * the frame unchanged to WebRTC. Enabled on a local track from JS with
 * {@code track._setVideoEffects([PROCESSOR_NAME])}.
 */
final class ProbeFrameProcessor implements VideoFrameProcessor {
    static final String PROCESSOR_NAME = "webrtcRecorderProbe";

    private static final AtomicReference<Mp4TrackRecorder> ACTIVE_RECORDER =
            new AtomicReference<>(null);

    private final FrameStats stats;

    ProbeFrameProcessor(FrameStats stats) {
        this.stats = stats;
    }

    static void setActiveRecorder(Mp4TrackRecorder recorder) {
        ACTIVE_RECORDER.set(recorder);
    }

    static Mp4TrackRecorder getActiveRecorder() {
        return ACTIVE_RECORDER.get();
    }

    @Override
    public VideoFrame process(VideoFrame frame, SurfaceTextureHelper textureHelper) {
        stats.onFrame(frame);
        Mp4TrackRecorder rec = ACTIVE_RECORDER.get();
        if (rec != null) {
            rec.onVideoFrame(frame);
        }
        // The caller releases the returned frame and the input separately, so hand back our own ref.
        frame.retain();
        return frame;
    }

    // --- raw-frame patch switch (patches/react-native-webrtc+*.patch) -------------------------
    // Reflection so this module still compiles and runs (stock behaviour) without the patch.

    private static Field rawFlag() {
        try {
            return VideoEffectProcessor.class.getField("processRawFrames");
        } catch (NoSuchFieldException e) {
            return null;
        }
    }

    static boolean isRawPatchApplied() {
        return rawFlag() != null;
    }

    /** @return the flag value now in effect (false if the patch is missing). */
    static boolean setRawFrames(boolean enabled) {
        Field f = rawFlag();
        if (f == null) return false;
        try {
            f.setBoolean(null, enabled);
            return f.getBoolean(null);
        } catch (IllegalAccessException e) {
            return false;
        }
    }

    static boolean getRawFrames() {
        Field f = rawFlag();
        if (f == null) return false;
        try {
            return f.getBoolean(null);
        } catch (IllegalAccessException e) {
            return false;
        }
    }
}
