import { mediasoupService } from './mediasoup';

jest.mock('../api/rooms', () => ({
  getPreviewToken: jest.fn(async () => ({ preview_token: 't', signaling_url: '/media' })),
}));
jest.mock('./authStore', () => ({
  authStore: { load: jest.fn(async () => ({ accessToken: 'a' })) },
}));
jest.mock('./serverConfig', () => ({
  serverConfigService: { load: async () => ({ baseUrl: 'http://srv' }) },
  wsUrl: (c: { baseUrl: string }) => c.baseUrl.replace(/^http/, 'ws'),
}));

class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  readyState = 1;
  sent: Record<string, any>[] = [];
  onopen: any = null;
  onmessage: any = null;
  onclose: any = null;
  onerror: any = null;
  constructor() {
    FakeWS.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  receive(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const flush = () => jest.advanceTimersByTimeAsync(0);

async function connect(): Promise<FakeWS> {
  const p = mediasoupService.connect('room', { quality: 'low', protocol: 'webrtc' });
  await flush();
  const ws = FakeWS.instances[FakeWS.instances.length - 1];
  ws.receive({ type: 'welcome', participant_id: 'p', role: 'remote', rtp_capabilities: {} });
  await p;
  return ws;
}

describe('MediasoupService', () => {
  const closes: any[] = [];
  let off: () => void;

  beforeEach(() => {
    jest.useFakeTimers();
    (global as any).WebSocket = FakeWS;
    FakeWS.instances = [];
    closes.length = 0;
    off = mediasoupService.on('close', msg => closes.push(msg));
  });

  afterEach(() => {
    off();
    mediasoupService.disconnect();
    jest.useRealTimers();
  });

  it('ignores callbacks of a replaced socket and does not touch the new connection', async () => {
    const oldWs = await connect();
    const newWs = await connect();
    oldWs.onclose?.({ code: 4001 });
    expect(closes).toHaveLength(0);
    expect(mediasoupService.getState().connected).toBe(true);
    newWs.onclose?.({ code: 4001 });
    expect(closes).toEqual([{ code: 4001 }]);
    expect(mediasoupService.getState().connected).toBe(false);
  });

  it('rejects pending requests on close instead of timing out', async () => {
    const ws = await connect();
    const req = mediasoupService.sendRequest({ type: 'get-producers' });
    ws.onclose?.({ code: 1006 });
    await expect(req).rejects.toThrow('closed');
  });

  it('closes immediately when a ping times out', async () => {
    const ws = await connect();
    await jest.advanceTimersByTimeAsync(10000);
    expect(ws.sent.some(m => m.type === 'ping')).toBe(true);
    await jest.advanceTimersByTimeAsync(5000);
    expect(closes).toEqual([{ code: 1006 }]);
    expect(ws.onclose).toBeNull();
  });

  it('treats an error reply to ping (old server) as alive', async () => {
    const ws = await connect();
    await jest.advanceTimersByTimeAsync(10000);
    const ping = ws.sent.find(m => m.type === 'ping')!;
    ws.receive({
      type: 'error',
      message: 'unknown message type: ping',
      request_id: ping.request_id,
    });
    await jest.advanceTimersByTimeAsync(5000);
    expect(closes).toHaveLength(0);
  });
});
