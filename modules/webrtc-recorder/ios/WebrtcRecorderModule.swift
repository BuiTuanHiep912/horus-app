import ExpoModulesCore

/// iOS side of the local `webrtc-recorder` Expo module.
///
/// M0 (this file): registers the `WRFrameProbe` frame tap in react-native-webrtc's
/// `ProcessorProvider` and reports per-second frame stats through `onStats`, with the same
/// JS API as the Android module. The recorder API (`start`/`stop`) lands in M1+.
public class WebrtcRecorderModule: Module {
  private let tickerQueue = DispatchQueue(label: "webrtc-recorder.ticker")
  private var ticker: DispatchSourceTimer?
  private let lock = NSLock()
  private var activeRecorder: WRTrackRecorder?

  /// Accepts a `file://` URI (what expo-file-system hands out) or a plain path.
  private static func resolveOutputDir(_ raw: String?) throws -> URL {
    let trimmed = raw?.trimmingCharacters(in: .whitespaces) ?? ""
    let dir: URL
    if trimmed.isEmpty {
      dir = FileManager.default.temporaryDirectory.appendingPathComponent("webrtc-rec")
    } else if let url = URL(string: trimmed), url.isFileURL {
      dir = url
    } else {
      dir = URL(fileURLWithPath: trimmed)
    }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  public func definition() -> ModuleDefinition {
    Name("WebrtcRecorder")

    Events("onStats", "onError")

    OnCreate {
      WRFrameProbe.registerProcessor()
    }

    OnDestroy {
      self.stopTicker()
      self.lock.lock()
      let recorder = self.activeRecorder
      self.activeRecorder = nil
      self.lock.unlock()
      if let recorder = recorder {
        WRFrameProbe.setActiveRecorder(nil)
        recorder.stop { _, _ in }
      }
    }

    Function("getProcessorName") { () -> String in
      WRFrameProbe.registerProcessor()
      return WRFrameProbe.processorName()
    }

    // iOS taps frames before WebRTC's adaptation (capturer -> processor -> RTCVideoSource),
    // so raw frames are always on and no patch is involved.
    Function("isRawFramePatchApplied") { () -> Bool in true }

    // True when WRAudioDevice was installed as react-native-webrtc's audio device (+load).
    Function("isAudioTapWired") { () -> Bool in WRAudioDevice.isInstalled() }

    Function("setRawFrameMode") { (_: Bool) -> Bool in true }

    Function("probeStart") { () -> String in
      WRFrameProbe.registerProcessor()
      WRFrameProbe.reset()
      self.startTicker()
      return WRFrameProbe.processorName()
    }

    Function("probeStop") { () -> [String: Any] in
      self.stopTicker()
      let summary = WRFrameProbe.summary()
      NSLog("[WebrtcRecorder] probe summary %@", summary)
      return summary
    }

    // M1 recorder API (video only):
    // start(opts: { trackId, outputDir, width, height, fps, videoBitrate, audioBitrate?, segmentSeconds? })
    //   -> { recordingId, processorName }
    // The encoder size follows the first tapped frame; width/height/audio/segments are ignored for now.
    AsyncFunction("start") { (opts: [String: Any], promise: Promise) in
      self.lock.lock()
      defer { self.lock.unlock() }
      if self.activeRecorder != nil {
        promise.reject("ERR_ALREADY_RECORDING", "A WebRTC track recording is already in progress")
        return
      }
      let outputDir: URL
      do {
        outputDir = try Self.resolveOutputDir(opts["outputDir"] as? String)
      } catch {
        promise.reject("ERR_OUTPUT_DIR", "Cannot create output dir: \(error.localizedDescription)")
        return
      }
      let recordingId = UUID().uuidString
      let fileURL = outputDir.appendingPathComponent("rec_\(Int(Date().timeIntervalSince1970 * 1000)).mp4")
      let fps = (opts["fps"] as? NSNumber)?.intValue ?? 30
      let bitrate = (opts["videoBitrate"] as? NSNumber)?.intValue ?? 6_000_000
      let audioBitrate = (opts["audioBitrate"] as? NSNumber)?.intValue ?? 128_000
      let segmentSeconds = (opts["segmentSeconds"] as? NSNumber)?.intValue ?? 20

      WRFrameProbe.registerProcessor()
      let recorder = WRTrackRecorder(
        recordingId: recordingId, outputURL: fileURL, fps: fps, videoBitrate: bitrate,
        audioBitrate: audioBitrate, segmentSeconds: segmentSeconds)
      self.activeRecorder = recorder
      WRFrameProbe.setActiveRecorder(recorder)
      NSLog("[WebrtcRecorder] start %@ -> %@", recordingId, fileURL.path)
      promise.resolve(["recordingId": recordingId, "processorName": WRFrameProbe.processorName()])
    }

    AsyncFunction("stop") { (recordingId: String, promise: Promise) in
      self.lock.lock()
      guard let recorder = self.activeRecorder, recorder.recordingId == recordingId else {
        self.lock.unlock()
        promise.reject("ERR_NOT_RECORDING", "No active recording with id \(recordingId)")
        return
      }
      self.activeRecorder = nil
      WRFrameProbe.setActiveRecorder(nil)
      self.lock.unlock()

      recorder.stop { result, error in
        if let result = result {
          promise.resolve(result)
        } else {
          let message = error?.localizedDescription ?? "unknown error"
          self.sendEvent("onError", ["recordingId": recordingId, "message": message])
          promise.reject("ERR_STOP_FAILED", message)
        }
      }
    }

    // Stitches leftover `rec_*` segment folders (app killed mid-recording) into
    // `recovered_rec_*.mp4` files; the folder of a recording in progress is skipped.
    AsyncFunction("recoverOrphanedRecordings") { (rawDir: String, promise: Promise) in
      let dir: URL
      do {
        dir = try Self.resolveOutputDir(rawDir)
      } catch {
        promise.resolve([[String: Any]]())
        return
      }
      self.lock.lock()
      let active = self.activeRecorder?.sessionDirectory
      self.lock.unlock()
      WRStitcher.recover(inDirectory: dir, excluding: active) { results in
        promise.resolve(results)
      }
    }
  }

  private func startTicker() {
    tickerQueue.sync {
      ticker?.cancel()
      let timer = DispatchSource.makeTimerSource(queue: tickerQueue)
      timer.schedule(deadline: .now() + 1, repeating: 1)
      timer.setEventHandler { [weak self] in
        self?.sendEvent("onStats", WRFrameProbe.tick())
      }
      ticker = timer
      timer.resume()
    }
  }

  private func stopTicker() {
    tickerQueue.sync {
      ticker?.cancel()
      ticker = nil
    }
  }
}
