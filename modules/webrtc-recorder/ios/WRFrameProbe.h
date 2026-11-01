#import <Foundation/Foundation.h>

@class WRTrackRecorder;

NS_ASSUME_NONNULL_BEGIN

/// Frame tap registered in react-native-webrtc's `ProcessorProvider` under `processorName`.
/// Enabled on a local track from JS with `track._setVideoEffects([processorName])`.
///
/// On iOS the processor sits between the camera capturer and the `RTCVideoSource`
/// (`capturer.delegate = VideoEffectProcessor`), so it already receives the unadapted
/// camera frames — no react-native-webrtc patch is needed (unlike Android).
///
/// This header is Foundation-only on purpose: it is the module's public bridge to Swift.
@interface WRFrameProbe : NSObject

+ (NSString *)processorName;

/// Idempotent: (re)registers the processor in `ProcessorProvider`.
+ (void)registerProcessor;

/// Clears all counters (window + session).
+ (void)reset;

/// Snapshot of the window since the previous tick, then starts a new window.
/// Keys match the JS `RecorderStats` type.
+ (NSDictionary<NSString *, id> *)tick;

/// Whole-session summary since `reset`. Keys match the JS `ProbeSummary` type.
+ (NSDictionary<NSString *, id> *)summary;

/// Routes every tapped frame (and, via WRAudioDevice, every mic buffer) to `recorder`
/// (nil stops routing).
+ (void)setActiveRecorder:(nullable WRTrackRecorder *)recorder;

/// The recorder currently receiving frames/samples, if any. Safe to call from any thread.
+ (nullable WRTrackRecorder *)activeRecorder;

@end

NS_ASSUME_NONNULL_END
