#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Custom WebRTC audio device (M2). Owns the microphone through a RemoteIO audio unit, feeds every
/// captured PCM buffer to WebRTC (live preview audio, unchanged behaviour) and hands the same
/// samples to the active `WRTrackRecorder` (the iOS counterpart of Android's
/// `JavaAudioDeviceModule.setSamplesReadyCallback`).
///
/// Remote phones only send audio, so playout is a no-op: nothing is rendered to the speaker.
///
/// Installed into `WebRTCModuleOptions.audioDevice` from `+load`, i.e. before react-native-webrtc
/// creates its `RTCPeerConnectionFactory`.
///
/// Foundation-only public header (bridged to Swift through the module umbrella header).
@interface WRAudioDevice : NSObject

/// YES when this device is the one react-native-webrtc will use.
+ (BOOL)isInstalled;

@end

NS_ASSUME_NONNULL_END
