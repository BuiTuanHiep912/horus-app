/**
 * Streaming Service
 * Quay video local (nguồn dữ liệu chính) và upload sau khi dừng quay.
 * Giữ room/session hiện tại để gắn metadata khi upload, và telemetry recording/upload cho sync_device.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import {
  WebrtcRecorder,
  recoverOrphanedRecordings,
  start as startWebrtcRecorder,
  stop as stopWebrtcRecorder,
} from '../../modules/webrtc-recorder';
import {
  CAMERA_VIDEO_MAX_DURATION,
  USE_WEBRTC_RECORDER_ON_ANDROID,
  WEBRTC_RECORDER_AUDIO_BITRATE,
  WEBRTC_RECORDER_FPS,
  WEBRTC_RECORDER_SEGMENT_SECONDS,
  WEBRTC_RECORDER_VIDEO_BITRATE,
  WEBRTC_RECORDER_VIDEO_HEIGHT,
  WEBRTC_RECORDER_VIDEO_WIDTH,
} from '../constants/config';
import { deleteFile } from '../utils/file';
import { logger } from '../utils/logger';
import { cameraService } from './camera';
import type { DeviceSyncTelemetry } from './deviceSync';
import { localStore } from './localStore';
import { mediasoupClientService } from './mediasoupClient';
import { uploadService } from './upload';

const WEBRTC_REC_CACHE_SUBDIR = 'webrtc_recordings';

class StreamingService {
  private deviceId: string = '';
  private isStoppingRecording: boolean = false;
  private lastUploadedUri: string | null = null;
  private currentRoomId: string | null = null;
  private currentSessionId: string | null = null;
  private recordingStartedAt: number | null = null;
  private recordingDurationMs: number | null = null;
  private deviceModel: string = '';
  private cameraName: string = 'Remote Camera';
  private telemetry: DeviceSyncTelemetry = {};
  private activeWebrtcRecordingId: string | null = null;

  /**
   * Khởi tạo streaming service
   */
  public initialize(
    deviceId: string,
    extra?: { deviceModel?: string; cameraName?: string; roomId?: string },
  ): void {
    this.deviceId = deviceId;
    if (extra?.deviceModel) this.deviceModel = extra.deviceModel;
    if (extra?.cameraName) this.cameraName = extra.cameraName;
    if (extra?.roomId) this.currentRoomId = extra.roomId;
    logger.info('StreamingService initialized', {
      deviceId,
      roomId: this.currentRoomId,
      model: this.deviceModel,
      cameraName: this.cameraName,
    });
  }

  /**
   * Gán room_id của phòng remote đang tham gia (để folder tên trên MinIO theo cấu trúc room_id/session_time)
   */
  public setActiveRoom(roomId: string | null): void {
    this.currentRoomId = roomId;
    logger.info('StreamingService active room updated', { roomId });
  }

  /**
   * Gán session_id từ lệnh start_record của Controller (gọi khi nhận pending_commands).
   * Session này sẽ được dùng để gom tất cả video của 1 lần "Start All" vào cùng 1 folder trên MinIO.
   */
  public setActiveSession(sessionId: string | null): void {
    this.currentSessionId = sessionId;
    logger.info('StreamingService active session updated', { sessionId });
  }

  /** Telemetry recording/upload gửi kèm sync_device */
  public getTelemetry(): DeviceSyncTelemetry {
    return this.telemetry;
  }

  /** True nếu có thể ghi trực tiếp từ track WebRTC trên Android (không cần dừng preview). */
  public canUseWebrtcTrackRecorder(): boolean {
    return (
      Platform.OS === 'android' &&
      USE_WEBRTC_RECORDER_ON_ANDROID &&
      WebrtcRecorder != null
    );
  }

  public isWebrtcTrackRecording(): boolean {
    return this.activeWebrtcRecordingId != null;
  }

  public isAnyRecording(): boolean {
    return this.activeWebrtcRecordingId != null || cameraService.isVideoRecording_();
  }

  private getWebrtcRecorderOutputDir(): string {
    const base = FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? '';
    return `${base}${WEBRTC_REC_CACHE_SUBDIR}`;
  }

  /**
   * M3 crash recovery: khi app mở lại sau khi bị kill giữa chừng, ghép các segment đã finalize
   * trong thư mục tạm thành 1 file MP4 và đưa vào tab Files (localStore) để người dùng xem/upload.
   */
  public async recoverCrashedRecordings(): Promise<number> {
    if (!this.canUseWebrtcTrackRecorder()) return 0;
    try {
      const list = await recoverOrphanedRecordings(this.getWebrtcRecorderOutputDir());
      let count = 0;
      for (const item of list) {
        const saved = await localStore.saveCapturedMedia(item.uri, 'video');
        if (saved) {
          count++;
          await deleteFile(item.uri);
        }
      }
      if (count > 0) {
        logger.info('Recovered crashed WebRTC recordings into localStore', { count });
      }
      return count;
    } catch (e) {
      logger.warn('recoverCrashedRecordings failed', e);
      return 0;
    }
  }

  /**
   * Bắt đầu ghi MP4 trực tiếp từ track camera WebRTC đang phát preview (M4).
   */
  public async startWebrtcTrackRecording(): Promise<boolean> {
    if (this.isAnyRecording()) {
      logger.warn('Recording already in progress');
      return false;
    }
    const videoTrack = mediasoupClientService.getLocalVideoTrack();
    if (!videoTrack || !this.canUseWebrtcTrackRecorder()) {
      logger.warn('startWebrtcTrackRecording: no active WebRTC videoTrack or module unavailable');
      return false;
    }
    try {
      mediasoupClientService.attachRecorderTap(videoTrack);
      const res = await startWebrtcRecorder({
        trackId: String(videoTrack.id ?? ''),
        outputDir: this.getWebrtcRecorderOutputDir(),
        width: WEBRTC_RECORDER_VIDEO_WIDTH,
        height: WEBRTC_RECORDER_VIDEO_HEIGHT,
        fps: WEBRTC_RECORDER_FPS,
        videoBitrate: WEBRTC_RECORDER_VIDEO_BITRATE,
        audioBitrate: WEBRTC_RECORDER_AUDIO_BITRATE,
        segmentSeconds: WEBRTC_RECORDER_SEGMENT_SECONDS,
      });
      this.activeWebrtcRecordingId = res.recordingId;
      this.lastUploadedUri = null;
      this.recordingStartedAt = Date.now();
      this.recordingDurationMs = null;
      this.telemetry = { recording_state: 'recording' };
      logger.info('WebRTC track recording started', {
        recordingId: res.recordingId,
        sessionId: this.currentSessionId,
      });
      return true;
    } catch (e) {
      logger.error('Failed to start WebRTC track recording', e);
      return false;
    }
  }

  /**
   * Dừng ghi từ track WebRTC, ghép các segment thành 1 file MP4 và trả về uri.
   */
  public async stopWebrtcTrackRecording(): Promise<string | null> {
    if (!this.activeWebrtcRecordingId || this.isStoppingRecording) {
      return null;
    }
    const recId = this.activeWebrtcRecordingId;
    this.isStoppingRecording = true;
    try {
      const res = await stopWebrtcRecorder(recId);
      this.activeWebrtcRecordingId = null;
      this.recordingDurationMs =
        res.durationMs > 0
          ? Math.round(res.durationMs)
          : this.recordingStartedAt
            ? Math.max(500, Date.now() - this.recordingStartedAt)
            : 500;
      this.telemetry = { recording_state: res.uri ? 'saved' : 'idle' };
      logger.info('WebRTC track recording stopped', {
        recordingId: recId,
        uri: res.uri,
        durationMs: this.recordingDurationMs,
        size: res.size,
      });
      return res.uri;
    } catch (e) {
      logger.error('Failed to stop WebRTC track recording', e);
      this.activeWebrtcRecordingId = null;
      this.telemetry = { recording_state: 'idle' };
      return null;
    } finally {
      this.isStoppingRecording = false;
    }
  }

  /**
   * Bắt đầu quay video thật trên device
   */
  public async startRecording(
    maxDurationSec: number = CAMERA_VIDEO_MAX_DURATION,
  ): Promise<boolean> {
    if (cameraService.isVideoRecording_()) {
      logger.warn('Recording already in progress');
      return false;
    }

    const started = await cameraService.startVideoRecording(maxDurationSec);
    if (started) {
      this.lastUploadedUri = null;
      this.recordingStartedAt = Date.now();
      this.recordingDurationMs = null;
      this.telemetry = { recording_state: 'recording' };
      logger.info('Video recording started', { maxDurationSec, sessionId: this.currentSessionId });
    } else {
      logger.warn('startVideoRecording returned false', {
        maxDurationSec,
        cameraReady: cameraService.isReady_(),
        alreadyRecording: cameraService.isVideoRecording_(),
      });
    }

    return started;
  }

  /**
   * Dừng quay video NGAY LẬP TỨC, trả về uri file video.
   * (Không upload ở đây - upload được tách riêng để UI không bị block)
   */
  public async stopRecording(): Promise<string | null> {
    // Chặn gọi trùng: nếu đang dừng thì bỏ qua (single-flight)
    if (this.isStoppingRecording) {
      logger.warn('stopRecording already in progress, ignoring duplicate call');
      return null;
    }

    this.isStoppingRecording = true;
    try {
      const uri = await cameraService.stopVideoRecording();
      if (uri && this.recordingStartedAt) {
        this.recordingDurationMs = Math.max(500, Date.now() - this.recordingStartedAt);
        logger.info('Video recording stopped', { durationMs: this.recordingDurationMs });
      }
      this.telemetry = { recording_state: uri ? 'saved' : 'idle' };
      return uri;
    } finally {
      this.isStoppingRecording = false;
    }
  }

  /**
   * Copy clip từ cache của camera sang thư mục bền (hiện ở tab Files), rồi upload.
   * Chỉ xoá bản bền khi complete thành công; lỗi thì clip vẫn nằm ở Files để upload lại.
   * Session_id và device info được lấy từ state đã setActiveSession() khi nhận lệnh start_record.
   */
  public async uploadRecording(
    uri: string,
    onProgress?: (percent: number) => void,
  ): Promise<boolean> {
    if (!uri) {
      return false;
    }

    if (this.lastUploadedUri === uri) {
      logger.warn('Video already uploaded, skipping duplicate upload', { uri });
      return true;
    }

    this.lastUploadedUri = uri;

    const effectiveSessionId = this.currentSessionId ?? 'standalone';
    const recordedAt = this.recordingStartedAt
      ? new Date(this.recordingStartedAt).toISOString()
      : new Date().toISOString();
    const localVideoUid = `${effectiveSessionId}_${this.deviceId}_${this.recordingStartedAt ?? Date.now()}`;
    const durationMs = this.recordingDurationMs ?? undefined;
    this.recordingStartedAt = null;
    this.recordingDurationMs = null;

    const report = (percent: number) => {
      this.telemetry = { ...this.telemetry, upload_state: 'uploading', upload_percent: percent };
      onProgress?.(percent);
    };

    const saved = await localStore.saveCapturedMedia(uri, 'video');
    if (!saved) {
      this.lastUploadedUri = null;
      this.telemetry = { ...this.telemetry, upload_state: 'failed' };
      return false;
    }

    try {
      report(0);
      await uploadService.uploadVideo(
        saved.localUri,
        {
          localVideoUid,
          deviceId: this.deviceId,
          roomId: this.currentRoomId ?? undefined,
          cameraName: this.cameraName,
          sessionId: effectiveSessionId,
          recordedAt,
          durationMs,
        },
        report,
      );
      this.telemetry = { ...this.telemetry, upload_state: 'uploaded', upload_percent: 100 };
      await localStore.deleteCapturedFile(saved.id);
      logger.info('Video upload completed', {
        sessionId: effectiveSessionId,
        roomId: this.currentRoomId,
        deviceId: this.deviceId,
        durationMs,
      });
      return true;
    } catch (error) {
      logger.error('Failed to upload recording', error);
      this.telemetry = { ...this.telemetry, upload_state: 'failed' };
      this.lastUploadedUri = null;
      return false;
    }
  }
}

// Export singleton instance
export const streamingService = new StreamingService();
