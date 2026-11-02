/**
 * File System Utilities
 * Xóa file / tạo thư mục
 */

import * as FileSystem from 'expo-file-system/legacy';
import { logger } from './logger';

/**
 * Xóa file
 */
export async function deleteFile(fileUri: string): Promise<boolean> {
  try {
    await FileSystem.deleteAsync(fileUri);
    return true;
  } catch (error) {
    logger.error('Failed to delete file', error);
    return false;
  }
}

/**
 * Tạo directory nếu chưa tồn tại
 */
export async function ensureDirectory(dirUri: string): Promise<boolean> {
  try {
    const dirInfo = await FileSystem.getInfoAsync(dirUri);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(dirUri, { intermediates: true });
    }
    return true;
  } catch (error) {
    logger.error('Failed to ensure directory', error);
    return false;
  }
}
