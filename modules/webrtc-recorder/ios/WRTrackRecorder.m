#import "WRTrackRecorder+Private.h"
#import "WRSegmentWriter.h"
#import "WRStitcher.h"

#import <AVFoundation/AVFoundation.h>
#import <WebRTC/WebRTC.h>

static NSString *const kErrorDomain = @"WebrtcRecorder";
// After a rotation the previous segment stays open for audio that was captured before the boundary
// but delivered after it; this caps how long we wait.
static const int64_t kDrainTimeoutMs = 600;
// A pause in camera frames longer than this (broadcast stopped and restarted while recording,
// camera interrupted...) ends the segment at its last frame; the pause is cut from the timeline
// instead of becoming a frozen picture that the audio track would not match.
static const int64_t kFrameGapNs = 500 * NSEC_PER_MSEC;

@implementation WRTrackRecorder {
  dispatch_queue_t _queue;
  dispatch_group_t _finishing;
  NSInteger _fps;
  NSInteger _videoBitrate;
  NSInteger _audioBitrate;
  int64_t _segmentNs;
  NSURL *_sessionDir;

  // Only touched on _queue.
  WRSegmentWriter *_current;
  WRSegmentWriter *_draining;
  int64_t _drainLimitNs;
  NSUInteger _drainGeneration;
  NSMutableArray<WRSegmentWriter *> *_segments;
  NSInteger _segmentIndex;
  BOOL _stopping;
  NSString *_failure;
  int64_t _firstPtsNs;
  int64_t _lastPtsNs;
  int64_t _rejectedFrames;  // non-camera or cropped buffers, never reached a segment
}

- (instancetype)initWithRecordingId:(NSString *)recordingId
                          outputURL:(NSURL *)outputURL
                                fps:(NSInteger)fps
                       videoBitrate:(NSInteger)videoBitrate
                       audioBitrate:(NSInteger)audioBitrate
                     segmentSeconds:(NSInteger)segmentSeconds {
  if ((self = [super init])) {
    _recordingId = [recordingId copy];
    _outputURL = [outputURL copy];
    _sessionDir = [outputURL URLByDeletingPathExtension];
    _fps = fps > 0 ? fps : 30;
    _videoBitrate = videoBitrate > 0 ? videoBitrate : 6000000;
    _audioBitrate = audioBitrate > 0 ? audioBitrate : 128000;
    _segmentNs = (segmentSeconds > 0 ? segmentSeconds : 20) * (int64_t)NSEC_PER_SEC;
    _queue = dispatch_queue_create("webrtc-recorder.writer", DISPATCH_QUEUE_SERIAL);
    _finishing = dispatch_group_create();
    _segments = [NSMutableArray array];
    _firstPtsNs = -1;
    _lastPtsNs = -1;
    [[NSFileManager defaultManager] createDirectoryAtURL:_sessionDir
                             withIntermediateDirectories:YES
                                              attributes:nil
                                                   error:nil];
  }
  return self;
}

- (NSURL *)sessionDirectory {
  return _sessionDir;
}

#pragma mark - Video (capture queue -> writer queue)

- (void)appendFrame:(RTCVideoFrame *)frame {
  // ARC keeps `frame` (and its CVPixelBuffer) alive until the block has run.
  dispatch_async(_queue, ^{
    [self writeFrame:frame];
  });
}

- (void)writeFrame:(RTCVideoFrame *)frame {
  if (_stopping || _failure != nil) return;
  if (![frame.buffer isKindOfClass:[RTCCVPixelBuffer class]]) {
    _rejectedFrames++;
    return;
  }
  RTCCVPixelBuffer *rtcBuffer = (RTCCVPixelBuffer *)frame.buffer;
  CVPixelBufferRef pixelBuffer = rtcBuffer.pixelBuffer;
  int32_t w = (int32_t)CVPixelBufferGetWidth(pixelBuffer);
  int32_t h = (int32_t)CVPixelBufferGetHeight(pixelBuffer);
  if (rtcBuffer.cropWidth != w || rtcBuffer.cropHeight != h) {
    _rejectedFrames++;  // cropped/adapted buffer: only full camera frames are recorded
    return;
  }
  int64_t ptsNs = frame.timeStampNs;
  if (ptsNs <= _lastPtsNs) {
    _rejectedFrames++;
    return;
  }
  int rotation = (int)frame.rotation;

  BOOL formatChanged = _current != nil &&
                       (w != _current.width || h != _current.height || rotation != _current.rotation);
  BOOL timeUp = _current != nil && ptsNs - _current.startNs >= _segmentNs;
  BOOL resumedAfterGap =
      _current != nil && _current.lastVideoNs >= 0 && ptsNs - _current.lastVideoNs > kFrameGapNs;
  if (_current == nil || formatChanged || timeUp || resumedAfterGap) {
    // Normally the old segment ends exactly where the new one starts (seamless join). After a
    // gap it ends one frame after its last frame instead, so the gap is dropped when stitching.
    int64_t endNs = resumedAfterGap ? _current.lastVideoNs + (int64_t)(NSEC_PER_SEC / _fps) : ptsNs;
    if (![self rotateAtNs:ptsNs previousEndNs:endNs width:w height:h rotation:rotation]) return;
    if (formatChanged) {
      NSLog(@"[WebrtcRecorder] format changed -> %dx%d rot=%d, new segment", w, h, rotation);
    }
    if (resumedAfterGap) {
      NSLog(@"[WebrtcRecorder] frames resumed after %.0f ms gap, gap cut", (ptsNs - endNs) / 1e6);
    }
  }

  if ([_current appendPixelBuffer:pixelBuffer ptsNs:ptsNs]) {
    if (_firstPtsNs < 0) _firstPtsNs = ptsNs;
    _lastPtsNs = ptsNs;
  }
}

/// Closes the current segment (it keeps draining audio up to `previousEndNs`) and opens the next
/// one, whose session starts at `ptsNs`. Segments are stitched back to back, so anything between
/// `previousEndNs` and `ptsNs` is not in the final file.
- (BOOL)rotateAtNs:(int64_t)ptsNs
     previousEndNs:(int64_t)previousEndNs
             width:(int32_t)w
            height:(int32_t)h
          rotation:(int)rotation {
  if (_current != nil) {
    [self finishDraining];  // at most one draining segment at a time
    _draining = _current;
    _drainLimitNs = previousEndNs;
    [_draining closeVideo];
    NSUInteger generation = ++_drainGeneration;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, kDrainTimeoutMs * NSEC_PER_MSEC), _queue, ^{
      if (self->_drainGeneration == generation) [self finishDraining];
    });
  }

  _segmentIndex++;
  NSURL *url = [_sessionDir URLByAppendingPathComponent:
                                [NSString stringWithFormat:@"segment_%04ld.mov", (long)_segmentIndex]];
  NSString *error = nil;
  _current = [WRSegmentWriter writerWithURL:url
                                      width:w
                                     height:h
                                   rotation:rotation
                                    startNs:ptsNs
                                        fps:_fps
                               videoBitrate:_videoBitrate
                               audioBitrate:_audioBitrate
                                      error:&error];
  if (_current == nil) {
    _failure = error ?: @"Cannot open segment";
    NSLog(@"[WebrtcRecorder] %@", _failure);
    return NO;
  }
  [_segments addObject:_current];
  NSLog(@"[WebrtcRecorder] segment %ld started %dx%d rot=%d", (long)_segmentIndex, w, h, rotation);
  return YES;
}

- (void)finishDraining {
  WRSegmentWriter *segment = _draining;
  if (segment == nil) return;
  _draining = nil;
  _drainGeneration++;
  [self finishSegment:segment atNs:_drainLimitNs];
}

- (void)finishSegment:(WRSegmentWriter *)segment atNs:(int64_t)endNs {
  if (segment.videoFrames == 0) {
    [segment cancel];
    return;
  }
  dispatch_group_enter(_finishing);
  [segment finishAtNs:endNs
           completion:^(BOOL ok) {
             if (!ok) NSLog(@"[WebrtcRecorder] segment %@ did not finalize", segment.url.lastPathComponent);
             dispatch_group_leave(self->_finishing);
           }];
}

#pragma mark - Audio (IO thread -> writer queue)

- (void)appendAudioSamples:(const int16_t *)samples
                    frames:(UInt32)frames
                sampleRate:(double)sampleRate
                hostTimeNs:(int64_t)hostTimeNs {
  if (frames == 0) return;
  NSData *pcm = [NSData dataWithBytes:samples length:frames * sizeof(int16_t)];
  dispatch_async(_queue, ^{
    [self writeAudio:pcm frames:frames sampleRate:sampleRate ptsNs:hostTimeNs];
  });
}

- (void)writeAudio:(NSData *)pcm frames:(UInt32)frames sampleRate:(double)rate ptsNs:(int64_t)ptsNs {
  if (_failure != nil || rate <= 0) return;
  const int16_t *samples = (const int16_t *)pcm.bytes;
  int64_t endNs = ptsNs + (int64_t)llround(frames * 1e9 / rate);

  // Head of the buffer (before the boundary) belongs to the draining segment...
  if (_draining != nil) {
    [_draining appendPCM:samples frames:frames sampleRate:rate ptsNs:ptsNs limitNs:_drainLimitNs];
    if (endNs >= _drainLimitNs) [self finishDraining];
  }
  // ...the rest to the current one (it trims anything before its own start).
  if (_current != nil && !_stopping) {
    [_current appendPCM:samples frames:frames sampleRate:rate ptsNs:ptsNs limitNs:-1];
  }
}

#pragma mark - Stop

- (void)stopWithCompletion:(void (^)(NSDictionary<NSString *, id> *_Nullable, NSError *_Nullable))completion {
  dispatch_async(_queue, ^{
    self->_stopping = YES;
    [self finishDraining];
    WRSegmentWriter *last = self->_current;
    self->_current = nil;
    if (last != nil) {
      // Give the last frame its nominal duration so the file length matches what was filmed.
      [self finishSegment:last atNs:last.lastVideoNs + (int64_t)(NSEC_PER_SEC / self->_fps)];
    }

    dispatch_group_notify(self->_finishing, self->_queue, ^{
      NSDictionary *diag = [self diagnostics];
      if (self->_firstPtsNs < 0) {
        [[NSFileManager defaultManager] removeItemAtURL:self->_sessionDir error:nil];
        NSString *msg = self->_failure ?: @"No video frames were recorded";
        completion(nil, [NSError errorWithDomain:kErrorDomain code:1 userInfo:@{NSLocalizedDescriptionKey : msg}]);
        return;
      }
      [WRStitcher stitchSessionDir:self->_sessionDir
                             toURL:self->_outputURL
                        completion:^(NSDictionary *stitched, NSString *error) {
                          if (stitched == nil) {
                            // Segments stay on disk: the next launch recovers them.
                            NSString *msg = [NSString stringWithFormat:@"Stitch failed: %@", error];
                            completion(nil, [NSError errorWithDomain:kErrorDomain
                                                                code:2
                                                            userInfo:@{NSLocalizedDescriptionKey : msg}]);
                            return;
                          }
                          NSMutableDictionary *result = [diag mutableCopy];
                          [result addEntriesFromDictionary:stitched];
                          NSLog(@"[WebrtcRecorder] finished %@", result);
                          completion(result, nil);
                        }];
    });
  });
}

/// Totals across segments, for the JS log (`WebRTC recorder result`).
- (NSDictionary<NSString *, id> *)diagnostics {
  int64_t frames = 0, dropped = _rejectedFrames, audioFrames = 0, audioDropped = 0;
  for (WRSegmentWriter *s in _segments) {
    frames += s.videoFrames;
    dropped += s.droppedVideo;
    audioFrames += s.audioFrames;
    audioDropped += s.droppedAudio;
  }
  WRSegmentWriter *first = _segments.firstObject;
  double audioOffsetMs = first != nil && first.firstAudioNs >= 0 ? (first.firstAudioNs - first.startNs) / 1e6 : -1;
  return @{
    @"frames" : @(frames),
    @"droppedFrames" : @(dropped),
    @"audioFrames" : @(audioFrames),
    @"audioDroppedBuffers" : @(audioDropped),
    @"audioStartOffsetMs" : @(audioOffsetMs),
    @"width" : @(first.width),
    @"height" : @(first.height),
    @"rotation" : @(first.rotation),
    @"recordedSegments" : @(_segments.count),
  };
}

@end
