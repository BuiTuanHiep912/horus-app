/**
 * Local Store Service
 * Lưu tạm ảnh/video vừa chụp/quay trong bộ nhớ của app (document directory),
 * duy trì index trong AsyncStorage, và hỗ trợ chuyển (copy) file ra thư viện ảnh Photos.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from '../utils/logger';
import { ensureDirectory, deleteFile } from '../utils/file';

export type CapturedType = 'photo' | 'video';

export interface CapturedFile {
  id: string;
  type: CapturedType;
  fileName: string;
  localUri: string;
  createdAt: number;
  size: number;
  uploaded?: boolean;
}

const INDEX_KEY = 'captured_files_index';
const CAPTURED_DIR = 'captured';

class LocalStoreService {
  private dirUri: string = '';

  /**
   * Khởi tạo thư mục lưu trữ local (gọi trước khi dùng)
   */
  public initialize(): void {
    if (FileSystem.documentDirectory) {
      this.dirUri = `${FileSystem.documentDirectory}${CAPTURED_DIR}/`;
    }
    logger.info('LocalStoreService initialized', { dirUri: this.dirUri });
  }

  /**
   * Danh sách file đã lưu (mới nhất trước)
   */
  public async listCapturedFiles(): Promise<CapturedFile[]> {
    try {
      const raw = await AsyncStorage.getItem(INDEX_KEY);
      const list: CapturedFile[] = raw ? JSON.parse(raw) : [];
      return list.sort((a, b) => b.createdAt - a.createdAt);
    } catch (error) {
      logger.error('Failed to list captured files', error);
      return [];
    }
  }

  /**
   * Copy file ảnh/video từ uri tạm của camera vào thư mục local và ghi index.
   * Không upload lên server.
   */
  public async saveCapturedMedia(
    sourceUri: string,
    type: CapturedType,
  ): Promise<CapturedFile | null> {
    if (!this.dirUri) {
      logger.error('LocalStoreService not initialized');
      return null;
    }

    try {
      await ensureDirectory(this.dirUri);

      const extension = type === 'photo' ? 'jpg' : 'mp4';
      const fileName = `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}.${extension}`;
      const targetUri = `${this.dirUri}${fileName}`;

      await FileSystem.copyAsync({
        from: sourceUri,
        to: targetUri,
      });

      const info = await FileSystem.getInfoAsync(targetUri);
      const size = info.exists && 'size' in info ? (info as any).size || 0 : 0;

      const record: CapturedFile = {
        id: `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        type,
        fileName,
        localUri: targetUri,
        createdAt: Date.now(),
        size,
      };

      const list = await this.listCapturedFiles();
      list.unshift(record);
      await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(list));

      logger.info('Captured media saved locally', record);
      return record;
    } catch (error) {
      logger.error('Failed to save captured media locally', error);
      return null;
    }
  }

  /**
   * Xóa file khỏi bộ nhớ local (cả file và index)
   */
  public async deleteCapturedFile(id: string): Promise<boolean> {
    try {
      const list = await this.listCapturedFiles();
      const target = list.find(f => f.id === id);
      if (!target) {
        return false;
      }

      await deleteFile(target.localUri);
      await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(list.filter(f => f.id !== id)));
      logger.info('Captured media deleted', { id, fileName: target.fileName });
      return true;
    } catch (error) {
      logger.error('Failed to delete captured media', error);
      return false;
    }
  }

  /**
   * Đánh dấu file đã upload lên server (lưu vào index)
   */
  public async markUploaded(id: string): Promise<void> {
    try {
      const list = await this.listCapturedFiles();
      const target = list.find(f => f.id === id);
      if (!target) {
        return;
      }
      target.uploaded = true;
      await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(list));
      logger.info('Captured media marked as uploaded', { id, fileName: target.fileName });
    } catch (error) {
      logger.error('Failed to mark captured media as uploaded', error);
    }
  }

  /**
   * Chuyển (copy) file ra thư viện ảnh Photos của thiết bị.
   * Bản lưu local vẫn được giữ lại.
   */
  public async exportToGallery(id: string): Promise<boolean> {
    try {
      const list = await this.listCapturedFiles();
      const target = list.find(f => f.id === id);
      if (!target) {
        logger.warn('Captured file not found for export', { id });
        return false;
      }

      const permission = await MediaLibrary.requestPermissionsAsync(true);
      if (!permission.granted) {
        logger.warn('Media library permission denied');
        return false;
      }

      await MediaLibrary.saveToLibraryAsync(target.localUri);
      logger.info('Captured media exported to gallery', {
        id,
        fileName: target.fileName,
      });
      return true;
    } catch (error) {
      logger.error('Failed to export captured media to gallery', error);
      return false;
    }
  }
}

// Export singleton instance
export const localStore = new LocalStoreService();
