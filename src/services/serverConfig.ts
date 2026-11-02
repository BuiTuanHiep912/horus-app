/**
 * Server Config Service
 * Lưu URL gốc của server (vd https://api.example.com) trong AsyncStorage.
 * Mặc định lấy từ app.config.ts (extra.apiUrl ← biến môi trường API_URL lúc build).
 * Mọi URL http/ws đều được dựng ở đây.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { logger } from '../utils/logger';

export interface ServerConfig {
  baseUrl: string;
}

const STORAGE_KEY = 'server_config';
const API_PREFIX = '/it4788/api/v1';

/** Bỏ khoảng trắng và "/" cuối; host trần (không scheme) mặc định https. */
export function normalizeBaseUrl(input: string): string {
  const url = input.trim().replace(/\/+$/, '');
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/** https → wss, http → ws */
export function wsUrl(config: ServerConfig): string {
  return config.baseUrl.replace(/^http/i, 'ws');
}

/** Base URL của API v1 trên multicam-server */
export function apiUrl(config: ServerConfig): string {
  return `${config.baseUrl}${API_PREFIX}`;
}

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  baseUrl: normalizeBaseUrl(String(Constants.expoConfig?.extra?.apiUrl ?? '')),
};

class ServerConfigService {
  private config: ServerConfig | null = null;

  /**
   * Nạp cấu hình server: ưu tiên giá trị đã lưu trong AsyncStorage,
   * fallback về DEFAULT_SERVER_CONFIG. Kết quả được cache.
   */
  public async load(): Promise<ServerConfig> {
    if (this.config) {
      return this.config;
    }

    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      // Cấu hình cũ dạng {host, port} không còn dùng → rơi về mặc định
      const baseUrl = raw ? normalizeBaseUrl(String(JSON.parse(raw).baseUrl ?? '')) : '';
      if (baseUrl) {
        this.config = { baseUrl };
        logger.info('Server config loaded from storage', this.config);
        return this.config;
      }
    } catch (error) {
      logger.error('Failed to load server config', error);
    }

    this.config = { ...DEFAULT_SERVER_CONFIG };
    logger.info('Server config using default', this.config);
    return this.config;
  }

  /** Lưu cấu hình mới (request kế tiếp dùng ngay). */
  public async save(baseUrl: string): Promise<ServerConfig> {
    const next: ServerConfig = { baseUrl: normalizeBaseUrl(baseUrl) };
    this.config = next;

    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      logger.info('Server config saved', next);
    } catch (error) {
      logger.error('Failed to save server config', error);
    }

    return next;
  }

  /** GET /health — true nếu server trả status "up". Dùng cho nút Test ở Login/Settings. */
  public async checkHealth(baseUrl: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${normalizeBaseUrl(baseUrl)}/health`, {
        signal: controller.signal,
      });
      const body = response.ok ? await response.json().catch(() => null) : null;
      return body?.data?.status === 'up';
    } catch (error) {
      logger.warn('Connection test failed', error);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// Export singleton instance
export const serverConfigService = new ServerConfigService();
