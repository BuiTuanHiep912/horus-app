/**
 * Rooms API — khớp API Docs v1.md mục Điều khiển phòng & phiên quay
 * POST /rooms, POST /rooms/join, GET /rooms/:id/members, GET /rooms/:id/sync,
 * POST /rooms/:id/invite-code, DELETE .../members/:mid, DELETE /rooms/:id,
 * POST /rooms/:id/leave, PUT .../permission, POST .../preview-token,
 * POST .../recording/start|stop, PUT|GET .../camera
 */
import { apiRequest } from './client';

// ── Types ──
export interface RoomCreateData {
  room_id: string;
  invite_code: string;
  expires_at: string;
  owner_device_id: string;
  created_at: string;
}

export interface RoomJoinData {
  room_id: string;
  room_name: string | null;
  owner: { device_id: string; camera_name: string | null };
  member_id: string;
  /** 'pending' khi room auto_approve=0 — chờ Controller duyệt mới được phát */
  member_join_status: 'approved' | 'pending';
  members: RoomMember[];
}

export interface RoomMember {
  member_id: string;
  device_id: string;
  camera_name: string;
  is_online: number;
  has_granted_control: number;
  battery_level: number | null;
  is_charging: number | null;
  storage_free: number | null;
  temperature_state: string | null;
  recording_state: string | null;
  elapsed_ms: number | null;
  upload_state: string | null;
  upload_percent: number | null;
  error_code: string | null;
  join_status: string | null;
  preview_url: string | null;
  last_seen: string | null;
}

export interface SyncRoomData {
  server_time: string;
  revision: number;
  next_sync_in: number;
  room: { status: string; session_id: string | null; started_at: string | null };
  members: RoomMember[];
  /** Danh sách đang chờ Controller duyệt (chỉ owner nhìn thấy) */
  pending: RoomMember[];
  joined: RoomMember[];
  left: string[];
}

export interface PreviewTokenData {
  preview_token: string;
  expires_in: number;
  signaling_url: string; // "/it4788/api/v1/rooms/:id/media"
  rtp_capabilities: { codecs: unknown[]; headerExtensions: unknown[] };
  streams: { member_id: string; is_online: number }[];
}

export interface RecordingStartData {
  session_id: string;
  started_at: string;
  command_id: string;
  targets: string[];
  rejected: { member_id: string; reason: string }[];
}

export interface RecordingStopData {
  session_id: string;
  stopped_at: string;
  results: {
    member_id: string;
    local_video_uid: string | null;
    duration: number | null;
    size: number | null;
    status: string;
  }[];
}

export interface CameraConfigData {
  flash_mode: string;
  zoom_factor: number;
  zoom_range: { min: number; max: number };
  has_flash: boolean | number;
}

export interface MyRoom {
  room_id: string;
  room_name: string | null;
  invite_code: string;
  auto_approve: number;
  status: 'open' | 'closed';
  member_count: number;
  max_members: number;
  created_at: string;
}

// ── Endpoints ──
export async function createRoom(
  payload: {
    room_name?: string;
    max_members?: number;
    auto_approve?: 0 | 1;
  } = {},
): Promise<RoomCreateData> {
  return apiRequest('/rooms', { method: 'POST', body: payload });
}

/** CRUD phía controller: danh sách các phòng của tài khoản (để quản lý/xóa phòng cũ). */
export async function listMyRooms(): Promise<{ rooms: MyRoom[] }> {
  return apiRequest('/rooms/mine');
}

export async function joinRoom(payload: {
  invite_code: string;
  device_id: string;
  camera_name: string;
  grant_control: true;
}): Promise<RoomJoinData> {
  return apiRequest('/rooms/join', { method: 'POST', body: payload });
}

export async function getRoomMembers(
  roomId: string,
): Promise<{ members: RoomMember[]; total: number }> {
  return apiRequest(`/rooms/${roomId}/members`);
}

export async function syncRoom(roomId: string, since?: number): Promise<SyncRoomData> {
  const qs = since !== undefined ? `?since=${since}` : '';
  return apiRequest(`/rooms/${roomId}/sync${qs}`);
}

export async function refreshInviteCode(
  roomId: string,
): Promise<{ invite_code: string; expires_at: string }> {
  return apiRequest(`/rooms/${roomId}/invite-code`, { method: 'POST' });
}

export async function kickMember(roomId: string, memberId: string): Promise<Record<string, never>> {
  return apiRequest(`/rooms/${roomId}/members/${memberId}`, { method: 'DELETE' });
}

/** Owner duyệt thiết bị đăng ký join (room auto_approve=0) */
export async function approveMember(
  roomId: string,
  memberId: string,
): Promise<{ member: RoomMember }> {
  return apiRequest(`/rooms/${roomId}/members/${memberId}/approve`, { method: 'POST' });
}

/** Owner từ chối thiết bị đăng ký join — Remote nhận lệnh leave_room */
export async function denyMember(
  roomId: string,
  memberId: string,
): Promise<{ member_id: string; join_status: string }> {
  return apiRequest(`/rooms/${roomId}/members/${memberId}/deny`, { method: 'POST' });
}

export async function closeRoom(
  roomId: string,
): Promise<{ closed_at: string; session_stopped: number }> {
  return apiRequest(`/rooms/${roomId}`, { method: 'DELETE' });
}

export async function leaveRoom(roomId: string): Promise<Record<string, never>> {
  return apiRequest(`/rooms/${roomId}/leave`, { method: 'POST' });
}

export async function setMemberPermission(
  roomId: string,
  memberId: string,
  grantControl: 0 | 1,
): Promise<{ member_id: string; has_granted_control: number }> {
  return apiRequest(`/rooms/${roomId}/members/${memberId}/permission`, {
    method: 'PUT',
    body: { grant_control: grantControl },
  });
}

export async function getPreviewToken(
  roomId: string,
  payload: { quality: 'low' | 'medium'; protocol: 'hls' | 'webrtc' },
): Promise<PreviewTokenData> {
  return apiRequest(`/rooms/${roomId}/preview-token`, { method: 'POST', body: payload });
}

export async function startRecording(
  roomId: string,
  payload: {
    target: 'all' | string[];
    config?: Record<string, unknown>;
    client_command_id: string;
  },
): Promise<RecordingStartData> {
  return apiRequest(`/rooms/${roomId}/recording/start`, { method: 'POST', body: payload });
}

export async function stopRecording(
  roomId: string,
  payload: { target: 'all' | string[]; client_command_id: string },
): Promise<RecordingStopData> {
  return apiRequest(`/rooms/${roomId}/recording/stop`, { method: 'POST', body: payload });
}

export async function setCameraConfig(
  roomId: string,
  memberId: string,
  payload: {
    flash_mode: 'off' | 'on' | 'auto' | 'torch';
    zoom_factor: number;
    client_command_id: string;
  },
): Promise<{ member_id: string; flash_mode: string; zoom_factor: number; applied_at: string }> {
  return apiRequest(`/rooms/${roomId}/members/${memberId}/camera`, {
    method: 'PUT',
    body: payload,
  });
}

export async function getCameraConfig(roomId: string, memberId: string): Promise<CameraConfigData> {
  return apiRequest(`/rooms/${roomId}/members/${memberId}/camera`);
}
