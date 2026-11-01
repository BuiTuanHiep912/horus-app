#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Records the raw camera frames delivered by the `WRFrameProbe` tap (H.264) and the mic samples
/// delivered by `WRAudioDevice` (AAC). Both are stamped on the host clock, so they line up without
/// extra sync logic.
///
/// M3: frames go to rolling segments (`<outputURL minus extension>/segment_NNNN.mov`, a new one every
/// `segmentSeconds` or whenever the frame size/rotation changes, e.g. a camera switch). `stop`
/// stitches them losslessly into `outputURL`. If the app dies, the folder is left behind and
/// `WRStitcher recoverInDirectory:` turns it into `recovered_rec_*.mp4` on the next launch.
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
                       audioBitrate:(NSInteger)audioBitrate
                     segmentSeconds:(NSInteger)segmentSeconds NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

/// Folder holding this recording's segments (excluded from crash recovery while recording).
@property(nonatomic, readonly) NSURL *sessionDirectory;

/// Finishes the file. Result keys match the JS `StopRecordingResult` type
/// (`uri`, `durationMs`, `size`) plus diagnostics (`frames`, `droppedFrames`, `width`, `height`,
/// `rotation`, `audioFrames`, `audioDroppedBuffers`, `audioStartOffsetMs`, `segments`,
/// `recordedSegments`).
- (void)stopWithCompletion:(void (^)(NSDictionary<NSString *, id> *_Nullable result,
                                     NSError *_Nullable error))completion;

@end

NS_ASSUME_NONNULL_END
