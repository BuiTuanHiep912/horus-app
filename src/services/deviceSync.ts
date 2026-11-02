/**
 * DeviceSync Service — polling sync_device cho Remote
 * Khớp API Docs v1.md: POST /devices/:id/sync (3-5s)
 * Gửi telemetry, nhận pending_commands (start_record/stop_record/camera_config/leave_room)
 * và session_revoked.
 */
import { syncDevice, PendingCommand } from '../api/devices';
import { logger } from '../utils/logger';
import { authStore } from './authStore';
import { getDeviceInfo } from './deviceInfo';

export type DeviceCommandHandler = (cmd: PendingCommand) => Promise<void> | void;

export interface DeviceSyncTelemetry {
  battery_level?: number;
  is_charging?: 0 | 1;
  storage_free?: number;
  temperature_state?: string;
  recording_state?: string;
  elapsed_ms?: number;
  upload_state?: string;
  upload_percent?: number;
  error_code?: string | null;
}

class DeviceSyncService {
  private deviceId: string = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  // stop()+start() khi loop cũ còn đang await sync: loop cũ phải tự dừng, không thì chạy 2 poller song song
  private loopGen = 0;
  private lastCommandId: string | null = null;
  private handlers = new Map<string, Set<DeviceCommandHandler>>();
  private telemetryProvider: (() => DeviceSyncTelemetry) | null = null;
  private onSessionRevoked: (() => void) | null = null;
  private onRoomStatus: ((status: { in_room: number; room_id: string | null; session_id: string | null }) => void) | null = null;
  private previewDisconnect: (() => void) | null = null;

  public initialize(deviceId: string): void {
    this.deviceId = deviceId;
    logger.info('DeviceSync initialized', { deviceId });
  }

  public setTelemetryProvider(fn: () => DeviceSyncTelemetry): void {
    this.telemetryProvider = fn;
  }

  public onCommand(type: PendingCommand['type'], handler: DeviceCommandHandler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  public onRevoked(handler: () => void): void {
    this.onSessionRevoked = handler;
  }

  public onRoomStatusChange(handler: (s: { in_room: number; room_id: string | null; session_id: string | null }) => void): void {
    this.onRoomStatus = handler;
  }

  public setPreviewDisconnect(fn: () => void): void {
    this.previewDisconnect = fn;
  }

  public triggerPreviewDisconnect(): void {
    try { this.previewDisconnect?.(); } catch {}
  }

  public start(): void {
    if (this.running) return;
    if (!this.deviceId) {
      logger.warn('DeviceSync.start called without deviceId');
      return;
    }
    this.running = true;
    logger.info('DeviceSync polling started');
    this.loop(++this.loopGen);
  }

  public stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('DeviceSync polling stopped');
  }

  public setLastCommandId(id: string): void {
    this.lastCommandId = id;
  }

  private async loop(gen: number): Promise<void> {
    if (!this.running || gen !== this.loopGen) return;
    let nextIn = 5000;
    try {
      const telem = this.telemetryProvider?.() ?? {};
      const data = await syncDevice(this.deviceId, {
        ...telem,
        last_command_id: this.lastCommandId ?? undefined,
      });
      // Bỏ kết quả: lệnh chưa ack nên loop mới vẫn nhận lại, không xử lý 2 lần
      if (gen !== this.loopGen) return;
      nextIn = (data.next_sync_in ?? 5) * 1000;

      if (data.session_revoked === 1) {
        logger.warn('Device session revoked by server');
        this.onSessionRevoked?.();
        this.stop();
        return;
      }

      this.onRoomStatus?.(data.room_status);

      if (data.pending_commands?.length) {
        // Ack theo thứ tự phát hành — server đánh dấu đã nhận khi gửi last_command_id
        for (const cmd of data.pending_commands) {
          logger.info('DeviceSync pending command', { type: cmd.type, id: cmd.command_id });
          const handlers = this.handlers.get(cmd.type);
          if (handlers) {
            for (const h of handlers) {
              try {
                await h(cmd);
              } catch (e) {
                logger.error('Error handling command', e);
              }
            }
          }
          this.lastCommandId = cmd.command_id;
        }
      }
    } catch (e: any) {
      const code = e?.code ?? 0;
      const msg = e?.message ?? String(e);
      // 9992 = NOT_EXISTED ("Post is not existed") — thường do device_id không thuộc user (đổi tài khoản, xoá DB, podman volume reset)
      logger.warn('DeviceSync poll failed (will retry)', { code, msg, deviceId: this.deviceId, err: e });
      if (code === 9992) {
        // 9992 "not owned by user" thường do DB reset (podman volume) khiến userId trong token cũ không còn tồn tại → FK fail nếu cố re-register.
        // Thay vì spam re-register, buộc đăng nhập lại để lấy userId mới.
        logger.warn('DeviceSync 9992 not owned — server DB likely reset, forcing re-login', { deviceId: this.deviceId });
        try {
          const session = await authStore.load();
          if (session) {
            const { registerDevice } = await import('../api/devices');
            const info = getDeviceInfo();
            await registerDevice({
              device_id: this.deviceId,
              device_type: 1 as const,
              device_name: 'Remote Device',
              model: info.model,
              os_version: info.osVersion,
            });
            logger.info('DeviceSync auto-re-register success', { deviceId: this.deviceId });
            nextIn = 2000;
          } else {
            this.stop(); return;
          }
        } catch (re: any) {
          const rc = re?.code ?? 0;
          logger.error('DeviceSync auto-re-register failed', { err: re?.message ?? String(re), code: rc });
          // FK fail (500/9999) hoặc vẫn 9992 → session cũ vô hiệu, cần đăng nhập lại
          if (rc === 9992 || rc === 9999 || re?.message?.includes('FOREIGN KEY')) {
            logger.warn('DeviceSync re-register fatal — clearing session, require re-login');
            await authStore.clear();
            this.onSessionRevoked?.();
            this.stop();
            return;
          }
          nextIn = 5000;
        }
      } else {
        nextIn = 5000;
      }
      const session = await authStore.load();
      if (!session) {
        logger.warn('No session, stopping DeviceSync');
        this.stop();
        return;
      }
    }

    if (this.running && gen === this.loopGen) {
      this.timer = setTimeout(() => this.loop(gen), nextIn);
    }
  }
}

export const deviceSyncService = new DeviceSyncService();
