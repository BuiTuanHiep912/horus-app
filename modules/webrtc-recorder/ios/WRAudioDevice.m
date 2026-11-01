#import "WRAudioDevice.h"
#import "WRFrameProbe.h"
#import "WRTrackRecorder+Private.h"

#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <WebRTC/WebRTC.h>
#import <mach/mach_time.h>
#import <react-native-webrtc/WebRTCModuleOptions.h>

static const double kPreferredSampleRate = 48000.0;
static const NSTimeInterval kPreferredIOBufferDuration = 0.01;  // 10 ms, what WebRTC expects
static const UInt32 kMaxFramesPerSlice = 4096;
static const AudioUnitElement kInputBus = 1;
static const AudioUnitElement kOutputBus = 0;

static int64_t WRHostTimeToNs(UInt64 hostTime) {
  static mach_timebase_info_data_t timebase;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    mach_timebase_info(&timebase);
  });
  return (int64_t)((__uint128_t)hostTime * timebase.numer / timebase.denom);
}

@interface WRAudioDevice () <RTCAudioDevice>
@end

@implementation WRAudioDevice {
  id<RTCAudioDeviceDelegate> _delegate;
  AudioUnit _audioUnit;
  double _sampleRate;
  NSTimeInterval _ioBufferDuration;

  // Render buffer, only touched on the audio IO thread.
  int16_t *_samples;
  AudioBufferList _bufferList;

  BOOL _initialized;
  BOOL _recordingInitialized;
  BOOL _recording;
  BOOL _playoutInitialized;
  BOOL _playing;
}

#pragma mark - Install

+ (instancetype)shared {
  static WRAudioDevice *instance;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    instance = [WRAudioDevice new];
  });
  return instance;
}

+ (void)load {
  // Runs before main(), so it always precedes react-native-webrtc's WebRTCModule -init.
  [WebRTCModuleOptions sharedInstance].audioDevice = [self shared];
}

+ (BOOL)isInstalled {
  return [WebRTCModuleOptions sharedInstance].audioDevice == (id<RTCAudioDevice>)[self shared];
}

- (instancetype)init {
  if ((self = [super init])) {
    _sampleRate = kPreferredSampleRate;
    _ioBufferDuration = kPreferredIOBufferDuration;
    _samples = calloc(kMaxFramesPerSlice, sizeof(int16_t));
  }
  return self;
}

- (void)dealloc {
  free(_samples);
}

#pragma mark - RTCAudioDevice: properties

- (double)deviceInputSampleRate {
  return _sampleRate;
}

- (NSTimeInterval)inputIOBufferDuration {
  return _ioBufferDuration;
}

- (NSInteger)inputNumberOfChannels {
  return 1;
}

- (NSTimeInterval)inputLatency {
  return [AVAudioSession sharedInstance].inputLatency;
}

- (double)deviceOutputSampleRate {
  return _sampleRate;
}

- (NSTimeInterval)outputIOBufferDuration {
  return _ioBufferDuration;
}

- (NSInteger)outputNumberOfChannels {
  return 1;
}

- (NSTimeInterval)outputLatency {
  return 0;
}

- (BOOL)isInitialized {
  return _initialized;
}

- (BOOL)isPlayoutInitialized {
  return _playoutInitialized;
}

- (BOOL)isPlaying {
  return _playing;
}

- (BOOL)isRecordingInitialized {
  return _recordingInitialized;
}

- (BOOL)isRecording {
  return _recording;
}

#pragma mark - RTCAudioDevice: lifecycle

- (BOOL)initializeWithDelegate:(id<RTCAudioDeviceDelegate>)delegate {
  _delegate = delegate;
  _initialized = YES;
  NSLog(@"[WebrtcRecorder] audio device initialized");
  return YES;
}

- (BOOL)terminateDevice {
  [self stopRecording];
  [self disposeAudioUnit];
  _playoutInitialized = NO;
  _playing = NO;
  _recordingInitialized = NO;
  _initialized = NO;
  _delegate = nil;
  return YES;
}

// Playout: Remote phones never render received audio, so these only track state.
- (BOOL)initializePlayout {
  _playoutInitialized = YES;
  return YES;
}

- (BOOL)startPlayout {
  _playing = YES;
  return YES;
}

- (BOOL)stopPlayout {
  _playing = NO;
  return YES;
}

- (BOOL)initializeRecording {
  if (_recordingInitialized) return YES;
  if (![self configureAudioSession]) return NO;
  if (![self createAudioUnit]) return NO;
  _recordingInitialized = YES;
  return YES;
}

- (BOOL)startRecording {
  if (_recording) return YES;
  if (!_recordingInitialized && ![self initializeRecording]) return NO;
  OSStatus status = AudioOutputUnitStart(_audioUnit);
  if (status != noErr) {
    NSLog(@"[WebrtcRecorder] AudioOutputUnitStart failed %d", (int)status);
    return NO;
  }
  _recording = YES;
  NSLog(@"[WebrtcRecorder] mic started %.0f Hz, io %.3f s", _sampleRate, _ioBufferDuration);
  return YES;
}

- (BOOL)stopRecording {
  if (_recording && _audioUnit != NULL) {
    AudioOutputUnitStop(_audioUnit);
  }
  _recording = NO;
  [self disposeAudioUnit];
  _recordingInitialized = NO;
  return YES;
}

#pragma mark - Audio session + unit

- (BOOL)configureAudioSession {
  AVAudioSession *session = [AVAudioSession sharedInstance];
  NSError *error = nil;
  // VideoRecording mode: wide-band mic tuned for recording, no voice-chat ducking/processing.
  // WebRTC still runs its own software echo/noise processing on the preview stream.
  if (![session setCategory:AVAudioSessionCategoryPlayAndRecord
                       mode:AVAudioSessionModeVideoRecording
                    options:AVAudioSessionCategoryOptionDefaultToSpeaker |
                            AVAudioSessionCategoryOptionAllowBluetoothHFP
                      error:&error]) {
    NSLog(@"[WebrtcRecorder] setCategory failed: %@", error);
    return NO;
  }
  [session setPreferredSampleRate:kPreferredSampleRate error:nil];
  [session setPreferredIOBufferDuration:kPreferredIOBufferDuration error:nil];
  [session setPreferredInputNumberOfChannels:1 error:nil];
  if (![session setActive:YES error:&error]) {
    NSLog(@"[WebrtcRecorder] setActive failed: %@", error);
    return NO;
  }

  double rate = session.sampleRate > 0 ? session.sampleRate : kPreferredSampleRate;
  NSTimeInterval io = session.IOBufferDuration > 0 ? session.IOBufferDuration : kPreferredIOBufferDuration;
  BOOL changed = rate != _sampleRate || io != _ioBufferDuration;
  _sampleRate = rate;
  _ioBufferDuration = io;
  if (changed) {
    [_delegate notifyAudioInputParametersChange];
  }
  return YES;
}

- (BOOL)createAudioUnit {
  if (_audioUnit != NULL) return YES;

  AudioComponentDescription desc = {
      .componentType = kAudioUnitType_Output,
      .componentSubType = kAudioUnitSubType_RemoteIO,
      .componentManufacturer = kAudioUnitManufacturer_Apple,
  };
  AudioComponent component = AudioComponentFindNext(NULL, &desc);
  if (component == NULL || AudioComponentInstanceNew(component, &_audioUnit) != noErr) {
    NSLog(@"[WebrtcRecorder] cannot create RemoteIO unit");
    _audioUnit = NULL;
    return NO;
  }

  UInt32 enable = 1;
  UInt32 disable = 0;
  AudioUnitSetProperty(_audioUnit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input,
                       kInputBus, &enable, sizeof(enable));
  AudioUnitSetProperty(_audioUnit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output,
                       kOutputBus, &disable, sizeof(disable));

  AudioStreamBasicDescription format = {
      .mSampleRate = _sampleRate,
      .mFormatID = kAudioFormatLinearPCM,
      .mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
      .mBytesPerPacket = 2,
      .mFramesPerPacket = 1,
      .mBytesPerFrame = 2,
      .mChannelsPerFrame = 1,
      .mBitsPerChannel = 16,
  };
  // Format of the data the mic side hands us (output scope of the input bus).
  AudioUnitSetProperty(_audioUnit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output,
                       kInputBus, &format, sizeof(format));

  UInt32 maxFrames = kMaxFramesPerSlice;
  AudioUnitSetProperty(_audioUnit, kAudioUnitProperty_MaximumFramesPerSlice,
                       kAudioUnitScope_Global, 0, &maxFrames, sizeof(maxFrames));

  AURenderCallbackStruct callback = {.inputProc = WRInputCallback,
                                     .inputProcRefCon = (__bridge void *)self};
  AudioUnitSetProperty(_audioUnit, kAudioOutputUnitProperty_SetInputCallback,
                       kAudioUnitScope_Global, kInputBus, &callback, sizeof(callback));

  OSStatus status = AudioUnitInitialize(_audioUnit);
  if (status != noErr) {
    NSLog(@"[WebrtcRecorder] AudioUnitInitialize failed %d", (int)status);
    [self disposeAudioUnit];
    return NO;
  }
  return YES;
}

- (void)disposeAudioUnit {
  if (_audioUnit == NULL) return;
  AudioUnitUninitialize(_audioUnit);
  AudioComponentInstanceDispose(_audioUnit);
  _audioUnit = NULL;
}

#pragma mark - IO thread

static OSStatus WRInputCallback(void *refCon,
                                AudioUnitRenderActionFlags *flags,
                                const AudioTimeStamp *timestamp,
                                UInt32 bus,
                                UInt32 frames,
                                AudioBufferList *unused) {
  WRAudioDevice *device = (__bridge WRAudioDevice *)refCon;
  return [device onInput:flags timestamp:timestamp bus:bus frames:frames];
}

- (OSStatus)onInput:(AudioUnitRenderActionFlags *)flags
          timestamp:(const AudioTimeStamp *)timestamp
                bus:(UInt32)bus
             frames:(UInt32)frames {
  if (frames > kMaxFramesPerSlice) return kAudio_ParamError;

  _bufferList.mNumberBuffers = 1;
  _bufferList.mBuffers[0].mNumberChannels = 1;
  _bufferList.mBuffers[0].mDataByteSize = frames * sizeof(int16_t);
  _bufferList.mBuffers[0].mData = _samples;

  OSStatus status = AudioUnitRender(_audioUnit, flags, timestamp, bus, frames, &_bufferList);
  if (status != noErr) return status;

  // 1) Live preview: hand the samples to WebRTC exactly as captured.
  id<RTCAudioDeviceDelegate> delegate = _delegate;
  if (delegate != nil) {
    delegate.deliverRecordedData(flags, timestamp, bus, frames, &_bufferList, NULL, nil);
  }

  // 2) Recorder tap: same samples, stamped with the host clock the camera frames also use.
  WRTrackRecorder *recorder = [WRFrameProbe activeRecorder];
  if (recorder != nil && (timestamp->mFlags & kAudioTimeStampHostTimeValid)) {
    [recorder appendAudioSamples:_samples
                          frames:frames
                      sampleRate:_sampleRate
                      hostTimeNs:WRHostTimeToNs(timestamp->mHostTime)];
  }
  return noErr;
}

@end
