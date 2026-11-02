/**
 * Mediasoup Signaling Service — preview trực tiếp SFU
 * Khớp API Docs v1.md: POST /rooms/:id/preview-token → WS GET /rooms/:id/media
 * Flow: welcome → create-transport → connect-transport → produce (remote) / consume (controller)
 * Lưu ý: Đây là lớp báo hiệu. RTP thực tế cần react-native-webrtc + mediasoup-client.
 * Service này xử lý phần WebSocket JSON, để UI có thể mock hoặc gắn SDK sau.
 */
import { logger } from '../utils/logger';
import { authStore } from './authStore';
import { serverConfigService, wsUrl } from './serverConfig';
import { getPreviewToken } from '../api/rooms';

export type MediaRole = 'controller' | 'remote';

export interface MediaState {
  connected: boolean;
  role: MediaRole | null;
  participantId: string | null;
  rtpCapabilities: unknown | null;
}

type MessageHandler = (msg: Record<string, unknown>) => void;

const PING_INTERVAL_MS = 10000;
const PING_TIMEOUT_MS = 5000;

class MediasoupService {
  private ws: WebSocket | null = null;
  private roomId: string | null = null;
  private state: MediaState = { connected: false, role: null, participantId: null, rtpCapabilities: null };
  private handlers = new Map<string, Set<MessageHandler>>();
  private previewToken: string | null = null;
  private connectSeq = 0;
  private abortWelcome: (() => void) | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  public getState(): MediaState {
    return { ...this.state };
  }

  public on(type: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  private emit(type: string, msg: Record<string, unknown>): void {
    this.handlers.get(type)?.forEach(h => {
      try {
        h(msg);
      } catch (e) {
        logger.error('Mediasoup handler error', e);
      }
    });
    // wildcard
    this.handlers.get('*')?.forEach(h => {
      try {
        h({ _type: type, ...msg });
      } catch {}
    });
  }

  /** Lấy preview_token + mở WS signaling (auth Bearer). */
  public async connect(roomId: string, opts: { quality: 'low' | 'medium'; protocol: 'hls' | 'webrtc' }): Promise<void> {
    this.disconnect();
    const seq = this.connectSeq;
    this.roomId = roomId;
    // disconnect() có thể xen vào lúc đang await REST/storage → không được mở socket sau đó
    const cancelled = () => seq !== this.connectSeq;

    const preview = await getPreviewToken(roomId, opts);
    if (cancelled()) throw new Error('Mediasoup connect cancelled');
    this.previewToken = preview.preview_token;
    logger.info('Preview token obtained', { roomId });

    const config = await serverConfigService.load();
    // signaling_url là "/it4788/api/v1/rooms/:id/media" — ghép thành ws(s)://host + path
    const signalingUrl = `${wsUrl(config)}${preview.signaling_url}`;

    const session = await authStore.load();
    if (!session?.accessToken) throw new Error('No access token for mediasoup WS');
    if (cancelled()) throw new Error('Mediasoup connect cancelled');

    logger.info('Connecting mediasoup WS', { signalingUrl });

    // Server chỉ đọc Authorization từ handshake; RN WebSocket nhận headers qua tham số thứ 3
    // @ts-ignore — kiểu DOM WebSocket không có tham số options
    const ws: WebSocket = new WebSocket(signalingUrl, undefined, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    } as unknown as string[]);
    this.ws = ws;

    // Mọi callback kiểm this.ws === ws: socket cũ (đã bị thay/disconnect) không được đụng state của socket mới
    ws.onopen = () => {
      if (this.ws !== ws) return;
      logger.info('Mediasoup WS open');
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return;
      try {
        const msg = JSON.parse(event.data) as Record<string, unknown>;
        const type = String(msg.type ?? 'unknown');
        logger.debug('Mediasoup WS message', { type });
        // resolve pending request nếu có request_id
        const reqId = msg.request_id as string | undefined;
        if (reqId && this.pending.has(reqId)) {
          const p = this.pending.get(reqId)!;
          clearTimeout(p.timer);
          this.pending.delete(reqId);
          if (type === 'error') p.reject(new Error(String(msg.message ?? 'mediasoup error')));
          else p.resolve(msg);
        }
        if (type === 'welcome') {
          this.state = {
            connected: true,
            role: msg.role as MediaRole,
            participantId: msg.participant_id as string,
            rtpCapabilities: msg.rtp_capabilities ?? null,
          };
          this.startPing(ws);
        }
        this.emit(type, msg);
      } catch (e) {
        logger.error('Failed to parse mediasoup WS message', e);
      }
    };

    ws.onclose = (e: { code?: number }) => {
      if (this.ws !== ws) return;
      logger.info('Mediasoup WS closed', { code: e?.code });
      this.handleClosed(e?.code ?? 1006);
    };

    ws.onerror = (e: unknown) => {
      if (this.ws !== ws) return;
      logger.error('Mediasoup WS error', e);
      this.emit('error', { error: e } as unknown as Record<string, unknown>);
    };

    // Chờ welcome hoặc error trong 10s
    try {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timeout);
          offWelcome();
          offError();
          offClose();
          this.abortWelcome = null;
        };
        const timeout = setTimeout(() => {
          done();
          reject(new Error('Mediasoup welcome timeout'));
        }, 10000);
        const offWelcome = this.on('welcome', () => {
          done();
          resolve();
        });
        const offError = this.on('error', msg => {
          done();
          reject(new Error(String((msg as Record<string, unknown>).message ?? 'Mediasoup error')));
        });
        const offClose = this.on('close', msg => {
          done();
          reject(Object.assign(new Error('WS closed before welcome'), { code: msg.code }));
        });
        this.abortWelcome = () => {
          done();
          reject(new Error('Mediasoup connect cancelled'));
        };
      });
    } catch (e) {
      // connect hỏng giữa chừng thì không để socket treo
      if (this.ws === ws) this.disconnect();
      throw e;
    }
  }

  /** Socket đã đóng (server đóng, mạng rớt hoặc ping timeout): dọn state, huỷ request treo, báo `close` kèm code. */
  private handleClosed(code: number): void {
    this.stopPing();
    this.ws = null;
    this.state = { connected: false, role: null, participantId: null, rtpCapabilities: null };
    this.rejectPending(new Error(`mediasoup ws closed (${code})`));
    this.emit('close', { code });
  }

  private rejectPending(err: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    all.forEach(p => {
      clearTimeout(p.timer);
      p.reject(err);
    });
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  // WS ping frame của server không lộ ra JS nên tự ping bằng message; cũng giữ socket sống qua NAT khi phone rảnh.
  private startPing(ws: WebSocket): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws) return;
      let req: Promise<Record<string, unknown>>;
      try {
        req = this.sendRequest({ type: 'ping' }, PING_TIMEOUT_MS);
      } catch {
        return; // socket không còn OPEN → onclose sẽ tới
      }
      req.catch(e => {
        // Server cũ trả `error` cho ping = socket vẫn sống; chỉ TIMEOUT mới là half-open
        if ((e as { code?: string })?.code !== 'timeout' || this.ws !== ws) return;
        logger.warn('Mediasoup WS ping timeout — đóng socket');
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try {
          ws.close();
        } catch {}
        // không đợi ws.close() xong vì socket half-open có thể treo rất lâu
        this.handleClosed(1006);
      });
    }, PING_INTERVAL_MS);
  }

  // ── Helpers gửi JSON có request_id ──
  private reqId = 0;
  private pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  private send(payload: Record<string, unknown>): string {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Mediasoup WS not open');
    }
    const reqId = `req_${++this.reqId}`;
    const withId = { request_id: reqId, ...payload };
    this.ws.send(JSON.stringify(withId));
    logger.debug('Mediasoup WS send', { type: payload.type, request_id: reqId });
    return reqId;
  }

  public sendRequest(payload: Record<string, unknown>, timeoutMs = 10000): Promise<Record<string, unknown>> {
    const reqId = this.send(payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(
          Object.assign(new Error(`mediasoup request timeout: ${payload.type}`), {
            code: 'timeout',
          }),
        );
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
    });
  }

  // fire-and-forget (giữ API cũ)
  public createTransport(direction: 'send' | 'recv'): void {
    this.send({ type: 'create-transport', direction });
  }

  public connectTransport(transportId: string, dtlsParameters: unknown): void {
    this.send({ type: 'connect-transport', transport_id: transportId, dtls_parameters: dtlsParameters });
  }

  public produce(transportId: string, kind: 'audio' | 'video', rtpParameters: unknown): void {
    this.send({ type: 'produce', transport_id: transportId, kind, rtp_parameters: rtpParameters });
  }

  public consume(transportId: string, producerId: string, rtpCapabilities: unknown): void {
    this.send({ type: 'consume', transport_id: transportId, producer_id: producerId, rtp_capabilities: rtpCapabilities });
  }

  public resumeConsumer(consumerId: string): void {
    this.send({ type: 'resume-consumer', consumer_id: consumerId });
  }

  public getProducers(): void {
    this.send({ type: 'get-producers' });
  }

  // promise-based helpers cho mediasoup-client
  public createTransportAsync(direction: 'send' | 'recv'): Promise<Record<string, unknown>> {
    return this.sendRequest({ type: 'create-transport', direction });
  }
  public connectTransportAsync(transportId: string, dtlsParameters: unknown): Promise<Record<string, unknown>> {
    return this.sendRequest({ type: 'connect-transport', transport_id: transportId, dtls_parameters: dtlsParameters });
  }
  public produceAsync(transportId: string, kind: 'audio' | 'video', rtpParameters: unknown): Promise<Record<string, unknown>> {
    return this.sendRequest({ type: 'produce', transport_id: transportId, kind, rtp_parameters: rtpParameters });
  }
  public consumeAsync(transportId: string, producerId: string, rtpCapabilities: unknown): Promise<Record<string, unknown>> {
    return this.sendRequest({ type: 'consume', transport_id: transportId, producer_id: producerId, rtp_capabilities: rtpCapabilities });
  }
  public resumeConsumerAsync(consumerId: string): Promise<Record<string, unknown>> {
    return this.sendRequest({ type: 'resume-consumer', consumer_id: consumerId });
  }
  public getProducersAsync(): Promise<Record<string, unknown>> {
    return this.sendRequest({ type: 'get-producers' });
  }

  /** WS còn mở thật không (state.connected có thể cũ nếu socket đã chết ngầm). */
  public isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  public disconnect(): void {
    this.connectSeq++;
    this.stopPing();
    this.abortWelcome?.();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      // gỡ handler trước để onclose muộn của socket này không bị coi là mất kết nối
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {}
    }
    this.rejectPending(new Error('mediasoup ws disconnected'));
    this.state = { connected: false, role: null, participantId: null, rtpCapabilities: null };
    this.roomId = null;
    this.previewToken = null;
  }
}

export const mediasoupService = new MediasoupService();
