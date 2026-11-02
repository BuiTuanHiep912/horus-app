/**
 * Upload Service — init -> PUT cả file lên presigned URL (stream native, không base64) -> complete
 * Retry: PUT tối đa 3 lần có backoff; complete trả 1011 → PUT lại; 1007 (sai size) → init lại 1 lần.
 */

import * as FileSystem from 'expo-file-system/legacy';

import { logger } from '../utils/logger';
import { abortUpload, completeUpload, initUpload } from '../api/uploads';
import { ApiError } from '../api/client';
import { API_CODES, LOCAL_CODES } from '../api/types';

export type UploadProgressCallback = (percent: number) => void;

export interface VideoMetadata {
  /** UID ổn định của clip ở client — dùng để chống trùng lặp */
  localVideoUid: string;
  deviceId: string;
  roomId?: string;
  cameraName?: string;
  sessionId?: string;
  recordedAt?: string;
  durationMs?: number;
  resolution?: string;
  fps?: number;
}

export interface UploadVideoResult {
  videoId: string | null;
  alreadyUploaded: boolean;
}

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const isCode = (error: unknown, code: number) => error instanceof ApiError && error.code === code;

/** PUT cả file, retry với backoff 1s/2s. Progress PUT chiếm 0-95%. */
async function putFile(url: string, fileUri: string, onProgress?: UploadProgressCallback) {
  for (let attempt = 1; ; attempt++) {
    try {
      const task = FileSystem.createUploadTask(
        url,
        fileUri,
        {
          httpMethod: 'PUT',
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers: { 'Content-Type': 'video/mp4' },
        },
        p => onProgress?.(Math.round((p.totalBytesSent / (p.totalBytesExpectedToSend || 1)) * 95)),
      );
      const res = await task.uploadAsync();
      if (res && res.status >= 200 && res.status < 300) return;
      throw new Error(`PUT HTTP ${res?.status}: ${res?.body?.slice(0, 200)}`);
    } catch (error) {
      logger.warn(`Upload PUT attempt ${attempt} failed`, error);
      if (attempt >= MAX_ATTEMPTS) {
        throw new ApiError(LOCAL_CODES.UPLOAD_FAILED, 'Không gửi được file video lên server');
      }
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}

class UploadService {
  public async uploadVideo(
    fileUri: string,
    metadata: VideoMetadata,
    onProgress?: UploadProgressCallback,
  ): Promise<UploadVideoResult> {
    const info = await FileSystem.getInfoAsync(fileUri);
    if (!info.exists) {
      throw new ApiError(LOCAL_CODES.UNKNOWN_ERROR, 'File không tồn tại');
    }

    const payload = {
      file_name: fileUri.split('/').pop() || `recording_${Date.now()}.mp4`,
      file_size: info.size,
      mime_type: 'video/mp4' as const,
      metadata: {
        local_video_uid: metadata.localVideoUid,
        device_id: metadata.deviceId,
        room_id: metadata.roomId,
        camera_name: metadata.cameraName,
        session_id: metadata.sessionId,
        recorded_at: metadata.recordedAt ?? new Date().toISOString(),
        duration_ms: metadata.durationMs,
        resolution: metadata.resolution,
        fps: metadata.fps,
      },
    };

    for (let initRound = 1; ; initRound++) {
      const init = await initUpload(payload);
      if (init.already_uploaded === 1) {
        logger.info('Video already uploaded on server', { videoId: init.video_id });
        onProgress?.(100);
        return { videoId: init.video_id, alreadyUploaded: true };
      }
      const { upload_id: uploadId, upload_url: uploadUrl } = init;
      if (!uploadId || !uploadUrl) {
        throw new ApiError(LOCAL_CODES.UNKNOWN_ERROR, 'Server không cấp phiên upload');
      }

      try {
        for (let attempt = 1; ; attempt++) {
          await putFile(uploadUrl, fileUri, onProgress);
          try {
            const result = await completeUpload(uploadId);
            onProgress?.(100);
            logger.info('Video uploaded', { videoId: result.video_id });
            return { videoId: result.video_id, alreadyUploaded: false };
          } catch (error) {
            // 1011: object chưa có trên S3 → PUT lại rồi complete lại
            if (!isCode(error, API_CODES.COULD_NOT_COMPLETE) || attempt >= MAX_ATTEMPTS)
              throw error;
            logger.warn('Complete returned 1011, re-PUT', { attempt });
          }
        }
      } catch (error) {
        // 1007: size trên S3 lệch file_size, server đã đóng phiên → init lại đúng 1 lần
        if (isCode(error, API_CODES.UPLOAD_FAILED) && initRound === 1) {
          logger.warn('Complete returned 1007, re-init upload');
          continue;
        }
        abortUpload(uploadId).catch(() => undefined);
        throw error;
      }
    }
  }
}

// Export singleton instance
export const uploadService = new UploadService();
