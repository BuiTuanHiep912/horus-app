/**
 * M0 experiment (feat/android-recorder) — diagnostic probe switch.
 *
 * Default `'off'` so production / M4 uses the integrated WebRTC track recorder.
 * Set to `'as-is' | 'patched' | 'maintain-resolution' | 'patched+maintain-resolution'`
 * and reload JS (`r` in Metro) to run the M0 standalone probe harness.
 */
export type RecorderProbeVariant =
  'off' | 'as-is' | 'patched' | 'maintain-resolution' | 'patched+maintain-resolution';

export const RECORDER_PROBE_VARIANT = 'off' as RecorderProbeVariant;
