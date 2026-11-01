#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Lossless segment stitching and crash recovery (iOS counterpart of Android's SegmentStitcher).
///
/// Layout (same as Android): while recording, segments live in `<outputDir>/rec_<ts>/segment_NNNN.mov`;
/// a clean stop stitches them into `<outputDir>/rec_<ts>.mp4` and deletes the folder. Any `rec_*`
/// folder left behind (app killed mid-recording) is stitched into
/// `<outputDir>/recovered_rec_<ts>.mp4` by `recoverInDirectory:`.
///
/// Stitching uses AVMutableComposition + a passthrough export: no re-encoding.
/// Foundation-only public header (bridged to Swift through the module umbrella header).
@interface WRStitcher : NSObject

/// Stitches every readable `segment_*.mov` in `sessionDir` (in name order) into `destURL` (MP4).
/// On success deletes `sessionDir` and calls back with `{uri, durationMs, size, segments}`.
/// Segments that cannot be read (e.g. truncated before their first fragment) are skipped.
+ (void)stitchSessionDir:(NSURL *)sessionDir
                   toURL:(NSURL *)destURL
              completion:(void (^)(NSDictionary<NSString *, id> *_Nullable result,
                                   NSString *_Nullable error))completion;

/// Recovers every leftover `rec_*` folder in `outputDir` except `excludeDir`. Completion gets one
/// result dictionary per recovered file (empty folders are deleted and not reported).
+ (void)recoverInDirectory:(NSURL *)outputDir
                 excluding:(nullable NSURL *)excludeDir
                completion:(void (^)(NSArray<NSDictionary<NSString *, id> *> *results))completion;

@end

NS_ASSUME_NONNULL_END
