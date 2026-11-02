package expo.modules.webrtcrecorder;

import android.os.SystemClock;

import org.webrtc.VideoFrame;

import java.util.HashMap;
import java.util.Map;

/**
 * Counts what the react-native-webrtc frame tap receives. Frames are recorded on the capture
 * thread; {@link #tick()} and {@link #summary()} are called from the stats ticker thread.
 * Cheap enough to run on every frame (one short synchronized block).
 */
final class FrameStats {
    private final Object lock = new Object();

    // Current 1 s window
    private int windowFrames;
    private long windowStartMs;
    private long windowMaxGapNs;
    private int windowDropped;

    // Last frame seen
    private int width;
    private int height;
    private int rotation;
    private long lastTimestampNs = -1;

    // Whole session (since reset)
    private long sessionStartMs;
    private long totalFrames;
    private long totalDropped;
    private long sessionMaxGapNs;
    private final Map<String, Long> framesPerResolution = new HashMap<>();

    void reset() {
        synchronized (lock) {
            long now = SystemClock.elapsedRealtime();
            windowFrames = 0;
            windowStartMs = now;
            windowMaxGapNs = 0;
            windowDropped = 0;
            width = 0;
            height = 0;
            rotation = 0;
            lastTimestampNs = -1;
            sessionStartMs = now;
            totalFrames = 0;
            totalDropped = 0;
            sessionMaxGapNs = 0;
            framesPerResolution.clear();
        }
    }

    void onFrame(VideoFrame frame) {
        // Buffer size is the unrotated sensor-orientation size; rotation is reported separately.
        int w = frame.getBuffer().getWidth();
        int h = frame.getBuffer().getHeight();
        long ts = frame.getTimestampNs();
        synchronized (lock) {
            windowFrames++;
            totalFrames++;
            if (lastTimestampNs >= 0 && ts > lastTimestampNs) {
                long gap = ts - lastTimestampNs;
                if (gap > windowMaxGapNs) windowMaxGapNs = gap;
                if (gap > sessionMaxGapNs) sessionMaxGapNs = gap;
            }
            lastTimestampNs = ts;
            width = w;
            height = h;
            rotation = frame.getRotation();
            String key = w + "x" + h;
            Long n = framesPerResolution.get(key);
            framesPerResolution.put(key, n == null ? 1L : n + 1L);
        }
    }

    void onDropped() {
        synchronized (lock) {
            windowDropped++;
            totalDropped++;
        }
    }

    /** Snapshot of the window that just ended, then starts a new window. */
    Map<String, Object> tick() {
        synchronized (lock) {
            long now = SystemClock.elapsedRealtime();
            double seconds = Math.max(1, now - windowStartMs) / 1000.0;
            Map<String, Object> m = new HashMap<>();
            m.put("fps", Math.round(windowFrames / seconds * 10) / 10.0);
            m.put("width", width);
            m.put("height", height);
            m.put("rotation", rotation);
            m.put("maxGapMs", windowMaxGapNs / 1_000_000.0);
            m.put("droppedFrames", windowDropped);
            m.put("totalFrames", (double) totalFrames);
            windowFrames = 0;
            windowStartMs = now;
            windowMaxGapNs = 0;
            windowDropped = 0;
            return m;
        }
    }

    Map<String, Object> summary() {
        synchronized (lock) {
            long durationMs = SystemClock.elapsedRealtime() - sessionStartMs;
            Map<String, Object> m = new HashMap<>();
            m.put("durationMs", (double) durationMs);
            m.put("totalFrames", (double) totalFrames);
            m.put("avgFps", durationMs > 0 ? Math.round(totalFrames * 10000.0 / durationMs) / 10.0 : 0.0);
            m.put("maxGapMs", sessionMaxGapNs / 1_000_000.0);
            m.put("droppedFrames", (double) totalDropped);
            Map<String, Object> res = new HashMap<>();
            for (Map.Entry<String, Long> e : framesPerResolution.entrySet()) {
                res.put(e.getKey(), (double) e.getValue());
            }
            m.put("framesPerResolution", res);
            return m;
        }
    }
}
