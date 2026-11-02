package expo.modules.webrtcrecorder;

import android.content.Context;

import java.util.Collections;
import java.util.List;

import expo.modules.core.interfaces.ApplicationLifecycleListener;
import expo.modules.core.interfaces.Package;

/**
 * Discovered automatically by expo-modules-autolinking (matches {@code *Package.java} importing
 * {@code expo.modules.core.interfaces.Package}) so our {@link ApplicationLifecycleListener} runs in
 * {@code Application.onCreate} before {@code WebRTCModule} is instantiated.
 */
public final class WebrtcRecorderPackage implements Package {
    @Override
    public List<? extends ApplicationLifecycleListener> createApplicationLifecycleListeners(
            Context context) {
        return Collections.singletonList(new WebrtcRecorderLifecycleListener());
    }
}
