#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Writes the raw camera frames delivered by the `WRFrameProbe` tap (H.264) and the mic samples
/// delivered by `WRAudioDevice` (AAC) into one MP4 (`AVAssetWriter`). Both are stamped on the
/// host clock, so they line up without extra sync logic. Rolling segments (M3) come later.
///
/// Threading: frames arrive on the WebRTC capture queue and are handed to a private serial
/// writer queue, so the capture thread is never blocked. Frames that arrive while the encoder
/// is busy are dropped and counted.
///
/// Foundation-only public header (bridged to Swift through the module umbrella header).
@interface WRTrackRecorder : NSObject

@property(nonatomic, copy, readonly) NSString *recordingId;
@property(nonatomic, copy, readonly) NSURL *outputURL;

- (instancetype)initWithRecordingId:(NSString *)recordingId
                          outputURL:(NSURL *)outputURL
                                fps:(NSInteger)fps
                       videoBitrate:(NSInteger)videoBitrate
                       audioBitrate:(NSInteger)audioBitrate NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

/// Finishes the file. Result keys match the JS `StopRecordingResult` type
/// (`uri`, `durationMs`, `size`) plus diagnostics (`frames`, `droppedFrames`, `width`, `height`,
/// `rotation`, `audioFrames`, `audioDroppedBuffers`, `audioSampleRate`, `audioStartOffsetMs`).
- (void)stopWithCompletion:(void (^)(NSDictionary<NSString *, id> *_Nullable result,
                                     NSError *_Nullable error))completion;

@end

NS_ASSUME_NONNULL_END
