#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// One rolling segment: a single AVAssetWriter with an H.264 video input and an AAC audio input.
///
/// Written as a fragmented QuickTime movie (`movieFragmentInterval`), so a segment that was still
/// open when the app died is readable up to its last fragment — crash recovery loses at most
/// about one fragment, not the whole segment.
///
/// Not thread-safe: every method must be called on the owning recorder's serial queue.
@interface WRSegmentWriter : NSObject

@property(nonatomic, readonly) NSURL *url;
@property(nonatomic, readonly) int32_t width;
@property(nonatomic, readonly) int32_t height;
@property(nonatomic, readonly) int rotation;
/// Session start = pts of the first video frame (ns, host clock).
@property(nonatomic, readonly) int64_t startNs;
@property(nonatomic, readonly) int64_t lastVideoNs;
/// End (pts + duration) of the last audio sample written, or -1.
@property(nonatomic, readonly) int64_t audioEndNs;
@property(nonatomic, readonly) int64_t firstAudioNs;
@property(nonatomic, readonly) int64_t videoFrames;
@property(nonatomic, readonly) int64_t audioFrames;
@property(nonatomic, readonly) int64_t droppedVideo;
@property(nonatomic, readonly) int64_t droppedAudio;
@property(nonatomic, readonly, nullable) NSString *failure;
/// YES once video input is closed (segment rotated away or stopping); audio may still drain.
@property(nonatomic, readonly) BOOL videoClosed;

/// Creates the writer and opens the session at `startNs`. Returns nil (with `error`) on failure.
+ (nullable instancetype)writerWithURL:(NSURL *)url
                                 width:(int32_t)width
                                height:(int32_t)height
                              rotation:(int)rotation
                               startNs:(int64_t)startNs
                                   fps:(NSInteger)fps
                          videoBitrate:(NSInteger)videoBitrate
                          audioBitrate:(NSInteger)audioBitrate
                                 error:(NSString *_Nullable *_Nullable)error;

/// Appends one camera frame. Returns NO if it was dropped (not ready / non-monotonic / failed).
- (BOOL)appendPixelBuffer:(CVPixelBufferRef)pixelBuffer ptsNs:(int64_t)ptsNs;

/// Appends mono PCM16 samples starting at `ptsNs`. Samples before `startNs` and (when `limitNs`
/// >= 0) at/after `limitNs` are trimmed off.
- (void)appendPCM:(const int16_t *)samples
           frames:(UInt32)frames
       sampleRate:(double)rate
            ptsNs:(int64_t)ptsNs
          limitNs:(int64_t)limitNs;

/// Stops taking video. Audio is still accepted until `finishAtNs:completion:`.
- (void)closeVideo;

/// Ends the session at `endNs` and finalizes the file. Completion runs on an arbitrary queue
/// with YES on success.
- (void)finishAtNs:(int64_t)endNs completion:(void (^)(BOOL ok))completion;

/// Discards the writer and deletes its file (used when a segment never got a frame).
- (void)cancel;

@end

NS_ASSUME_NONNULL_END
