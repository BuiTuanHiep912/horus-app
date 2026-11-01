#import "WRTrackRecorder+Private.h"

#import <AVFoundation/AVFoundation.h>
#import <WebRTC/WebRTC.h>

static NSString *const kErrorDomain = @"WebrtcRecorder";
static const double kAudioOutputSampleRate = 48000.0;
// Audio buffers whose start is this close to the previous buffer's end are treated as contiguous,
// absorbing host-clock jitter so AVAssetWriter never sees tiny overlaps.
static const int64_t kAudioJoinToleranceNs = 2000000;  // 2 ms

@implementation WRTrackRecorder {
  dispatch_queue_t _queue;
  NSInteger _fps;
  NSInteger _videoBitrate;
  NSInteger _audioBitrate;

  // Writer state — only touched on _queue.
  AVAssetWriter *_writer;
  AVAssetWriterInput *_videoInput;
  AVAssetWriterInput *_audioInput;
  AVAssetWriterInputPixelBufferAdaptor *_adaptor;
  BOOL _stopping;
  NSString *_failure;

  // Video
  int32_t _width;
  int32_t _height;
  int _rotation;
  int64_t _firstPtsNs;
  int64_t _lastPtsNs;
  int64_t _frames;
  int64_t _dropped;

  // Audio
  CMAudioFormatDescriptionRef _audioFormat;
  double _audioFormatRate;
  int64_t _firstAudioPtsNs;
  int64_t _audioEndNs;
  int64_t _audioFrames;
  int64_t _audioDropped;
}

- (instancetype)initWithRecordingId:(NSString *)recordingId
                          outputURL:(NSURL *)outputURL
                                fps:(NSInteger)fps
                       videoBitrate:(NSInteger)videoBitrate
                       audioBitrate:(NSInteger)audioBitrate {
  if ((self = [super init])) {
    _recordingId = [recordingId copy];
    _outputURL = [outputURL copy];
    _fps = fps > 0 ? fps : 30;
    _videoBitrate = videoBitrate > 0 ? videoBitrate : 6000000;
    _audioBitrate = audioBitrate > 0 ? audioBitrate : 128000;
    _queue = dispatch_queue_create("webrtc-recorder.writer", DISPATCH_QUEUE_SERIAL);
    _firstPtsNs = -1;
    _lastPtsNs = -1;
    _firstAudioPtsNs = -1;
    _audioEndNs = -1;
  }
  return self;
}

- (void)dealloc {
  if (_audioFormat != NULL) CFRelease(_audioFormat);
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
    // Camera capturer always delivers CVPixelBuffers; anything else is unexpected.
    _dropped++;
    return;
  }
  RTCCVPixelBuffer *rtcBuffer = (RTCCVPixelBuffer *)frame.buffer;
  CVPixelBufferRef pixelBuffer = rtcBuffer.pixelBuffer;
  int32_t w = (int32_t)CVPixelBufferGetWidth(pixelBuffer);
  int32_t h = (int32_t)CVPixelBufferGetHeight(pixelBuffer);
  if (rtcBuffer.cropWidth != w || rtcBuffer.cropHeight != h) {
    // Cropped/adapted buffer: we only record full camera frames.
    _dropped++;
    return;
  }

  int64_t ptsNs = frame.timeStampNs;

  if (_writer == nil) {
    if (![self setUpWriterWithWidth:w height:h rotation:(int)frame.rotation]) return;
    // The first video frame defines t=0 of the file; earlier audio is trimmed.
    [_writer startSessionAtSourceTime:CMTimeMake(ptsNs, NSEC_PER_SEC)];
    _firstPtsNs = ptsNs;
  }

  if (w != _width || h != _height) {
    // Size changed mid-recording (e.g. camera switch to another format): the encoder is fixed
    // to the first size, so skip these frames.
    _dropped++;
    return;
  }
  if (ptsNs <= _lastPtsNs) {
    _dropped++;
    return;
  }
  if (!_videoInput.isReadyForMoreMediaData) {
    _dropped++;
    return;
  }
  if (![_adaptor appendPixelBuffer:pixelBuffer withPresentationTime:CMTimeMake(ptsNs, NSEC_PER_SEC)]) {
    _failure = _writer.error.localizedDescription ?: @"appendPixelBuffer failed";
    NSLog(@"[WebrtcRecorder] video append failed: %@", _failure);
    return;
  }
  _lastPtsNs = ptsNs;
  _frames++;
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
  // Nothing is written before the first video frame opens the session.
  if (_writer == nil || _stopping || _failure != nil || rate <= 0) return;

  // Trim the part of this buffer that precedes the session start (first video frame).
  UInt32 skip = 0;
  if (ptsNs < _firstPtsNs) {
    double skipped = ceil((double)(_firstPtsNs - ptsNs) * rate / 1e9);
    if (skipped >= frames) return;
    skip = (UInt32)skipped;
    ptsNs += (int64_t)llround(skip * 1e9 / rate);
  }
  UInt32 count = frames - skip;

  // Snap to the previous buffer's end when within jitter; drop genuine overlaps.
  if (_audioEndNs >= 0) {
    int64_t delta = ptsNs - _audioEndNs;
    if (llabs(delta) <= kAudioJoinToleranceNs) {
      ptsNs = _audioEndNs;
    } else if (delta < 0) {
      _audioDropped++;
      return;
    }
  }

  if (![self ensureAudioFormatForRate:rate]) return;
  if (!_audioInput.isReadyForMoreMediaData) {
    _audioDropped++;
    return;
  }

  size_t length = count * sizeof(int16_t);
  CMBlockBufferRef block = NULL;
  OSStatus status = CMBlockBufferCreateWithMemoryBlock(kCFAllocatorDefault, NULL, length, kCFAllocatorDefault,
                                                       NULL, 0, length, kCMBlockBufferAssureMemoryNowFlag, &block);
  if (status == noErr) {
    status = CMBlockBufferReplaceDataBytes((const int16_t *)pcm.bytes + skip, block, 0, length);
  }
  CMSampleBufferRef sample = NULL;
  if (status == noErr) {
    status = CMAudioSampleBufferCreateReadyWithPacketDescriptions(
        kCFAllocatorDefault, block, _audioFormat, count, CMTimeMake(ptsNs, NSEC_PER_SEC), NULL, &sample);
  }
  if (block != NULL) CFRelease(block);
  if (status != noErr || sample == NULL) {
    _audioDropped++;
    return;
  }

  BOOL ok = [_audioInput appendSampleBuffer:sample];
  CFRelease(sample);
  if (!ok) {
    _failure = _writer.error.localizedDescription ?: @"audio appendSampleBuffer failed";
    NSLog(@"[WebrtcRecorder] audio append failed: %@", _failure);
    return;
  }
  if (_firstAudioPtsNs < 0) _firstAudioPtsNs = ptsNs;
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

#pragma mark - Writer setup

- (BOOL)setUpWriterWithWidth:(int32_t)width height:(int32_t)height rotation:(int)rotation {
  [[NSFileManager defaultManager] removeItemAtURL:_outputURL error:nil];

  NSError *error = nil;
  _writer = [[AVAssetWriter alloc] initWithURL:_outputURL fileType:AVFileTypeMPEG4 error:&error];
  if (_writer == nil) {
    _failure = error.localizedDescription ?: @"Cannot create AVAssetWriter";
    return NO;
  }

  NSDictionary *videoSettings = @{
    AVVideoCodecKey : AVVideoCodecTypeH264,
    AVVideoWidthKey : @(width),
    AVVideoHeightKey : @(height),
    AVVideoCompressionPropertiesKey : @{
      AVVideoAverageBitRateKey : @(_videoBitrate),
      AVVideoExpectedSourceFrameRateKey : @(_fps),
      AVVideoMaxKeyFrameIntervalKey : @(_fps * 2),
      AVVideoProfileLevelKey : AVVideoProfileLevelH264HighAutoLevel,
    },
  };
  _videoInput = [[AVAssetWriterInput alloc] initWithMediaType:AVMediaTypeVideo outputSettings:videoSettings];
  _videoInput.expectsMediaDataInRealTime = YES;
  // Buffers come in sensor orientation; store the display rotation as the track transform
  // (same idea as MediaMuxer.setOrientationHint on Android). Fixed at the first frame.
  _videoInput.transform = CGAffineTransformMakeRotation((CGFloat)(rotation * M_PI / 180.0));

  _adaptor = [[AVAssetWriterInputPixelBufferAdaptor alloc] initWithAssetWriterInput:_videoInput
                                                         sourcePixelBufferAttributes:nil];
  if (![_writer canAddInput:_videoInput]) {
    _failure = @"Cannot add video input";
    return NO;
  }
  [_writer addInput:_videoInput];

  // AAC mono; AVAssetWriterInput resamples if the mic runs at another rate.
  NSDictionary *audioSettings = @{
    AVFormatIDKey : @(kAudioFormatMPEG4AAC),
    AVSampleRateKey : @(kAudioOutputSampleRate),
    AVNumberOfChannelsKey : @1,
    AVEncoderBitRateKey : @(_audioBitrate),
  };
  _audioInput = [[AVAssetWriterInput alloc] initWithMediaType:AVMediaTypeAudio outputSettings:audioSettings];
  _audioInput.expectsMediaDataInRealTime = YES;
  if ([_writer canAddInput:_audioInput]) {
    [_writer addInput:_audioInput];
  } else {
    NSLog(@"[WebrtcRecorder] cannot add audio input — recording video only");
    _audioInput = nil;
  }

  if (![_writer startWriting]) {
    _failure = _writer.error.localizedDescription ?: @"startWriting failed";
    return NO;
  }
  _width = width;
  _height = height;
  _rotation = rotation;
  NSLog(@"[WebrtcRecorder] writer started %dx%d rot=%d -> %@", width, height, rotation, _outputURL.path);
  return YES;
}

#pragma mark - Stop

- (void)stopWithCompletion:(void (^)(NSDictionary<NSString *, id> *_Nullable, NSError *_Nullable))completion {
  dispatch_async(_queue, ^{
    self->_stopping = YES;
    AVAssetWriter *writer = self->_writer;

    if (writer == nil || self->_frames == 0) {
      [writer cancelWriting];
      [[NSFileManager defaultManager] removeItemAtURL:self->_outputURL error:nil];
      NSString *msg = self->_failure ?: @"No video frames were recorded";
      completion(nil, [NSError errorWithDomain:kErrorDomain code:1 userInfo:@{NSLocalizedDescriptionKey : msg}]);
      return;
    }

    [self->_videoInput markAsFinished];
    [self->_audioInput markAsFinished];
    // Video defines the file length; trailing audio past the last frame is cut.
    [writer endSessionAtSourceTime:CMTimeMake(self->_lastPtsNs, NSEC_PER_SEC)];
    [writer finishWritingWithCompletionHandler:^{
      dispatch_async(self->_queue, ^{
        if (writer.status != AVAssetWriterStatusCompleted) {
          NSString *msg = writer.error.localizedDescription ?: @"finishWriting failed";
          completion(nil, [NSError errorWithDomain:kErrorDomain code:2 userInfo:@{NSLocalizedDescriptionKey : msg}]);
          return;
        }
        NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:self->_outputURL.path error:nil];
        double durationMs = (self->_lastPtsNs - self->_firstPtsNs) / 1e6;
        double audioOffsetMs =
            self->_firstAudioPtsNs >= 0 ? (self->_firstAudioPtsNs - self->_firstPtsNs) / 1e6 : -1;
        NSDictionary *result = @{
          @"uri" : self->_outputURL.absoluteString,
          @"durationMs" : @(durationMs),
          @"size" : @([attrs fileSize]),
          @"frames" : @(self->_frames),
          @"droppedFrames" : @(self->_dropped),
          @"width" : @(self->_width),
          @"height" : @(self->_height),
          @"rotation" : @(self->_rotation),
          @"audioFrames" : @(self->_audioFrames),
          @"audioDroppedBuffers" : @(self->_audioDropped),
          @"audioSampleRate" : @(self->_audioFormatRate),
          @"audioStartOffsetMs" : @(audioOffsetMs),
        };
        NSLog(@"[WebrtcRecorder] finished %@", result);
        completion(result, nil);
      });
    }];
  });
}

@end
