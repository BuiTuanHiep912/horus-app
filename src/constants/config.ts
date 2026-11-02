/**
 * Application Configuration Constants
 */

// Camera Configuration
export const CAMERA_PHOTO_QUALITY = 0.8; // 0-1

// Video Recording Configuration
export const CAMERA_VIDEO_MAX_DURATION = 60; // giây tối đa cho một đoạn quay
export const CAMERA_VIDEO_MAX_FILE_SIZE = 1_000_000_000; // byte — dưới giới hạn 1 GiB của server

// Android WebRTC Track Recorder (modules/webrtc-recorder)
// Khi bật (mặc định trên Android): một getUserMedia 1080p30 vừa phát preview bitrate thấp vừa
// ghi MP4 full-quality từ raw frames, không cần dừng preview khi quay.
// Đặt false để quay về nhánh fallback expo-camera (tạm dừng preview khi quay).
export const USE_WEBRTC_RECORDER_ON_ANDROID = true;
export const WEBRTC_RECORDER_VIDEO_WIDTH = 1920;
export const WEBRTC_RECORDER_VIDEO_HEIGHT = 1080;
export const WEBRTC_RECORDER_FPS = 30;
export const WEBRTC_RECORDER_VIDEO_BITRATE = 6_000_000; // 6 Mbps H.264 1080p30
export const WEBRTC_RECORDER_AUDIO_BITRATE = 128_000; // 128 kbps AAC
export const WEBRTC_RECORDER_SEGMENT_SECONDS = 20;
export const WEBRTC_PREVIEW_MAX_BITRATE = 300_000; // ~300 kbps cho preview SFU
export const WEBRTC_PREVIEW_SCALE_DOWN_BY = 2; // 1080p -> 540p cho preview

// Logging
export const LOG_LEVEL = __DEV__ ? 'debug' : 'info'; // 'debug', 'info', 'warn', 'error'
export const LOG_PREFIX = '[REMOTE_APP]';
