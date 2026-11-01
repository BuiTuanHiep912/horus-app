#import "WRSegmentWriter.h"

static const double kAudioOutputSampleRate = 48000.0;
// Audio buffers whose start is this close to the previous buffer's end are treated as contiguous,
// absorbing host-clock jitter so AVAssetWriter never sees tiny overlaps or gaps.
static const int64_t kAudioJoinToleranceNs = 2000000;  // 2 ms
// Fragment cadence of the segment movie: the crash-loss bound for the open segment.
static const int64_t kFragmentIntervalSeconds = 1;

@implementation WRSegmentWriter {
  AVAssetWriter *_writer;
  AVAssetWriterInput *_videoInput;
  AVAssetWriterInput *_audioInput;
  AVAssetWriterInputPixelBufferAdaptor *_adaptor;
  CMAudioFormatDescriptionRef _audioFormat;
  double _audioFormatRate;
  BOOL _finished;
}

+ (instancetype)writerWithURL:(NSURL *)url
                        width:(int32_t)width
                       height:(int32_t)height
                     rotation:(int)rotation
                      startNs:(int64_t)startNs
                          fps:(NSInteger)fps
                 videoBitrate:(NSInteger)videoBitrate
                 audioBitrate:(NSInteger)audioBitrate
                        error:(NSString **)error {
  WRSegmentWriter *w = [[self alloc] initWithURL:url width:width height:height rotation:rotation startNs:startNs];
  NSString *failure = [w setUpWithFps:fps videoBitrate:videoBitrate audioBitrate:audioBitrate];
  if (failure != nil) {
    if (error) *error = failure;
    [w cancel];
    return nil;
  }
  return w;
}

- (instancetype)initWithURL:(NSURL *)url
                      width:(int32_t)width
                     height:(int32_t)height
                   rotation:(int)rotation
                    startNs:(int64_t)startNs {
  if ((self = [super init])) {
    _url = [url copy];
    _width = width;
    _height = height;
    _rotation = rotation;
    _startNs = startNs;
    _lastVideoNs = -1;
    _audioEndNs = -1;
    _firstAudioNs = -1;
  }
  return self;
}

- (void)dealloc {
  if (_audioFormat != NULL) CFRelease(_audioFormat);
}

- (nullable NSString *)setUpWithFps:(NSInteger)fps videoBitrate:(NSInteger)videoBitrate audioBitrate:(NSInteger)audioBitrate {
  [[NSFileManager defaultManager] removeItemAtURL:_url error:nil];

  NSError *error = nil;
  _writer = [[AVAssetWriter alloc] initWithURL:_url fileType:AVFileTypeQuickTimeMovie error:&error];
  if (_writer == nil) return error.localizedDescription ?: @"Cannot create AVAssetWriter";
  _writer.movieFragmentInterval = CMTimeMake(kFragmentIntervalSeconds, 1);

  NSDictionary *videoSettings = @{
    AVVideoCodecKey : AVVideoCodecTypeH264,
    AVVideoWidthKey : @(_width),
    AVVideoHeightKey : @(_height),
    AVVideoCompressionPropertiesKey : @{
      AVVideoAverageBitRateKey : @(videoBitrate),
      AVVideoExpectedSourceFrameRateKey : @(fps),
      AVVideoMaxKeyFrameIntervalKey : @(fps * 2),
      AVVideoProfileLevelKey : AVVideoProfileLevelH264HighAutoLevel,
    },
  };
  _videoInput = [[AVAssetWriterInput alloc] initWithMediaType:AVMediaTypeVideo outputSettings:videoSettings];
  _videoInput.expectsMediaDataInRealTime = YES;
  // Buffers come in sensor orientation; store the display rotation as the track transform
  // (same idea as MediaMuxer.setOrientationHint on Android).
  _videoInput.transform = CGAffineTransformMakeRotation((CGFloat)(_rotation * M_PI / 180.0));
  _adaptor = [[AVAssetWriterInputPixelBufferAdaptor alloc] initWithAssetWriterInput:_videoInput
                                                         sourcePixelBufferAttributes:nil];
  if (![_writer canAddInput:_videoInput]) return @"Cannot add video input";
  [_writer addInput:_videoInput];

  // AAC mono; AVAssetWriterInput resamples if the mic runs at another rate.
  NSDictionary *audioSettings = @{
    AVFormatIDKey : @(kAudioFormatMPEG4AAC),
    AVSampleRateKey : @(kAudioOutputSampleRate),
    AVNumberOfChannelsKey : @1,
    AVEncoderBitRateKey : @(audioBitrate),
  };
  _audioInput = [[AVAssetWriterInput alloc] initWithMediaType:AVMediaTypeAudio outputSettings:audioSettings];
  _audioInput.expectsMediaDataInRealTime = YES;
  if ([_writer canAddInput:_audioInput]) {
    [_writer addInput:_audioInput];
  } else {
    NSLog(@"[WebrtcRecorder] cannot add audio input — segment is video only");
    _audioInput = nil;
  }

  if (![_writer startWriting]) return _writer.error.localizedDescription ?: @"startWriting failed";
  [_writer startSessionAtSourceTime:CMTimeMake(_startNs, NSEC_PER_SEC)];
  return nil;
}

#pragma mark - Video

- (BOOL)appendPixelBuffer:(CVPixelBufferRef)pixelBuffer ptsNs:(int64_t)ptsNs {
  if (_failure != nil || _videoClosed || ptsNs <= _lastVideoNs || ptsNs < _startNs ||
      !_videoInput.isReadyForMoreMediaData) {
    _droppedVideo++;
    return NO;
  }
  if (![_adaptor appendPixelBuffer:pixelBuffer withPresentationTime:CMTimeMake(ptsNs, NSEC_PER_SEC)]) {
    _failure = _writer.error.localizedDescription ?: @"appendPixelBuffer failed";
    NSLog(@"[WebrtcRecorder] video append failed: %@", _failure);
    _droppedVideo++;
    return NO;
  }
  _lastVideoNs = ptsNs;
  _videoFrames++;
  return YES;
}

- (void)closeVideo {
  if (_videoClosed) return;
  _videoClosed = YES;
  [_videoInput markAsFinished];
}

#pragma mark - Audio

- (void)appendPCM:(const int16_t *)samples
           frames:(UInt32)frames
       sampleRate:(double)rate
            ptsNs:(int64_t)ptsNs
          limitNs:(int64_t)limitNs {
  if (_failure != nil || _finished || _audioInput == nil || rate <= 0 || frames == 0) return;

  // Trim the head that precedes the session start.
  UInt32 skip = 0;
  if (ptsNs < _startNs) {
    double s = ceil((double)(_startNs - ptsNs) * rate / 1e9);
    if (s >= frames) return;
    skip = (UInt32)s;
    ptsNs += (int64_t)llround(skip * 1e9 / rate);
  }
  UInt32 count = frames - skip;

  // Snap to the previous buffer's end when within jitter; drop genuine overlaps.
  if (_audioEndNs >= 0) {
    int64_t delta = ptsNs - _audioEndNs;
    if (llabs(delta) <= kAudioJoinToleranceNs) {
      ptsNs = _audioEndNs;
    } else if (delta < 0) {
      _droppedAudio++;
      return;
    }
  }

  // Trim the tail at/after the segment boundary (handed to the next segment instead).
  if (limitNs >= 0) {
    if (ptsNs >= limitNs) return;
    double maxCount = floor((double)(limitNs - ptsNs) * rate / 1e9);
    if (maxCount < count) count = (UInt32)MAX(0.0, maxCount);
    if (count == 0) return;
  }

  if (![self ensureAudioFormatForRate:rate] || !_audioInput.isReadyForMoreMediaData) {
    _droppedAudio++;
    return;
  }

  size_t length = count * sizeof(int16_t);
  CMBlockBufferRef block = NULL;
  OSStatus status = CMBlockBufferCreateWithMemoryBlock(kCFAllocatorDefault, NULL, length, kCFAllocatorDefault,
                                                       NULL, 0, length, kCMBlockBufferAssureMemoryNowFlag, &block);
  if (status == noErr) status = CMBlockBufferReplaceDataBytes(samples + skip, block, 0, length);
  CMSampleBufferRef sample = NULL;
  if (status == noErr) {
    status = CMAudioSampleBufferCreateReadyWithPacketDescriptions(
        kCFAllocatorDefault, block, _audioFormat, count, CMTimeMake(ptsNs, NSEC_PER_SEC), NULL, &sample);
  }
  if (block != NULL) CFRelease(block);
  if (status != noErr || sample == NULL) {
    _droppedAudio++;
    return;
  }
  BOOL ok = [_audioInput appendSampleBuffer:sample];
  CFRelease(sample);
  if (!ok) {
    _failure = _writer.error.localizedDescription ?: @"audio appendSampleBuffer failed";
    NSLog(@"[WebrtcRecorder] audio append failed: %@", _failure);
    return;
  }
  if (_firstAudioNs < 0) _firstAudioNs = ptsNs;
  _audioEndNs = ptsNs + (int64_t)llround(count * 1e9 / rate);
  _audioFrames += count;
}

- (BOOL)ensureAudioFormatForRate:(double)rate {
  if (_audioFormat != NULL && _audioFormatRate == rate) return YES;
  if (_audioFormat != NULL) {
    CFRelease(_audioFormat);
    _audioFormat = NULL;
  }
  AudioStreamBasicDescription asbd = {
      .mSampleRate = rate,
      .mFormatID = kAudioFormatLinearPCM,
      .mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
      .mBytesPerPacket = 2,
      .mFramesPerPacket = 1,
      .mBytesPerFrame = 2,
      .mChannelsPerFrame = 1,
      .mBitsPerChannel = 16,
  };
  if (CMAudioFormatDescriptionCreate(kCFAllocatorDefault, &asbd, 0, NULL, 0, NULL, NULL, &_audioFormat) != noErr) {
    _audioFormat = NULL;
    return NO;
  }
  _audioFormatRate = rate;
  return YES;
}

#pragma mark - Finish

- (void)finishAtNs:(int64_t)endNs completion:(void (^)(BOOL))completion {
  if (_finished) {
    completion(_writer.status == AVAssetWriterStatusCompleted);
    return;
  }
  _finished = YES;
  [self closeVideo];
  [_audioInput markAsFinished];
  AVAssetWriter *writer = _writer;
  if (writer.status != AVAssetWriterStatusWriting) {
    NSLog(@"[WebrtcRecorder] segment %@ not writing (status %ld): %@", _url.lastPathComponent,
          (long)writer.status, writer.error);
    completion(NO);
    return;
  }
  [writer endSessionAtSourceTime:CMTimeMake(MAX(endNs, _startNs + 1), NSEC_PER_SEC)];
  [writer finishWritingWithCompletionHandler:^{
    BOOL ok = writer.status == AVAssetWriterStatusCompleted;
    if (!ok) NSLog(@"[WebrtcRecorder] finishWriting failed: %@", writer.error);
    completion(ok);
  }];
}

- (void)cancel {
  _finished = YES;
  if (_writer.status == AVAssetWriterStatusWriting) [_writer cancelWriting];
  [[NSFileManager defaultManager] removeItemAtURL:_url error:nil];
}

@end
