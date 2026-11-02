import {
  computeAudioPtsUs,
  computeVideoPtsUs,
  formatSegmentFileName,
  parseSegmentIndex,
  pcm16SamplesPerChannel,
  shouldRollSegment,
  sortFinalizedSegmentNames,
} from './webrtcRecorderMath';

describe('webrtcRecorderMath', () => {
  describe('computeVideoPtsUs', () => {
    it('computes presentation timestamp relative to anchorNs and enforces strict monotonicity', () => {
      const anchor = 10_000_000_000;
      const pts0 = computeVideoPtsUs(anchor, anchor, -1);
      expect(pts0).toBe(0);

      // 33.333 ms later
      const pts1 = computeVideoPtsUs(anchor + 33_333_000, anchor, pts0);
      expect(pts1).toBe(33_333);

      // Out-of-order or duplicate timestamp gets bumped by +1 us
      const ptsDup = computeVideoPtsUs(anchor + 33_333_000, anchor, pts1);
      expect(ptsDup).toBe(33_334);
    });
  });

  describe('computeAudioPtsUs & pcm16SamplesPerChannel', () => {
    it('keeps audio timestamps drift-free against video anchor over 3 minutes at 48 kHz', () => {
      const sessionAnchorNs = 1_000_000_000;
      const audioStartNs = sessionAnchorNs + 10_000_000; // audio starts 10 ms after first video frame
      const sampleRate = 48_000;
      const chunkBytes = 960; // 10 ms mono PCM16 = 480 samples
      const samplesPerChunk = pcm16SamplesPerChannel(chunkBytes, 1);
      expect(samplesPerChunk).toBe(480);

      let totalSamples = 0;
      let lastPtsUs = -1;
      // 3 minutes = 18,000 chunks of 10 ms
      for (let i = 0; i < 18_000; i++) {
        lastPtsUs = computeAudioPtsUs(
          audioStartNs,
          sessionAnchorNs,
          totalSamples,
          sampleRate,
          lastPtsUs,
        );
        totalSamples += samplesPerChunk;
      }

      // After 17,999 chunks (179.99 s) + 10 ms initial offset = 180,000,000 us
      expect(lastPtsUs).toBe(180_000_000);
    });
  });

  describe('shouldRollSegment & segment ordering', () => {
    it('triggers segment roll at segmentSeconds boundary', () => {
      expect(shouldRollSegment(0, 19_999_999, 20)).toBe(false);
      expect(shouldRollSegment(0, 20_000_000, 20)).toBe(true);
      expect(shouldRollSegment(20_000_000, 39_500_000, 20)).toBe(false);
      expect(shouldRollSegment(20_000_000, 40_000_000, 20)).toBe(true);
    });

    it('filters out unfinalized .tmp files and sorts segments numerically', () => {
      const names = [
        'segment_0002.mp4',
        'segment_0000.mp4',
        'segment_0003.mp4.tmp',
        'segment_0010.mp4',
        'segment_0001.mp4',
        'notes.txt',
      ];
      expect(sortFinalizedSegmentNames(names)).toEqual([
        formatSegmentFileName(0),
        formatSegmentFileName(1),
        formatSegmentFileName(2),
        formatSegmentFileName(10),
      ]);
      expect(parseSegmentIndex('segment_0003.mp4.tmp')).toBe(-1);
    });
  });
});
