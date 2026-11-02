/**
 * API Types
 * Kiểu dữ liệu dùng chung cho lớp tích hợp API v1 (multicam-server)
 * Tài liệu: API Docs v1.md — base path /it4788/api/v1
 */

export type AccountRole = 'controller' | 'remote';

export interface ApiEnvelope<T = any> {
  code: number;
  message: string;
  data: T;
}

/** Mã lỗi theo bảng mã của server */
export const API_CODES = {
  OK: 1000,
  DB_ERROR: 1001,
  PARAM_MISSING: 1002,
  PARAM_TYPE_INVALID: 1003,
  PARAM_VALUE_INVALID: 1004,
  UNKNOWN_ERROR: 1005,
  FILE_TOO_BIG: 1006,
  UPLOAD_FAILED: 1007,
  MAX_ITEMS_EXCEEDED: 1008,
  NOT_ACCESS: 1009,
  ALREADY_DONE: 1010,
  COULD_NOT_COMPLETE: 1011,
  LIMITED_ACCESS: 1012,
  NOT_EXISTED: 9992,
  CODE_VERIFY_INCORRECT: 9993,
  NO_DATA: 9994,
  USER_NOT_VALIDATED: 9995,
  USER_EXISTED: 9996,
  METHOD_INVALID: 9997,
  TOKEN_INVALID: 9998,
  EXCEPTION_ERROR: 9999,
} as const;

/** Mã lỗi do client tự sinh (không đến từ server) */
export const LOCAL_CODES = {
  NETWORK_ERROR: -1,
  PARSE_ERROR: -2,
  UNKNOWN_ERROR: -3,
  UPLOAD_FAILED: -4,
} as const;

export interface AuthUser {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  avatar: string | null;
}

export interface AuthData {
  user: AuthUser;
  account_role: AccountRole;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  device: { id: string; remote_control_enabled: number };
}

export interface RefreshData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface DeviceInfo {
  id: string;
  device_name: string;
  device_type?: number;
  is_online?: number;
  last_seen?: string | null;
  is_current?: number;
}

export interface ServerVideo {
  id: string;
  name: string;
  thumbnail_url: string | null;
  duration_ms: number;
  size: number;
  created_at: string;
  camera_name: string | null;
  device_id: string | null;
  session_id: string | null;
  local_video_uid: string | null;
  downloaded_by_controller?: number;
}

export interface VideoDetail extends ServerVideo {
  url: string;
  resolution: string | null;
  codec: string | null;
  owner: string;
}

export interface CheckUploadedItem {
  local_video_uid: string;
  uploaded: 0 | 1;
  video_id: string | null;
  uploaded_at: string | null;
}

export interface InitUploadPayload {
  file_name: string;
  file_size: number;
  mime_type: 'video/mp4';
  checksum_sha256?: string;
  metadata: {
    local_video_uid: string;
    device_id: string;
    room_id?: string;
    camera_name?: string;
    session_id?: string;
    recorded_at?: string;
    duration_ms?: number;
    resolution?: string;
    fps?: number;
  };
}

export interface InitUploadData {
  upload_id: string | null;
  /** Presigned PUT URL (không gửi Authorization) */
  upload_url: string | null;
  expires_at: string | null;
  already_uploaded: 0 | 1;
  video_id: string | null;
}

export interface CompleteUploadData {
  video_id: string;
  local_video_uid: string;
  url: string;
  thumbnail_url: string | null;
  duration_ms: number;
  size: number;
  created_at: string;
}

export interface DownloadUrlData {
  download_url: string;
  expires_at: string;
  size: number;
  checksum_sha256: string;
}
