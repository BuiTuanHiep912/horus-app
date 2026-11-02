package expo.modules.webrtcrecorder;

import android.util.Log;

import org.webrtc.audio.JavaAudioDeviceModule;

import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Static hub that receives raw PCM samples from {@link JavaAudioDeviceModule}'s
 * {@code SamplesReadyCallback} (wired before {@code WebRTCModule} is instantiated via
 * {@link WebrtcRecorderLifecycleListener}) and forwards them to any active recorder.
 */
final class AudioSampleDispatcher implements JavaAudioDeviceModule.SamplesReadyCallback {
    private static final String TAG = "WebrtcRecorderAudio";

    interface Listener {
        void onAudioSamples(
                int audioFormat,
                int channelCount,
                int sampleRate,
                byte[] data,
                long captureMonotonicNs);
    }

    static final AudioSampleDispatcher INSTANCE = new AudioSampleDispatcher();

    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private volatile boolean callbackWired = false;
    private volatile long totalCallbacks = 0;

    private AudioSampleDispatcher() {}

    void markCallbackWired() {
        callbackWired = true;
    }

    boolean isCallbackWired() {
        return callbackWired;
    }

    long getTotalCallbacks() {
        return totalCallbacks;
    }

    void addListener(Listener l) {
        if (l != null && !listeners.contains(l)) {
            listeners.add(l);
        }
    }

    void removeListener(Listener l) {
        if (l != null) {
            listeners.remove(l);
        }
    }

    @Override
    public void onWebRtcAudioRecordSamplesReady(JavaAudioDeviceModule.AudioSamples samples) {
        long nowNs = System.nanoTime();
        totalCallbacks++;
        if (listeners.isEmpty()) return;
        byte[] data = samples.getData();
        if (data == null || data.length == 0) return;
        for (Listener l : listeners) {
            try {
                l.onAudioSamples(
                        samples.getAudioFormat(),
                        samples.getChannelCount(),
                        samples.getSampleRate(),
                        data,
                        nowNs);
            } catch (Throwable t) {
                Log.w(TAG, "Audio listener threw", t);
            }
        }
    }
}
