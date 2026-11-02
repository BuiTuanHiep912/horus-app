package expo.modules.webrtcrecorder

import android.util.Log
import com.oney.WebRTCModule.videoEffects.ProcessorProvider
import com.oney.WebRTCModule.videoEffects.VideoFrameProcessorFactoryInterface
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

private const val TAG = "WebrtcRecorder"

/**
 * Android WebRTC track recorder module (M0–M4):
 * - Registers a `VideoFrameProcessor` tap (`webrtcRecorderProbe`) in `react-native-webrtc`'s
 *   static `ProcessorProvider` registry and switches on the raw-frame patch so the recorder receives
 *   unadapted camera frames while WebRTC encodes a low-bitrate preview.
 * - Encodes video (H.264 surface input) + audio (`JavaAudioDeviceModule` `SamplesReadyCallback` ->
 *   AAC) into rolling MP4 segments and losslessly stitches them into one file on `stop()`.
 * - Recovers leftover segment folders on launch or via `recoverOrphanedRecordings`.
 */
class WebrtcRecorderModule : Module() {
  private val stats = FrameStats()
  private val worker = Executors.newSingleThreadExecutor()
  private var ticker: ScheduledExecutorService? = null
  @Volatile private var activeRecorder: Mp4TrackRecorder? = null

  override fun definition() = ModuleDefinition {
    Name("WebrtcRecorder")

    Events("onStats", "onError")

    OnCreate {
      registerProcessor()
      appContext.reactContext?.let { ctx ->
        WebrtcRecorderLifecycleListener.installAudioTapIfNeeded(ctx)
      }
    }

    OnDestroy {
      stopTicker()
      val rec = activeRecorder
      if (rec != null) {
        activeRecorder = null
        ProbeFrameProcessor.setActiveRecorder(null)
        worker.execute {
          try {
            rec.stop()
          } catch (t: Throwable) {
            Log.w(TAG, "Stop on destroy failed", t)
          }
        }
      }
    }

    Function("getProcessorName") {
      registerProcessor()
      ProbeFrameProcessor.PROCESSOR_NAME
    }

    Function("isRawFramePatchApplied") { ProbeFrameProcessor.isRawPatchApplied() }

    Function("isAudioTapWired") { AudioSampleDispatcher.INSTANCE.isCallbackWired }

    // Returns the mode now in effect (false when the patch is not applied).
    Function("setRawFrameMode") { enabled: Boolean -> ProbeFrameProcessor.setRawFrames(enabled) }

    // M0 probe helpers (kept for diagnostics).
    Function("probeStart") {
      registerProcessor()
      stats.reset()
      startTicker()
      ProbeFrameProcessor.PROCESSOR_NAME
    }

    Function("probeStop") {
      if (activeRecorder == null) {
        stopTicker()
      }
      val summary = stats.summary()
      summary["rawFrames"] = ProbeFrameProcessor.getRawFrames()
      Log.i(TAG, "probe summary $summary")
      summary
    }

    // M1–M3 recorder API:
    // start(opts: { trackId, outputDir, width, height, fps, videoBitrate, audioBitrate?, segmentSeconds? })
    //   -> Promise<{ recordingId: string, processorName: string }>
    AsyncFunction("start") { opts: Map<String, Any?>, promise: Promise ->
      worker.execute {
        try {
          if (activeRecorder != null) {
            promise.reject("ERR_ALREADY_RECORDING", "A WebRTC track recording is already in progress", null)
            return@execute
          }
          registerProcessor()
          // Always enable raw-frame mode when recording so low preview bitrates do not downscale
          // the recorded MP4.
          ProbeFrameProcessor.setRawFrames(true)

          val trackId = (opts["trackId"] as? String)?.trim().orEmpty()
          val rawDir = (opts["outputDir"] as? String)?.trim().orEmpty()
          val outputDir = resolveOutputDir(rawDir)

          // Best-effort crash recovery of any previous unfinished session in the same directory.
          try {
            SegmentStitcher.recoverLeftoverSessions(outputDir)
          } catch (t: Throwable) {
            Log.w(TAG, "recoverLeftoverSessions on start failed", t)
          }

          val width = (opts["width"] as? Number)?.toInt() ?: 1920
          val height = (opts["height"] as? Number)?.toInt() ?: 1080
          val fps = (opts["fps"] as? Number)?.toInt() ?: 30
          val videoBitrate = (opts["videoBitrate"] as? Number)?.toInt() ?: 6_000_000
          val audioBitrate = (opts["audioBitrate"] as? Number)?.toInt() ?: 128_000
          val segmentSeconds = (opts["segmentSeconds"] as? Number)?.toInt() ?: 20

          val recordingId =
            "${System.currentTimeMillis()}_${UUID.randomUUID().toString().substring(0, 6)}"
          val cfg =
            Mp4TrackRecorder.Config(
              recordingId,
              trackId,
              outputDir,
              width,
              height,
              fps,
              videoBitrate,
              audioBitrate,
              segmentSeconds,
            )

          stats.reset()
          val recorder =
            Mp4TrackRecorder(cfg, stats) { recId, message ->
              sendEvent("onError", mapOf("recordingId" to recId, "message" to message))
            }
          recorder.start()
          activeRecorder = recorder
          ProbeFrameProcessor.setActiveRecorder(recorder)
          startTicker()

          promise.resolve(
            mapOf(
              "recordingId" to recordingId,
              "processorName" to ProbeFrameProcessor.PROCESSOR_NAME,
            ),
          )
        } catch (t: Throwable) {
          Log.e(TAG, "Failed to start recording", t)
          promise.reject("ERR_START_FAILED", t.message ?: "Failed to start recording", t)
        }
      }
    }

    // stop(recordingId: string) -> Promise<{ uri: string, durationMs: number, size: number }>
    AsyncFunction("stop") { recordingId: String, promise: Promise ->
      worker.execute {
        val rec = activeRecorder
        if (rec == null || (recordingId.isNotEmpty() && rec.recordingId != recordingId)) {
          promise.reject(
            "ERR_NOT_RECORDING",
            "No active recording matching id=$recordingId",
            null,
          )
          return@execute
        }
        activeRecorder = null
        ProbeFrameProcessor.setActiveRecorder(null)
        stopTicker()
        try {
          val res = rec.stop()
          promise.resolve(
            mapOf(
              "uri" to res.uri,
              "durationMs" to res.durationMs.toDouble(),
              "size" to res.sizeBytes.toDouble(),
            ),
          )
        } catch (t: Throwable) {
          Log.e(TAG, "Failed to stop recording", t)
          sendEvent(
            "onError",
            mapOf("recordingId" to rec.recordingId, "message" to (t.message ?: "stop failed")),
          )
          promise.reject("ERR_STOP_FAILED", t.message ?: "Failed to stop recording", t)
        }
      }
    }

    // Crash recovery helper: stitches any leftover `rec_*` segment directories in `outputDir` and
    // returns `[{ uri, durationMs, size }]`.
    AsyncFunction("recoverOrphanedRecordings") { rawDir: String, promise: Promise ->
      worker.execute {
        try {
          val dir = resolveOutputDir(rawDir)
          val list = SegmentStitcher.recoverLeftoverSessions(dir)
          val mapped =
            list.map { r ->
              mapOf(
                "uri" to "file://${r.outputFile.absolutePath}",
                "durationMs" to r.durationMs.toDouble(),
                "size" to r.sizeBytes.toDouble(),
              )
            }
          promise.resolve(mapped)
        } catch (t: Throwable) {
          promise.reject("ERR_RECOVER_FAILED", t.message ?: "Recovery failed", t)
        }
      }
    }
  }

  private fun resolveOutputDir(rawDir: String): File {
    val cleaned = rawDir.removePrefix("file://").trim()
    if (cleaned.isNotEmpty()) {
      return File(cleaned)
    }
    val fallback = appContext.reactContext?.filesDir ?: File("/data/local/tmp")
    return File(fallback, "webrtc_recordings")
  }

  private fun registerProcessor() {
    ProcessorProvider.addProcessor(
      ProbeFrameProcessor.PROCESSOR_NAME,
      VideoFrameProcessorFactoryInterface { ProbeFrameProcessor(stats) },
    )
  }

  @Synchronized
  private fun startTicker() {
    if (ticker != null) return
    ticker =
      Executors.newSingleThreadScheduledExecutor().also {
        it.scheduleAtFixedRate({ emitTick() }, 1, 1, TimeUnit.SECONDS)
      }
  }

  @Synchronized
  private fun stopTicker() {
    ticker?.shutdownNow()
    ticker = null
  }

  private fun emitTick() {
    try {
      val s = stats.tick()
      s["rawFrames"] = ProbeFrameProcessor.getRawFrames()
      Log.i(
        TAG,
        "tap ${s["width"]}x${s["height"]} rot=${s["rotation"]} fps=${s["fps"]} " +
          "dropped=${s["droppedFrames"]} maxGapMs=${s["maxGapMs"]} raw=${s["rawFrames"]}",
      )
      sendEvent("onStats", s)
    } catch (t: Throwable) {
      // Never let the ticker die silently; a throw inside scheduleAtFixedRate cancels it.
      Log.e(TAG, "stats tick failed", t)
    }
  }
}
