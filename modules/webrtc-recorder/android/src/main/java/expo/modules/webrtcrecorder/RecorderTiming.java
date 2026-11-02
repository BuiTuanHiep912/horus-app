package expo.modules.webrtcrecorder;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure timestamp/sync/segment-ordering helpers. No Android framework imports so this class
 * compiles and can be tested under plain JVM.
 */
final class RecorderTiming {
    static final long NANOS_PER_SECOND = 1_000_000_000L;
    static final long NANOS_PER_MICRO = 1_000L;
    static final long MICROS_PER_SECOND = 1_000_000L;
    /** Default AAC frame length (1024 samples per frame). */
    static final int AAC_SAMPLES_PER_FRAME = 1024;

    private static final Pattern SEGMENT_NAME = Pattern.compile("^segment_(\\d+)\\.mp4$");

    private RecorderTiming() {}

    /**
     * Converts a frame timestamp in nanoseconds to presentation time in microseconds relative to
     * {@code anchorNs}, enforcing strict monotonicity (MediaMuxer rejects non-increasing PTS on
     * some devices).
     */
    static long videoPtsUs(long frameTimestampNs, long anchorNs, long lastPtsUs) {
        long ptsUs = Math.max(0L, (frameTimestampNs - anchorNs) / NANOS_PER_MICRO);
        if (lastPtsUs >= 0 && ptsUs <= lastPtsUs) {
            ptsUs = lastPtsUs + 1L;
        }
        return ptsUs;
    }

    /**
     * Computes presentation time in microseconds for an audio buffer starting {@code sampleOffset}
     * samples after {@code audioStartAnchorNs} (relative to {@code sessionAnchorNs}).
     */
    static long audioPtsUs(
            long audioStartAnchorNs,
            long sessionAnchorNs,
            long sampleOffset,
            int sampleRate,
            long lastPtsUs) {
        long baseOffsetUs = (audioStartAnchorNs - sessionAnchorNs) / NANOS_PER_MICRO;
        long sampleDeltaUs =
                sampleRate > 0 ? (sampleOffset * MICROS_PER_SECOND) / sampleRate : 0L;
        long ptsUs = Math.max(0L, baseOffsetUs + sampleDeltaUs);
        if (lastPtsUs >= 0 && ptsUs <= lastPtsUs) {
            ptsUs = lastPtsUs + 1L;
        }
        return ptsUs;
    }

    /** Number of PCM-16 samples in a byte buffer of {@code byteCount} bytes with {@code channels}. */
    static int pcm16SamplesPerChannel(int byteCount, int channels) {
        int bytesPerFrame = Math.max(1, channels) * 2;
        return Math.max(0, byteCount / bytesPerFrame);
    }

    /** True when the current segment has reached {@code segmentDurationUs}. */
    static boolean shouldRollSegment(long segmentFirstPtsUs, long currentPtsUs, int segmentSeconds) {
        if (segmentSeconds <= 0 || segmentFirstPtsUs < 0) return false;
        long segmentDurationUs = (long) segmentSeconds * MICROS_PER_SECOND;
        return (currentPtsUs - segmentFirstPtsUs) >= segmentDurationUs;
    }

    /** Formats segment file name `segment_0000.mp4`. */
    static String segmentFileName(int index) {
        return String.format(java.util.Locale.US, "segment_%04d.mp4", index);
    }

    /** Extracts numeric segment index, or -1 if not a finalized segment file. */
    static int parseSegmentIndex(String name) {
        if (name == null) return -1;
        Matcher m = SEGMENT_NAME.matcher(name);
        if (!m.matches()) return -1;
        try {
            return Integer.parseInt(m.group(1));
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /**
     * Lists finalized, non-empty `segment_NNNN.mp4` files inside {@code dir} sorted by segment
     * index ascending. In-progress `.tmp` files and 0-byte files are ignored.
     */
    static List<File> listFinalizedSegments(File dir) {
        if (dir == null || !dir.isDirectory()) return Collections.emptyList();
        File[] files = dir.listFiles();
        if (files == null || files.length == 0) return Collections.emptyList();
        List<File> out = new ArrayList<>();
        for (File f : files) {
            if (f.isFile() && f.length() > 0 && parseSegmentIndex(f.getName()) >= 0) {
                out.add(f);
            }
        }
        Collections.sort(
                out,
                new Comparator<File>() {
                    @Override
                    public int compare(File a, File b) {
                        return Integer.compare(
                                parseSegmentIndex(a.getName()), parseSegmentIndex(b.getName()));
                    }
                });
        return out;
    }
}
