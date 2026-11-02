/**
 * useDeviceSync — hook nối RemoteScreen với polling sync_device
 * Tự cung cấp telemetry và xử lý pending_commands
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { deviceSyncService } from '../services/deviceSync';
import { streamingService } from '../services/streaming';
import { logger } from '../utils/logger';
import { authStore } from '../services/authStore';
import { useRouter } from 'expo-router';

export function useDeviceSync(deviceId: string, opts?: { enabled?: boolean }) {
  const enabled = opts?.enabled ?? true;
  const router = useRouter();

  useEffect(() => {
    if (!deviceId || !enabled) return;

    deviceSyncService.initialize(deviceId);
    deviceSyncService.setTelemetryProvider(() => streamingService.getTelemetry());

    const offCamera = deviceSyncService.onCommand('camera_config', async cmd => {
      const p = cmd.payload as { flash_mode?: string; zoom_factor?: number };
      logger.info('Handling camera_config', p);
      // Hiện tại expo-camera chưa đổi flash/zoom động — log để gắn sau
      // TODO: cameraService.setFlashMode / setZoom
      deviceSyncService.setLastCommandId(cmd.command_id);
    });

    const offLeave = deviceSyncService.onCommand('leave_room', async cmd => {
      logger.info('Handling leave_room (kicked/closed)', cmd.payload);
      deviceSyncService.setLastCommandId(cmd.command_id);
      // Có thể điều hướng hoặc toast
    });

    deviceSyncService.onRevoked(async () => {
      logger.warn('Session revoked → logout');
      await authStore.clear();
      router.replace('/login');
    });

    deviceSyncService.start();

    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') deviceSyncService.start();
      else if (state === 'background') deviceSyncService.stop();
    });

    return () => {
      offCamera();
      offLeave();
      sub.remove();
      deviceSyncService.stop();
    };
  }, [deviceId, enabled, router]);
}
