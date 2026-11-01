#import "WRTrackRecorder.h"

@class RTCVideoFrame;

NS_ASSUME_NONNULL_BEGIN

/// Internal API used by the frame tap (WRFrameProbe.m). Kept out of the public header so the
/// module umbrella header does not pull in WebRTC types.
@interface WRTrackRecorder ()

/// Called on the WebRTC capture queue for every camera frame. Never blocks.
- (void)appendFrame:(RTCVideoFrame *)frame;

/// Called on the audio IO thread (WRAudioDevice) for every mic buffer: mono PCM16.
/// `hostTimeNs` is the capture time of the first sample on the host clock — the same clock as
/// `RTCVideoFrame.timeStampNs` from the camera capturer. Copies the samples and returns.
- (void)appendAudioSamples:(const int16_t *)samples
                    frames:(UInt32)frames
                sampleRate:(double)sampleRate
                hostTimeNs:(int64_t)hostTimeNs;

@end

NS_ASSUME_NONNULL_END
