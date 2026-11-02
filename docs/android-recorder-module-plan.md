# Handoff: Android module that records a WebRTC track to MP4

Audience: an agent (recommended: Opus for the native work, Sonnet for the JS integration) taking over from the session that produced commits `2cd8356` (horus-app) and `4fc9148` (multicam-server). Android only. iOS is out of scope.

## 1. Goal

One `getUserMedia` capture (camera + mic) must feed **both**:
- the existing mediasoup producers (`src/services/mediasoupClient.ts`) as a **low-bitrate live preview**, and
- a **local full-quality MP4** recorded from the raw frames, uploaded after `stop_record`.

This removes the camera conflict between `expo-camera` `recordAsync` and WebRTC `getUserMedia`. Today the app works around it with an `interim:` block in `src/screens/RemoteScreen.tsx` (~line 256): preview pauses while recording. The module replaces that.

## 2. Decisions already made (do not reopen)

- WebRTC is preview only. The phone's local file is the source of truth, uploaded as one file after stop (presigned PUT, already implemented in `src/services/upload.ts`; contract in `E:\GitHub\multicam-server\API.md`).
- The server does not record anymore (recorder deleted). No server work is needed for this task.
- Android only. Full quality means the recorder gets raw capture frames, not the WebRTC-encoded stream.
- No new fork of `react-native-webrtc`. Stay on stock 124.x and use its frame-processor hook.

## 3. Findings you can rely on (from a read-only research pass; verify against installed source)

- `react-native-webrtc` has no MediaRecorder; maintainer says it cannot be added (issues #1761, #1620, #1552). No maintained library records a track (checked LiveKit, Stream, Fishjam forks; none has a recorder).
- Frame tap exists in stock source: `node_modules/react-native-webrtc/android/src/main/java/com/oney/WebRTCModule/videoEffects/` has `ProcessorProvider.java`, `VideoFrameProcessor.java`, `VideoEffectProcessor.java`, `VideoFrameProcessorFactoryInterface.java`. Register with `ProcessorProvider.addProcessor(name, factory)`; enable from JS with `track._setVideoEffects([name])` (private API, `src/MediaStreamTrack.ts` ~line 154). The registry is static, so the module does not need the `WebRTCModule` instance.
- **Catch:** in WebRTC M124 `VideoSource.adaptFrame()` runs before the processor, so frames may already be downscaled or dropped when the preview bitrate is low. `VideoEffectProcessor` overrides only the one-argument `onFrameCaptured`. Planned fix: a ~10-line `patch-package` patch so `onFrameCaptured(frame, FrameAdaptationParameters)` hands processors the raw frame. Prove this is needed in M0 before patching.
- Audio has no tap on stock. Plan: set `WebRTCModuleOptions.getInstance().audioDeviceModule = JavaAudioDeviceModule.builder(ctx).setSamplesReadyCallback(...)` from an Expo `ApplicationLifecycleListener.onCreate`, before `WebRTCModule` is created (`WebRTCModule.java` ~line 70). Encode the PCM to AAC.
- `WebRTCModule.getTrack`, `getLocalTrack` and `GetUserMediaImpl` are package-private; the processor tap avoids needing them. `createVideoSource` is only called internally (`GetUserMediaImpl.java` ~line 463), so external frame injection is not possible without a fork (not needed here).
- Project state: Expo 54, `expo-dev-client`, `react-native-webrtc ^124.0.5`, `mediasoup-client`, no `modules/` directory, no `patch-package` yet, no `android/` folder (prebuild at build time). New Architecture status is unverified (SDK 54 defaults to on; confirm in the built app).
- Effort estimate from the research (rough): Android minimal video+audio 4-6 days, hardening 3-5 days.

## 4. Design

Local Expo module `modules/webrtc-recorder` (Expo Modules API, autolinked), Android only; a JS stub throws/returns unsupported on iOS.

JS API (keep tiny):
```ts
start(opts: { trackId: string; outputDir: string; width: number; height: number;
              fps: number; videoBitrate: number; audioBitrate?: number;
              segmentSeconds?: number }): Promise<{ recordingId: string }>
stop(recordingId: string): Promise<{ uri: string; durationMs: number; size: number }>
// events: onError, onStats ({ fps, width, height, droppedFrames }) once per second
```

Native pieces:
1. **Video tap:** a `VideoFrameProcessor` registered under a fixed name. On each `VideoFrame`, if recording, draw the texture into the `MediaCodec` input `Surface` using the shared EGL context (`EglUtils.getRootEglBaseContext()`); return the frame unchanged to WebRTC. Never block the capture thread: drop frames when the encoder lags and count drops.
2. **Encoder:** H.264 `MediaCodec` (surface input), bitrate from opts, rotation from `VideoFrame.getRotation` applied via muxer orientation hint.
3. **Audio:** samples-ready callback -> AAC `MediaCodec` -> muxer. Timestamps: video from frame `timestampNs`, audio from a monotonic clock anchored to the same origin; verify sync by ear/clap test.
4. **Muxing and crash safety:** `MediaMuxer` MP4. Plain MP4 loses its index if the app dies, so write rolling segments (default 20 s), finalize each, and on `stop` stitch them with a lossless remux (`MediaExtractor` + `MediaMuxer`, no re-encode) into one file. On next app launch, recover or stitch leftover segment folders. Check whether fragmented MP4 output is available on the target API levels before building the stitcher (unverified).
5. **Resolution change** (camera flip): start a new segment with a new encoder; the stitcher must handle differing sizes or restrict flip while recording (acceptable to block flip, say so in the UI).

## 5. Milestones (stop and report after each; do not continue past a failed gate)

**M0 - Experiment (half day, needs a real Android phone).** Throwaway module that registers a probe processor and logs resolution + fps each second. Capture 1080p30, produce with `maxBitrate: 150000, scaleResolutionDownBy: 4`, throttle the network. Compare: as-is; with the patch-package; with `degradationPreference: 'maintain-resolution'` via `sender.setParameters`. **Gate:** steady ~1920x1080 at ~30 fps for 5 minutes while the remote preview keeps working. If it fails even with the patch, stop and report; the fallback is the Fishjam fork or VisionCamera (separate plan).

**M1 - Video-only file.** Single-file recording from the tap, played back in a player. Gate: correct orientation, ~30 fps, no multi-second freezes, phone temperature acceptable after 5 min.

**M2 - Audio + sync.** Gate: lip/clap sync within ~100 ms over 3 min; no drift.

**M3 - Segments, stitch, crash recovery.** Gate: kill the app mid-recording; on relaunch the file up to the last segment is recoverable and plays; normal stop yields one playable MP4.

**M4 - Integration.** Replace the `interim:` block in `RemoteScreen.tsx`:
- `getUserMedia` at 1080p30 in `mediasoupClient.ts` (today it asks 720p with 640p fallback, ~lines 106-125), produce with low `encodings` (e.g. `maxBitrate` ~300 kbps, `scaleResolutionDownBy`) at ~line 197.
- `start_record` -> module `start`; `stop_record` -> module `stop` -> existing `streamingService.uploadRecording(uri, onProgress)` (`src/services/streaming.ts` ~line 126). Keep preview running throughout.
- Keep the expo-camera path behind a flag as fallback until the module is proven on devices; remove the `interim:` pause logic and the `CameraView`-unmount workaround only after M3 passes.
- `// shortcut:` comment anything deferred.

## 6. Guardrails

- Work on a branch `feat/android-recorder`; small commits; do not push or run EAS builds without asking the user. The user performs device builds and tests; you write code, run `npx tsc --noEmit` and `npm test`, and compile the Android module if an Android SDK/Gradle is available (state clearly if not).
- Keep the diff minimal; new dependencies only `patch-package` (and its postinstall) unless a gate fails.
- Add tests only for pure logic (e.g. segment stitching order, timestamp math); native behavior is verified on device.
- Report honestly what was not run on a device.

## 7. Known unknowns

- Whether the processor keeps receiving full-resolution frames under a low-bitrate sender (M0 answers this).
- Whether two encoders (recorder + WebRTC) overheat mid-range phones during long sessions.
- New Architecture compatibility of the module and of `react-native-webrtc` 124 in this app (expo-doctor already warns it is untested).
- `_setVideoEffects` is a private API and may break on `react-native-webrtc` upgrades; pin the version.
- Fragmented-MP4 availability per API level.

## 8. Related, not part of this task

- Phase 3 VM deploy (host Caddy, `docker compose up -d --build`, firewall for UDP/TCP 40100-40199) is unstarted.
- Remaining client gaps: 60 s clip cap ignores `max_duration`, manual retry from Files loses the session link, `RemoteScreen.tsx` is still ~1.2k lines.
