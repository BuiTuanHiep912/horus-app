/**
 * Android-only local Expo module that records a react-native-webrtc camera track to MP4
 * from raw capture frames while the same track feeds the mediasoup live preview.
 * On iOS/web or in a build without the native module, `WebrtcRecorder` is null and
 * `start`/`stop` reject with an unsupported-platform error.
 */
import { requireOptionalNativeModule, type NativeModule } from 'expo';

export type StartRecordingOptions = {
  trackId: string;
  outputDir: string;
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  audioBitrate?: number;
  segmentSeconds?: number;
};

export type StartRecordingResult = {
  recordingId: string;
  processorName?: string;
};

export type StopRecordingResult = {
  uri: string;
  durationMs: number;
  size: number;
};

export type RecorderStats = {
  fps: number;
  width: number;
  height: number;
  rotation: number;
  maxGapMs: number;
  droppedFrames: number;
  totalFrames: number;
  rawFrames: boolean;
};

export type ProbeStats = RecorderStats;

export type ProbeSummary = {
  durationMs: number;
  totalFrames: number;
  avgFps: number;
  maxGapMs: number;
  droppedFrames: number;
  framesPerResolution: Record<string, number>;
  rawFrames: boolean;
};

type Events = {
  onStats: (s: RecorderStats) => void;
  onError: (e: { recordingId?: string; message: string }) => void;
};

declare class WebrtcRecorderNative extends NativeModule<Events> {
  getProcessorName(): string;
  isRawFramePatchApplied(): boolean;
  isAudioTapWired(): boolean;
  setRawFrameMode(enabled: boolean): boolean;
  /** M0 probe helpers */
  probeStart(): string;
  probeStop(): ProbeSummary;
  /** M1–M3 recorder API */
  start(opts: StartRecordingOptions): Promise<StartRecordingResult>;
  stop(recordingId: string): Promise<StopRecordingResult>;
  recoverOrphanedRecordings(outputDir: string): Promise<StopRecordingResult[]>;
}

export const WebrtcRecorder = requireOptionalNativeModule<WebrtcRecorderNative>('WebrtcRecorder');

export function isWebrtcRecorderSupported(): boolean {
  return WebrtcRecorder != null;
}

export async function start(opts: StartRecordingOptions): Promise<StartRecordingResult> {
  if (!WebrtcRecorder) {
    throw new Error('WebrtcRecorder is only supported on Android dev-client builds');
  }
  return WebrtcRecorder.start(opts);
}

export async function stop(recordingId: string): Promise<StopRecordingResult> {
  if (!WebrtcRecorder) {
    throw new Error('WebrtcRecorder is only supported on Android dev-client builds');
  }
  return WebrtcRecorder.stop(recordingId);
}

export async function recoverOrphanedRecordings(outputDir: string): Promise<StopRecordingResult[]> {
  if (!WebrtcRecorder) {
    return [];
  }
  return WebrtcRecorder.recoverOrphanedRecordings(outputDir);
}
