#import "WRStitcher.h"

#import <AVFoundation/AVFoundation.h>

@implementation WRStitcher

+ (NSArray<NSURL *> *)segmentURLsInDir:(NSURL *)dir {
  NSArray<NSURL *> *items = [[NSFileManager defaultManager] contentsOfDirectoryAtURL:dir
                                                          includingPropertiesForKeys:nil
                                                                             options:0
                                                                               error:nil];
  NSMutableArray<NSURL *> *segments = [NSMutableArray array];
  for (NSURL *u in items) {
    if ([u.lastPathComponent hasPrefix:@"segment_"] && [u.pathExtension isEqualToString:@"mov"]) {
      [segments addObject:u];
    }
  }
  [segments sortUsingComparator:^NSComparisonResult(NSURL *a, NSURL *b) {
    return [a.lastPathComponent compare:b.lastPathComponent];
  }];
  return segments;
}

+ (void)stitchSessionDir:(NSURL *)sessionDir
                   toURL:(NSURL *)destURL
              completion:(void (^)(NSDictionary<NSString *, id> *_Nullable, NSString *_Nullable))completion {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSArray<NSURL *> *segments = [self segmentURLsInDir:sessionDir];
    AVMutableComposition *composition = [AVMutableComposition composition];
    AVMutableCompositionTrack *videoTrack = nil;
    AVMutableCompositionTrack *audioTrack = nil;
    CMTime cursor = kCMTimeZero;
    NSInteger used = 0;

    for (NSURL *url in segments) {
      AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url
                                              options:@{AVURLAssetPreferPreciseDurationAndTimingKey : @YES}];
      AVAssetTrack *v = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
      if (v == nil || CMTIME_COMPARE_INLINE(v.timeRange.duration, <=, kCMTimeZero)) {
        NSLog(@"[WebrtcRecorder] stitch: skip unreadable %@", url.lastPathComponent);
        continue;
      }
      // The segment's video range defines its length; audio is clipped to the same range so the
      // two tracks stay aligned across joins.
      CMTimeRange range = v.timeRange;
      if (videoTrack == nil) {
        videoTrack = [composition addMutableTrackWithMediaType:AVMediaTypeVideo
                                              preferredTrackID:kCMPersistentTrackID_Invalid];
        videoTrack.preferredTransform = v.preferredTransform;
      }
      NSError *err = nil;
      if (![videoTrack insertTimeRange:range ofTrack:v atTime:cursor error:&err]) {
        NSLog(@"[WebrtcRecorder] stitch: video insert failed %@: %@", url.lastPathComponent, err);
        continue;
      }
      AVAssetTrack *a = [asset tracksWithMediaType:AVMediaTypeAudio].firstObject;
      if (a != nil) {
        if (audioTrack == nil) {
          audioTrack = [composition addMutableTrackWithMediaType:AVMediaTypeAudio
                                                preferredTrackID:kCMPersistentTrackID_Invalid];
        }
        CMTimeRange audioRange = CMTimeRangeGetIntersection(range, a.timeRange);
        if (CMTIME_COMPARE_INLINE(audioRange.duration, >, kCMTimeZero)) {
          CMTime at = CMTimeAdd(cursor, CMTimeSubtract(audioRange.start, range.start));
          [audioTrack insertTimeRange:audioRange ofTrack:a atTime:at error:nil];
        }
      }
      cursor = CMTimeAdd(cursor, range.duration);
      used++;
    }

    if (used == 0) {
      completion(nil, @"No readable segments");
      return;
    }

    [[NSFileManager defaultManager] removeItemAtURL:destURL error:nil];
    AVAssetExportSession *export = [AVAssetExportSession exportSessionWithAsset:composition
                                                                     presetName:AVAssetExportPresetPassthrough];
    export.outputURL = destURL;
    export.outputFileType = AVFileTypeMPEG4;
    export.shouldOptimizeForNetworkUse = YES;
    NSInteger segmentCount = used;
    CMTime total = cursor;
    [export exportAsynchronouslyWithCompletionHandler:^{
      if (export.status != AVAssetExportSessionStatusCompleted) {
        NSString *msg = export.error.localizedDescription ?: @"export failed";
        NSLog(@"[WebrtcRecorder] stitch export failed: %@", export.error);
        completion(nil, msg);
        return;
      }
      NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:destURL.path error:nil];
      [[NSFileManager defaultManager] removeItemAtURL:sessionDir error:nil];
      completion(@{
        @"uri" : destURL.absoluteString,
        @"durationMs" : @(CMTimeGetSeconds(total) * 1000.0),
        @"size" : @([attrs fileSize]),
        @"segments" : @(segmentCount),
      },
                 nil);
    }];
  });
}

+ (void)recoverInDirectory:(NSURL *)outputDir
                 excluding:(nullable NSURL *)excludeDir
                completion:(void (^)(NSArray<NSDictionary<NSString *, id> *> *))completion {
  NSArray<NSURL *> *items = [[NSFileManager defaultManager] contentsOfDirectoryAtURL:outputDir
                                                          includingPropertiesForKeys:@[ NSURLIsDirectoryKey ]
                                                                             options:0
                                                                               error:nil];
  NSMutableArray<NSURL *> *folders = [NSMutableArray array];
  for (NSURL *u in items) {
    NSNumber *isDir = nil;
    [u getResourceValue:&isDir forKey:NSURLIsDirectoryKey error:nil];
    if (!isDir.boolValue || ![u.lastPathComponent hasPrefix:@"rec_"]) continue;
    if (excludeDir != nil && [u.standardizedURL isEqual:excludeDir.standardizedURL]) continue;
    [folders addObject:u];
  }

  NSMutableArray<NSDictionary *> *results = [NSMutableArray array];
  dispatch_group_t group = dispatch_group_create();
  NSObject *lock = [NSObject new];
  for (NSURL *folder in folders) {
    NSURL *dest = [outputDir URLByAppendingPathComponent:
                                 [NSString stringWithFormat:@"recovered_%@.mp4", folder.lastPathComponent]];
    dispatch_group_enter(group);
    [self stitchSessionDir:folder
                     toURL:dest
                completion:^(NSDictionary *result, NSString *error) {
                  if (result != nil) {
                    @synchronized(lock) {
                      [results addObject:result];
                    }
                    NSLog(@"[WebrtcRecorder] recovered %@ -> %@", folder.lastPathComponent, result);
                  } else {
                    // Nothing salvageable: drop the folder so it is not retried forever.
                    NSLog(@"[WebrtcRecorder] recovery of %@ failed (%@), deleting", folder.lastPathComponent, error);
                    [[NSFileManager defaultManager] removeItemAtURL:folder error:nil];
                  }
                  dispatch_group_leave(group);
                }];
  }
  dispatch_group_notify(group, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    completion(results);
  });
}

@end
