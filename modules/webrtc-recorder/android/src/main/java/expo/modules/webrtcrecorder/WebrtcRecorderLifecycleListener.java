package expo.modules.webrtcrecorder;

import android.app.Application;
import android.util.Log;

import com.oney.WebRTCModule.WebRTCModuleOptions;

import org.webrtc.audio.JavaAudioDeviceModule;

import expo.modules.core.interfaces.ApplicationLifecycleListener;

/**
 * Installs a {@link JavaAudioDeviceModule} with our {@link AudioSampleDispatcher} into
 * {@link WebRTCModuleOptions#getInstance()} during {@link Application#onCreate}, before
 * {@code WebRTCModule} is lazily created by React Native.
 */
public final class WebrtcRecorderLifecycleListener implements ApplicationLifecycleListener {
    private static final String TAG = "WebrtcRecorder";

    @Override
    public void onCreate(Application application) {
        installAudioTapIfNeeded(application);
    }

    static synchronized void installAudioTapIfNeeded( android.content.Context context) {
        try {
            WebRTCModuleOptions opts = WebRTCModuleOptions.getInstance();
            if (opts.audioDeviceModule != null) {
                Log.i(TAG, "WebRTCModuleOptions.audioDeviceModule already set; leaving as-is");
                return;
            }
            opts.audioDeviceModule =
                    JavaAudioDeviceModule.builder(context.getApplicationContext())
                            .setEnableVolumeLogger(false)
                            .setSamplesReadyCallback(AudioSampleDispatcher.INSTANCE)
                            .createAudioDeviceModule();
            AudioSampleDispatcher.INSTANCE.markCallbackWired();
            Log.i(TAG, "Installed JavaAudioDeviceModule with SamplesReadyCallback");
        } catch (Throwable t) {
            Log.e(TAG, "Failed to install JavaAudioDeviceModule audio tap", t);
        }
    }
}
