import { syncDevice } from '../api/devices';
import { deviceSyncService } from './deviceSync';

jest.mock('../api/devices', () => ({ syncDevice: jest.fn() }));
jest.mock('./authStore', () => ({ authStore: { load: jest.fn(), clear: jest.fn() } }));
jest.mock('./deviceInfo', () => ({ getDeviceInfo: jest.fn() }));
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const sync = syncDevice as jest.Mock;
const reply = { next_sync_in: 5, room_status: { in_room: 0, room_id: null, session_id: null } };

describe('deviceSyncService', () => {
  beforeEach(() => jest.useFakeTimers());

  afterEach(() => {
    deviceSyncService.stop();
    jest.useRealTimers();
  });

  it('keeps one poller and does not replay a command after stop+start mid-sync', async () => {
    const handler = jest.fn(async () => undefined);
    const off = deviceSyncService.onCommand('start_record', handler);
    const cmd = { command_id: 'c1', type: 'start_record', payload: {} };

    let finishFirst!: (v: unknown) => void;
    sync.mockReturnValueOnce(new Promise(r => (finishFirst = r)));
    sync.mockResolvedValue({ ...reply, pending_commands: [cmd] });

    deviceSyncService.initialize('dev1');
    deviceSyncService.start();
    deviceSyncService.stop();
    deviceSyncService.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);

    // Sync cũ về trễ với cùng lệnh: phải bị bỏ
    finishFirst({ ...reply, pending_commands: [cmd] });
    await jest.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);

    sync.mockClear();
    await jest.advanceTimersByTimeAsync(5000);
    expect(sync).toHaveBeenCalledTimes(1);
    off();
  });
});
