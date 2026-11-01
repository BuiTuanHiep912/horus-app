Pod::Spec.new do |s|
  s.name           = 'WebrtcRecorder'
  s.version        = '0.1.0'
  s.summary        = 'Records a react-native-webrtc camera track to MP4 (iOS)'
  s.description    = 'iOS side of the local webrtc-recorder Expo module: taps raw camera frames via react-native-webrtc ProcessorProvider.'
  s.author         = ''
  s.homepage       = 'https://github.com/blackcat2005/horus-app'
  s.license        = 'UNLICENSED'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'react-native-webrtc'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,swift}'
  # Only the Foundation-only bridge header is public: it becomes part of the module's umbrella
  # header so Swift can see it, without leaking non-modular react-native-webrtc headers.
  s.public_header_files = ['WRFrameProbe.h', 'WRTrackRecorder.h', 'WRAudioDevice.h', 'WRStitcher.h']
  s.frameworks = 'AVFoundation', 'AudioToolbox', 'CoreMedia'
end
