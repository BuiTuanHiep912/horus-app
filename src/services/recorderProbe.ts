/**
 * M0 experiment harness (feat/android-recorder) — throwaway; delete once M0 is decided.
 * Attaches the native probe processor to the local video track and logs, once per second,
 * what the frame tap receives next to what the WebRTC sender actually sends.
 */
import { Platform } from 'react-native';
import { WebrtcRecorder, type ProbeStats } from '../../modules/webrtc-recorder';
import { RECORDER_PROBE_VARIANT } from '../constants/recorderProbe';
import { logger } from '../utils/logger';

const variant = RECORDER_PROBE_VARIANT;

export const PROBE_ENCODINGS = [{ maxBitrate: 150_000, scaleResolutionDownBy: 4 }];

export function isProbeActive(): boolean {
  return Platform.OS === 'android' && variant !== 'off' && WebrtcRecorder != null;
}

export function probeVideoConstraints(facingMode: string) {
  return { facingMode, width: 1920, height: 1080, frameRate: 30 };
}

let processorName: string | null = null;
let subscription: { remove(): void } | null = null;
let lastBytes = 0;
let lastBytesAt = 0;

export function startProbe(videoTrack: any, getProducer: () => any): void {
  if (!isProbeActive() || !WebrtcRecorder || !videoTrack) return;
  stopProbe();
  const wantRaw = variant.startsWith('patched');
  const patchApplied = WebrtcRecorder.isRawFramePatchApplied();
  const raw = WebrtcRecorder.setRawFrameMode(wantRaw);
  if (wantRaw && !raw) {
    logger.warn('[probe] raw-frame patch NOT applied (npm install runs patch-package) — rebuild');
  }
  processorName = WebrtcRecorder.probeStart();
  attachProbe(videoTrack);
  lastBytes = 0;
  lastBytesAt = 0;
  subscription = WebrtcRecorder.addListener('onStats', s => {
    void logTick(s, getProducer());
  });
  logger.info('[probe] started', {
    variant,
    patchApplied,
    raw,
    settings: videoTrack.getSettings?.(),
  });
}

/** Also called after a camera flip: the new track has no processor yet. */
export function attachProbe(videoTrack: any): void {
  if (!processorName || !videoTrack) return;
  // Private react-native-webrtc API (MediaStreamTrack._setVideoEffects); version is pinned.
  videoTrack._setVideoEffects([processorName]);
}

export async function applyProbeSenderParams(producer: any): Promise<void> {
  if (!isProbeActive() || !variant.endsWith('maintain-resolution')) return;
  const sender = producer?.rtpSender;
  if (!sender) {
    logger.warn('[probe] no rtpSender — cannot set degradationPreference');
    return;
  }
  try {
    const params = sender.getParameters();
    params.degradationPreference = 'maintain-resolution';
    await sender.setParameters(params);
    logger.info('[probe] degradationPreference=' + sender.getParameters().degradationPreference);
  } catch (e) {
    logger.warn('[probe] setParameters failed', e);
  }
}

export function stopProbe(): void {
  if (!processorName || !WebrtcRecorder) return;
  subscription?.remove();
  subscription = null;
  processorName = null;
  const summary = WebrtcRecorder.probeStop();
  WebrtcRecorder.setRawFrameMode(false);
  logger.info('[probe] summary ' + JSON.stringify({ variant, ...summary }));
}

async function logTick(s: ProbeStats, producer: any): Promise<void> {
  let send = 'n/a';
  try {
    const report = await producer?.getStats();
    report?.forEach((r: any) => {
      if (r.type !== 'outbound-rtp' || (r.kind ?? r.mediaType) !== 'video') return;
      const now = Date.now();
      const kbps =
        lastBytesAt > 0 ? Math.round(((r.bytesSent - lastBytes) * 8) / (now - lastBytesAt)) : 0;
      lastBytes = r.bytesSent;
      lastBytesAt = now;
      send =
        `${r.frameWidth}x${r.frameHeight}@${r.framesPerSecond ?? '?'} ${kbps}kbps ` +
        `qlr=${r.qualityLimitationReason ?? '?'}`;
    });
  } catch {
    // stats are best-effort
  }
  logger.info(
    `[probe] tap ${s.width}x${s.height} rot=${s.rotation} fps=${s.fps} ` +
      `maxGap=${Math.round(s.maxGapMs)}ms raw=${s.rawFrames} | send ${send}`,
  );
}
