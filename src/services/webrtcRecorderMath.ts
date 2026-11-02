/**
 * Pure timestamp/sync/segment-ordering helpers for the Android WebRTC recorder.
 * Mirrors `RecorderTiming.java` and provides JS-side validation & test coverage.
 */

export const NANOS_PER_SECOND = 1_000_000_000;
export const NANOS_PER_MICRO = 1_000;
export const MICROS_PER_SECOND = 1_000_000;

const SEGMENT_FILE_REGEX = /^segment_(\d+)\.mp4$/;

/**
 * Converts a frame timestamp (ns) to presentation timestamp (us) relative to `anchorNs`,
 * enforcing strict monotonicity (`ptsUs > lastPtsUs`).
 */
export function computeVideoPtsUs(
  frameTimestampNs: number,
  anchorNs: number,
  lastPtsUs: number = -1,
): number {
  let ptsUs = Math.max(0, Math.trunc((frameTimestampNs - anchorNs) / NANOS_PER_MICRO));
  if (lastPtsUs >= 0 && ptsUs <= lastPtsUs) {
    ptsUs = lastPtsUs + 1;
  }
  return ptsUs;
}

/**
 * Computes presentation timestamp (us) for an audio buffer starting `sampleOffset` samples
 * after `audioStartAnchorNs` (relative to `sessionAnchorNs`).
 */
export function computeAudioPtsUs(
  audioStartAnchorNs: number,
  sessionAnchorNs: number,
  sampleOffset: number,
  sampleRate: number,
  lastPtsUs: number = -1,
): number {
  const baseOffsetUs = Math.trunc((audioStartAnchorNs - sessionAnchorNs) / NANOS_PER_MICRO);
  const sampleDeltaUs =
    sampleRate > 0 ? Math.trunc((sampleOffset * MICROS_PER_SECOND) / sampleRate) : 0;
  let ptsUs = Math.max(0, baseOffsetUs + sampleDeltaUs);
  if (lastPtsUs >= 0 && ptsUs <= lastPtsUs) {
    ptsUs = lastPtsUs + 1;
  }
  return ptsUs;
}

/** Number of PCM-16 samples per channel in a byte buffer of `byteCount` bytes. */
export function pcm16SamplesPerChannel(byteCount: number, channels: number): number {
  const bytesPerFrame = Math.max(1, Math.trunc(channels)) * 2;
  return Math.max(0, Math.trunc(byteCount / bytesPerFrame));
}

/** True when the current segment has reached `segmentSeconds`. */
export function shouldRollSegment(
  segmentFirstPtsUs: number,
  currentPtsUs: number,
  segmentSeconds: number,
): boolean {
  if (segmentSeconds <= 0 || segmentFirstPtsUs < 0) return false;
  return currentPtsUs - segmentFirstPtsUs >= segmentSeconds * MICROS_PER_SECOND;
}

/** Formats segment file name `segment_0000.mp4`. */
export function formatSegmentFileName(index: number): string {
  return `segment_${String(Math.max(0, Math.trunc(index))).padStart(4, '0')}.mp4`;
}

/** Extracts numeric segment index, or -1 if not a finalized segment file name. */
export function parseSegmentIndex(fileName: string): number {
  const m = SEGMENT_FILE_REGEX.exec(fileName);
  if (!m) return -1;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : -1;
}

/**
 * Filters and sorts finalized segment file names (`segment_NNNN.mp4`) in ascending order,
 * ignoring `.tmp` files or unrelated names.
 */
export function sortFinalizedSegmentNames(fileNames: string[]): string[] {
  return fileNames
    .filter(name => parseSegmentIndex(name) >= 0)
    .slice()
    .sort((a, b) => parseSegmentIndex(a) - parseSegmentIndex(b));
}
