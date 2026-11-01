#import "WRFrameProbe.h"
#import "WRTrackRecorder+Private.h"

#import <QuartzCore/QuartzCore.h>
#import <WebRTC/WebRTC.h>
#import <react-native-webrtc/ProcessorProvider.h>
#import <react-native-webrtc/VideoFrameProcessor.h>

static NSString *const kProcessorName = @"webrtcRecorderProbe";

#pragma mark - Stats

/// Counts what the frame tap receives. `onFrame` runs on the capture queue; `tick`/`summary`
/// run on the module's ticker queue. One short @synchronized block per frame.
@interface WRFrameStats : NSObject
- (void)reset;
- (void)onFrame:(RTCVideoFrame *)frame;
- (NSDictionary<NSString *, id> *)tick;
- (NSDictionary<NSString *, id> *)summary;
@end

@implementation WRFrameStats {
  // Current 1 s window
  NSInteger _windowFrames;
  CFTimeInterval _windowStart;
  int64_t _windowMaxGapNs;

  // Last frame seen
  int _width;
  int _height;
  int _rotation;
  int64_t _lastTimestampNs;

  // Whole session
  CFTimeInterval _sessionStart;
  int64_t _totalFrames;
  int64_t _sessionMaxGapNs;
  NSMutableDictionary<NSString *, NSNumber *> *_framesPerResolution;
}

- (instancetype)init {
  if ((self = [super init])) {
    _framesPerResolution = [NSMutableDictionary dictionary];
    [self reset];
  }
  return self;
}

- (void)reset {
  @synchronized(self) {
    CFTimeInterval now = CACurrentMediaTime();
    _windowFrames = 0;
    _windowStart = now;
    _windowMaxGapNs = 0;
    _width = 0;
    _height = 0;
    _rotation = 0;
    _lastTimestampNs = -1;
    _sessionStart = now;
    _totalFrames = 0;
    _sessionMaxGapNs = 0;
    [_framesPerResolution removeAllObjects];
  }
}

- (void)onFrame:(RTCVideoFrame *)frame {
  // Buffer size is the unrotated sensor-orientation size; rotation is reported separately
  // (same convention as the Android FrameStats).
  int w = frame.width;
  int h = frame.height;
  int64_t ts = frame.timeStampNs;
  @synchronized(self) {
    _windowFrames++;
    _totalFrames++;
    if (_lastTimestampNs >= 0 && ts > _lastTimestampNs) {
      int64_t gap = ts - _lastTimestampNs;
      if (gap > _windowMaxGapNs) _windowMaxGapNs = gap;
      if (gap > _sessionMaxGapNs) _sessionMaxGapNs = gap;
    }
    _lastTimestampNs = ts;
    _width = w;
    _height = h;
    _rotation = (int)frame.rotation;
    NSString *key = [NSString stringWithFormat:@"%dx%d", w, h];
    _framesPerResolution[key] = @(_framesPerResolution[key].longLongValue + 1);
  }
}

- (NSDictionary<NSString *, id> *)tick {
  @synchronized(self) {
    CFTimeInterval now = CACurrentMediaTime();
    double seconds = MAX(0.001, now - _windowStart);
    NSDictionary *m = @{
      @"fps" : @(round(_windowFrames / seconds * 10.0) / 10.0),
      @"width" : @(_width),
      @"height" : @(_height),
      @"rotation" : @(_rotation),
      @"maxGapMs" : @(_windowMaxGapNs / 1e6),
      @"droppedFrames" : @0,
      @"totalFrames" : @(_totalFrames),
      @"rawFrames" : @YES,
    };
    _windowFrames = 0;
    _windowStart = now;
    _windowMaxGapNs = 0;
    return m;
  }
}

- (NSDictionary<NSString *, id> *)summary {
  @synchronized(self) {
    double durationMs = (CACurrentMediaTime() - _sessionStart) * 1000.0;
    double avgFps = durationMs > 0 ? round(_totalFrames * 10000.0 / durationMs) / 10.0 : 0.0;
    return @{
      @"durationMs" : @(durationMs),
      @"totalFrames" : @(_totalFrames),
      @"avgFps" : @(avgFps),
      @"maxGapMs" : @(_sessionMaxGapNs / 1e6),
      @"droppedFrames" : @0,
      @"framesPerResolution" : [_framesPerResolution copy],
      @"rawFrames" : @YES,
    };
  }
}

@end

#pragma mark - Processor

@interface WRProbeProcessor : NSObject <VideoFrameProcessorDelegate>
@property(nonatomic, strong, readonly) WRFrameStats *stats;
/// Set/cleared from the module (JS thread); read on the capture queue for every frame.
@property(atomic, strong, nullable) WRTrackRecorder *activeRecorder;
@end

@implementation WRProbeProcessor

- (instancetype)init {
  if ((self = [super init])) {
    _stats = [WRFrameStats new];
  }
  return self;
}

- (RTCVideoFrame *)capturer:(RTCVideoCapturer *)capturer didCaptureVideoFrame:(RTCVideoFrame *)frame {
  [_stats onFrame:frame];
  [self.activeRecorder appendFrame:frame];
  return frame;
}

@end

#pragma mark - Bridge

@implementation WRFrameProbe

+ (WRProbeProcessor *)processor {
  static WRProbeProcessor *instance;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    instance = [WRProbeProcessor new];
  });
  return instance;
}

+ (NSString *)processorName {
  return kProcessorName;
}

+ (void)registerProcessor {
  [ProcessorProvider addProcessor:[self processor] forName:kProcessorName];
}

+ (void)reset {
  [[self processor].stats reset];
}

+ (NSDictionary<NSString *, id> *)tick {
  return [[self processor].stats tick];
}

+ (NSDictionary<NSString *, id> *)summary {
  return [[self processor].stats summary];
}

+ (void)setActiveRecorder:(nullable WRTrackRecorder *)recorder {
  [self processor].activeRecorder = recorder;
}

+ (nullable WRTrackRecorder *)activeRecorder {
  return [self processor].activeRecorder;
}

@end
