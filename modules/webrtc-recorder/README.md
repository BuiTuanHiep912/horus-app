# webrtc-recorder (Android, local Expo module)

Records the `react-native-webrtc` camera + mic capture to a full-quality local MP4 from raw capture
frames while the same `getUserMedia` stream feeds the mediasoup live preview at low bitrate.
Plan: `docs/android-recorder-module-plan.md`.

## Architecture (M0–M4)

1. **Raw video frame tap (`ProbeFrameProcessor.java` + `patches/react-native-webrtc+124.0.8.patch`)**:
   Registers `webrtcRecorderProbe` in `ProcessorProvider`. When `VideoEffectProcessor.processRawFrames`
   is enabled, the processor receives the unadapted camera `VideoFrame` before WebRTC's
   `FrameAdaptationParameters` downscale/drop is applied for the preview sender.
2. **Surface H.264 encoder (`Mp4TrackRecorder.java`)**:
   Renders each `VideoFrame` into a `MediaCodec` (`video/avc`) input `Surface` on a dedicated
   `HandlerThread` using `EglBase.create(EglUtils.getRootEglBaseContext(), EglBase.CONFIG_RECORDABLE)`
   + `VideoFrameDrawer` + `GlRectDrawer`. Never blocks the camera capture thread (drops & counts
   frames if the encoder lags). Applies `VideoFrame.getRotation()` via `MediaMuxer.setOrientationHint`.
3. **Audio tap + AAC encoder (`WebrtcRecorderPackage.java`, `WebrtcRecorderLifecycleListener.java`, `AudioSampleDispatcher.java`)**:
   Installs `JavaAudioDeviceModule.builder(ctx).setSamplesReadyCallback(...)` on
   `WebRTCModuleOptions.getInstance().audioDeviceModule` during `Application.onCreate` (before
   `WebRTCModule` is instantiated). Encodes 16-bit PCM to AAC-LC (`audio/mp4a-latm`) anchored to the
   same monotonic clock origin as video (`RecorderTiming.java`).
4. **Rolling segments + lossless stitcher + crash recovery (`SegmentStitcher.java`)**:
   Writes rolling `segment_NNNN.mp4` files (default 20 s) so an app kill loses at most the active
   tail. On `stop()`, losslessly remuxes all finalized segments via `MediaExtractor` + `MediaMuxer`
   into a single MP4. Leftover `rec_*` folders from a crash are stitched into `recovered_*.mp4` on
   next launch (`recoverOrphanedRecordings`).
5. **RemoteScreen & StreamingService integration (M4)**:
   Controlled by `USE_WEBRTC_RECORDER_ON_ANDROID` in `src/constants/config.ts` (default `true`).
   Captures 1080p30, produces preview at ~300 kbps (`scaleResolutionDownBy: 2`), records full
   1080p30 @ 6 Mbps without stopping the live preview, and uploads via `streamingService.uploadRecording`.
   Set `USE_WEBRTC_RECORDER_ON_ANDROID = false` to fall back to the `expo-camera` path.
