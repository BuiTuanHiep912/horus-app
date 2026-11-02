/**
 * API Client
 * Lớp HTTP dùng chung cho toàn bộ API v1:
 * - Tự ghép base URL từ cấu hình server (baseUrl + prefix /it4788/api/v1)
 * - Tự gắn Authorization: Bearer <access_token>
 * - Tự refresh token (rotation) khi gặp mã 9998/9993 rồi thử lại request 1 lần
 */

import { apiUrl, serverConfigService } from '../services/serverConfig';
import { authStore } from '../services/authStore';
import { logger } from '../utils/logger';
import { ApiEnvelope, API_CODES, LOCAL_CODES } from './types';

export class ApiError extends Error {
  public code: number;
  public data: any;

  constructor(code: number, message: string, data?: any) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.data = data;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: any;
  headers?: Record<string, string>;
  /** Mặc định true — tự gắn Bearer token */
  auth?: boolean;
  /** Mặc định true — tự refresh token rồi retry 1 lần khi 9998/9993 */
  allowRefreshRetry?: boolean;
  timeoutMs?: number;
}

let refreshingPromise: Promise<boolean> | null = null;

/**
 * Refresh access token bằng refresh token đang lưu (single-flight).
 * Trả về true nếu thành công; false nếu phiên đã hết hạn hoàn toàn.
 */
export async function refreshSession(): Promise<boolean> {
  if (!refreshingPromise) {
    refreshingPromise = doRefresh().finally(() => {
      refreshingPromise = null;
    });
  }
  return refreshingPromise;
}

async function doRefresh(): Promise<boolean> {
  const session = await authStore.load();
  if (!session?.refreshToken) {
    logger.warn('Cannot refresh: no session/refreshToken in store');
    return false;
  }

  const refreshTokenUsed = session.refreshToken;
  logger.info('Refreshing token');

  const config = await serverConfigService.load();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(apiUrl(config) + '/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshTokenUsed }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const envelope: ApiEnvelope<any> = await response.json();
    if (envelope.code !== API_CODES.OK || !envelope.data?.access_token) {
      logger.warn('Token refresh rejected', {
        code: envelope.code,
        message: envelope.message,
      });
      // Chỉ xóa phiên nếu vẫn còn là phiên vừa refresh thất bại,
      // tránh xóa nhầm phiên mới hơn (ví dụ user vừa đăng nhập lại)
      const current = await authStore.load();
      if (current?.refreshToken === refreshTokenUsed) {
        await authStore.clear();
      }
      return false;
    }

    await authStore.updateTokens(
      envelope.data.access_token,
      envelope.data.refresh_token,
      envelope.data.expires_in ?? 900,
    );
    logger.info('Access token refreshed');
    return true;
  } catch (error) {
    logger.error('Token refresh failed', error);
    return false;
  }
}

function isAuthInvalid(code: number): boolean {
  return code === API_CODES.TOKEN_INVALID || code === API_CODES.CODE_VERIFY_INCORRECT;
}

async function rawRequest(
  path: string,
  options: RequestOptions,
  accessToken: string | null,
): Promise<Response> {
  const config = await serverConfigService.load();
  const url = `${apiUrl(config)}${path}`;

  const headers: Record<string, string> = { ...(options.headers || {}) };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  let body = options.body;
  const isBinary = body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
  if (body !== undefined && body !== null && !isBinary) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    body = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);

  try {
    return await fetch(url, {
      method: options.method || 'GET',
      headers,
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Gọi API và trả về data trong envelope {code,message,data}.
 * Ném ApiError khi code !== 1000.
 */
export async function apiRequest<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
  const useAuth = options.auth !== false;
  const session = useAuth ? await authStore.load() : null;

  let response: Response;
  try {
    response = await rawRequest(path, options, session?.accessToken || null);
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new ApiError(LOCAL_CODES.NETWORK_ERROR, 'Hết thời gian chờ server');
    }
    throw new ApiError(LOCAL_CODES.NETWORK_ERROR, 'Không kết nối được server');
  }

  let envelope: ApiEnvelope<T>;
  try {
    envelope = await response.json();
  } catch {
    throw new ApiError(
      LOCAL_CODES.PARSE_ERROR,
      `Phản hồi không hợp lệ từ server (HTTP ${response.status})`,
    );
  }

  // Token hết hạn -> refresh (rotation) rồi thử lại đúng 1 lần
  if (
    useAuth &&
    options.allowRefreshRetry !== false &&
    response.status === 401 &&
    isAuthInvalid(envelope.code)
  ) {
    const refreshed = await refreshSession();
    if (refreshed) {
      return apiRequest<T>(path, { ...options, allowRefreshRetry: false });
    }
    throw new ApiError(envelope.code, 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại');
  }

  if (envelope.code !== API_CODES.OK) {
    throw new ApiError(envelope.code, envelope.message || 'Yêu cầu thất bại', envelope.data);
  }

  return envelope.data;
}
