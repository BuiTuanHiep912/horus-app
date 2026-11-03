/**
 * MediasoupClient Service — WebRTC thực tế cho preview SFU
 * Dùng mediasoup-client + react-native-webrtc qua signaling mediasoupService.
 * Remote: getUserMedia → sendTransport → produce
 * Controller: recvTransport → consume → RTCView stream → resume
 */
import { AppState, Platform } from 'react-native';
import {
  USE_WEBRTC_RECORDER_ON_ANDROID,
  USE_WEBRTC_RECORDER_ON_IOS,
  WEBRTC_PREVIEW_MAX_BITRATE,
  WEBRTC_PREVIEW_SCALE_DOWN_BY,
  WEBRTC_RECORDER_FPS,
  WEBRTC_RECORDER_VIDEO_HEIGHT,
  WEBRTC_RECORDER_VIDEO_WIDTH,
} from '../constants/config';
import { WebrtcRecorder } from '../../modules/webrtc-recorder';
import { logger } from '../utils/logger';
import { mediasoupService } from './mediasoup';
import { reconnectDelayMs } from './reconnectDelay';
import {
  PROBE_ENCODINGS,
  applyProbeSenderParams,
  attachProbe,
  isProbeActive,
  probeVideoConstraints,
  startProbe,
  stopProbe,
} from './recorderProbe';

// WebRTC track recorder capture (modules/webrtc-recorder): Android + iOS.
const isTrackRecorderCaptureEnabled = () =>
  ((Platform.OS === 'android' && USE_WEBRTC_RECORDER_ON_ANDROID) ||
    (Platform.OS === 'ios' && USE_WEBRTC_RECORDER_ON_IOS)) &&
  WebrtcRecorder != null;

// Lazy import để web (không có react-native-webrtc) vẫn tsc được
let webrtc: any | null = null;
let mediasoupClient: any | null = null;

async function loadWebRTC(): Promise<any> {
  if (!webrtc) {
    try {
      // @ts-ignore — optional dep, installed via npm i react-native-webrtc
      webrtc = await import('react-native-webrtc');
      (webrtc as unknown as { registerGlobals: () => void }).registerGlobals?.();
    } catch (e: any) {
      const msg =
        'webrtc native module not found — Expo Go không có react-native-webrtc. Chạy: npx expo prebuild && npx expo run:android (hoặc run:ios) để tạo dev-client, hoặc `eas build --profile development`. Không dùng `npx expo start` với Expo Go cho preview.';
      logger.warn('react-native-webrtc not available (need dev-client)', {
        err: e?.message ?? String(e),
      });
      throw new Error(msg);
    }
  }
  return webrtc;
}

async function loadMediasoup(): Promise<any> {
  if (!mediasoupClient) {
    // @ts-ignore — optional dep, installed via npm i mediasoup-client
    mediasoupClient = await import('mediasoup-client');
  }
  return mediasoupClient;
}

type Transport = any;
type DeviceType = any;

export type PreviewState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'failed';
type StateListener = (state: PreviewState, detail?: string) => void;

const TRANSPORT_DOWN_MS = 5000;

// Server báo room đã đóng / không còn là member, hoặc socket bị instance khác thay (4001): retry vô ích
const isTerminalError = (e: any): boolean =>
  // 9992/9998: REST preview-token báo phòng không còn / token hỏng hẳn
  ['4001', '9992', '9998'].includes(String(e?.code)) ||
  /room not found or closed|not an active member of this room/.test(String(e?.message ?? e));

class MediasoupClientService {
  private device: DeviceType | null = null;
  private sendTransport: Transport | null = null;
  // Send transport cũ khi đang nối lại: giữ mở tới khi cái mới lên (xem lose())
  private heldSend: Transport | null = null;
  private recvTransport: Transport | null = null;
  private localStream: any | null = null;
  private consumers = new Map<string, { consumer: any; stream: any; memberId: string }>();
  private consuming = new Set<string>();
  private videoProducer: any | null = null;
  private audioProducer: any | null = null;
  private facingMode: 'user' | 'environment' = 'environment';

  private producingInFlight: Promise<void> | null = null;

  // ── Vòng nối lại dùng chung cho remote và controller ──
  private role: 'remote' | 'controller' | null = null;
  private roomId: string | null = null;
  private state: PreviewState = 'idle';
  private stateDetail: string | undefined;
  private listeners = new Set<StateListener>();
  // Mỗi attempt/cancel tăng gen; attempt async cũ thấy gen lệch thì bỏ, không được đụng state
  private gen = 0;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private downTimer: ReturnType<typeof setTimeout> | null = null;
  private appStateSub: { remove: () => void } | null = null;
  private offSignal: (() => void)[] = [];
  private onStream?: (memberId: string, stream: any) => void;
  private onClose?: (memberId: string) => void;
  private onMemberState?: (memberId: string, iceState: string) => void;

  public getPreviewState(): PreviewState {
    return this.state;
  }

  /** Gọi ngay với state hiện tại, rồi mỗi lần đổi. Trả về hàm huỷ đăng ký. */
  public subscribe(fn: StateListener): () => void {
    this.listeners.add(fn);
    fn(this.state, this.stateDetail);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private setState(state: PreviewState, detail?: string): void {
    if (state === this.state && detail === this.stateDetail) return;
    this.state = state;
    this.stateDetail = detail;
    logger.info('preview state ' + state + (detail ? ` (${detail})` : ''));
    this.listeners.forEach(fn => {
      try {
        fn(state, detail);
      } catch (e) {
        logger.error('preview state listener error', e);
      }
    });
  }

  /** Huỷ retry và attempt đang bay. KHÔNG đóng transport, KHÔNG dừng track (recorder đang tap camera). */
  private cancelLoop(): void {
    this.gen++;
    this.attempt = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.downTimer) clearTimeout(this.downTimer);
    this.retryTimer = this.downTimer = null;
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.unwatchSignaling();
    this.setState('idle');
  }

  private begin(role: 'remote' | 'controller', roomId: string): number {
    this.cancelLoop();
    this.role = role;
    this.roomId = roomId;
    this.setState('connecting');
    this.appStateSub = AppState.addEventListener('change', s => {
      if (s === 'active' && this.state === 'reconnecting') this.retryNow();
    });
    return this.gen;
  }

  private watchSignaling(): void {
    this.offSignal.push(
      mediasoupService.on('close', msg => {
        if (this.state !== 'live') return; // đang dựng: attempt tự lỗi vì request bị reject
        // Socket cũ đã bị bỏ qua ở tầng signaling nên 4001 ở đây là socket HIỆN TẠI bị instance khác thay
        if (msg.code === 4001) this.fail('replaced');
        else this.lose(`signaling closed (${msg.code})`);
      }),
    );
  }

  private unwatchSignaling(): void {
    this.offSignal.forEach(off => off());
    this.offSignal = [];
  }

  private onTransportState(transport: Transport, s: string): void {
    if (transport !== this.sendTransport && transport !== this.recvTransport) return;
    logger.info(`${this.role} transport connectionstatechange ${s}`);
    if (s !== 'disconnected' && this.downTimer) {
      clearTimeout(this.downTimer);
      this.downTimer = null;
    }
    if (s === 'failed') this.lose('transport failed');
    else if (s === 'disconnected' && !this.downTimer) {
      this.downTimer = setTimeout(() => {
        this.downTimer = null;
        this.lose('transport disconnected >5s');
      }, TRANSPORT_DOWN_MS);
    }
  }

  private lose(reason: string): void {
    if (this.state !== 'live') return;
    if (this.downTimer) clearTimeout(this.downTimer);
    this.downTimer = null;
    // Remote: KHÔNG đóng PC cũ ngay. Đóng PC là hết sender giữ track → WebRTC ngừng kéo audio/video
    // từ track, recorder (tap trên chính track này) bị đói frame suốt lúc nối lại.
    // Chỉ ngừng dùng nó; đóng sau khi transport mới produce xong (goLive) hoặc khi dừng hẳn.
    this.holdSend();
    this.setState('reconnecting', reason);
    this.scheduleRetry();
  }

  private holdSend(): void {
    if (!this.sendTransport) return;
    this.closeTransport(this.heldSend);
    this.heldSend = this.sendTransport;
    this.sendTransport = null;
    this.videoProducer = null;
    this.audioProducer = null;
  }

  private scheduleRetry(): void {
    const delay = reconnectDelayMs(this.attempt++);
    logger.info(`preview reconnect in ${delay}ms (lần ${this.attempt})`);
    this.retryTimer = setTimeout(() => void this.runAttempt(), delay);
  }

  private retryNow(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.runAttempt();
  }

  private async runAttempt(): Promise<void> {
    this.retryTimer = null;
    const gen = ++this.gen; // bỏ attempt đang treo (nếu có)
    try {
      const ms = await loadMediasoup();
      if (this.role === 'remote') await this.rebuildProducer(ms, gen);
      else await this.buildConsumer(ms, gen);
      if (gen !== this.gen) return;
      this.goLive();
    } catch (e) {
      if (gen !== this.gen) return;
      if (isTerminalError(e)) {
        this.fail(String((e as Error)?.message ?? 'closed'));
        return;
      }
      logger.warn('preview reconnect attempt failed', e);
      this.scheduleRetry();
    }
  }

  private goLive(): void {
    // socket có thể đã chết ngay trong lúc dựng mà không request nào kịp lỗi
    if (!mediasoupService.isOpen()) throw new Error('signaling closed');
    this.attempt = 0;
    this.closeTransport(this.heldSend);
    this.heldSend = null;
    this.setState('live');
  }

  /** Dừng hẳn, không retry. Remote giữ nguyên localStream/track để bản ghi đang chạy không bị ngắt. */
  private fail(reason: string): void {
    this.cancelLoop();
    // Như lose(): recorder còn cần sender kéo track; stopProducing() mới đóng hẳn
    this.holdSend();
    this.closeConsumers(true); // xoá tile đóng băng trên controller
    mediasoupService.disconnect();
    this.setState('failed', reason);
  }

  private closeTransport(transport: Transport | null): void {
    try {
      transport?.close();
    } catch {}
  }

  private closeSend(): void {
    this.closeTransport(this.sendTransport);
    this.closeTransport(this.heldSend);
    this.sendTransport = this.heldSend = null;
    this.videoProducer = null;
    this.audioProducer = null;
  }

  public async startProducing(roomId: string): Promise<void> {
    // Guard cấp service (singleton): chặn 2 lần produce chạy SONG SONG. Nếu chạy song
    // song, dòng `this.device = new ms.Device()` của luồng sau sẽ ghi đè device đang
    // load của luồng trước → createSendTransport ném "device not loaded". Guard ở đây
    // bảo vệ bất kể UI gọi startProducing trùng thế nào.
    if (this.producingInFlight) {
      logger.warn('startProducing already in flight — await existing (chống produce trùng)');
      return this.producingInFlight;
    }
    const p = this.startProducingInternal(roomId).finally(() => {
      this.producingInFlight = null;
    });
    this.producingInFlight = p;
    return p;
  }

  private async startProducingInternal(roomId: string): Promise<void> {
    // Dọn cũ trước — phòng trường hợp lệnh start_record bắn 2 lần liên tiếp mà
    // track trước chưa đóng: nếu còn sendTransport/producer cũ mà produce tiếp sẽ
    // tạo 2 bộ producer cho cùng 1 camera → controller hiện nhiều preview + 1 cái đen
    // (GUM thứ 2 tranh camera). Luôn bắt đầu sạch.
    if (this.sendTransport || this.videoProducer || this.audioProducer || this.localStream) {
      logger.warn('startProducing called while previous state alive — stopping old first');
      this.stopProducing();
    }

    const wrtc = await loadWebRTC();
    const ms = await loadMediasoup();

    const gen = this.begin('remote', roomId);
    try {
      // 1) Nối signaling — dùng medium để 720p
      await mediasoupService.connect(roomId, { quality: 'medium', protocol: 'webrtc' });
      if (gen !== this.gen) return;
      this.watchSignaling();

      // 2) Lấy local camera — thử facingMode theo state, audio bật echoCancellation để đỡ vọng
      const stream = await this.openLocalStream(wrtc);
      if (gen !== this.gen) {
        stream.getTracks().forEach((t: any) => t.stop());
        return;
      }
      this.localStream = stream;

      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];
      logger.info('localTracks', {
        video: videoTrack
          ? {
              enabled: videoTrack.enabled,
              muted: (videoTrack as any).muted,
              readyState: (videoTrack as any).readyState,
              settings: (videoTrack as any).getSettings?.(),
            }
          : null,
        audio: audioTrack
          ? { enabled: audioTrack.enabled, readyState: (audioTrack as any).readyState }
          : null,
      });
      // Tap chỉ gắn một lần lên track: reconnect dùng lại đúng track này nên không gắn lại
      if (videoTrack && isProbeActive()) {
        // M0 experiment: tap frames, low-bitrate preview sender
        startProbe(videoTrack, () => this.videoProducer);
      } else if (videoTrack && isTrackRecorderCaptureEnabled()) {
        // M4: attach raw-frame recorder tap on the 1080p30 track, produce low-bitrate preview
        this.attachRecorderTap(videoTrack);
      }

      // 3) Device + send transport + produce
      await this.publish(ms, gen);
      if (gen !== this.gen) return;
      this.goLive();
      logger.info('Producing done', { facingMode: this.facingMode });
      // poll connectionstate after 2s
      setTimeout(
        () =>
          logger.info(
            'sendTransport state after 2s ' + (this.sendTransport as any)?.connectionState,
          ),
        2000,
      );
      // Debug: confirms the preview really carries mic audio (on iOS it comes from the custom
      // WRAudioDevice, not WebRTC's built-in one).
      setTimeout(() => void this.logAudioSendStats(), 5000);
    } catch (e) {
      // Start lần đầu lỗi thì trả lỗi cho UI như trước và nhả camera; không retry ngầm
      if (gen === this.gen) this.stopProducing();
      throw e;
    }
  }

  private async openLocalStream(wrtc: any): Promise<any> {
    const audioConstraints: any = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    const gum = (c: unknown) =>
      (wrtc.mediaDevices as unknown as { getUserMedia: (c: unknown) => Promise<any> }).getUserMedia(
        c,
      );
    const want1080p = isProbeActive() || isTrackRecorderCaptureEnabled();
    try {
      return await gum({
        audio: audioConstraints,
        video: isProbeActive()
          ? probeVideoConstraints(this.facingMode)
          : want1080p
            ? {
                facingMode: this.facingMode,
                width: WEBRTC_RECORDER_VIDEO_WIDTH,
                height: WEBRTC_RECORDER_VIDEO_HEIGHT,
                frameRate: WEBRTC_RECORDER_FPS,
              }
            : { facingMode: this.facingMode, width: 1280, height: 720, frameRate: 30 },
      });
    } catch (e) {
      logger.warn(`getUserMedia ${this.facingMode} primary failed, retry 720p/640p`, e);
      try {
        return await gum({
          audio: audioConstraints,
          video: { facingMode: this.facingMode, width: 1280, height: 720, frameRate: 30 },
        });
      } catch (e2) {
        logger.warn(`getUserMedia ${this.facingMode} 720p failed, retry fallback`, e2);
        return await gum({ audio: audioConstraints, video: true });
      }
    }
  }

  /**
   * Device + send transport + produce các track của localStream (không đụng getUserMedia).
   * Dùng chung cho startProducing và reconnect.
   */
  private async publish(ms: any, gen: number): Promise<void> {
    const rtpCaps = mediasoupService.getState().rtpCapabilities as unknown as any;
    if (!rtpCaps) throw new Error('No rtpCapabilities from welcome');
    const device = new ms.Device();
    await device.load({ routerRtpCapabilities: rtpCaps });
    // Attempt cũ không được gửi create-transport lên socket của attempt mới
    if (gen !== this.gen) return;
    logger.info('mediasoup Device loaded', { canProduceVideo: device.canProduce('video') });

    const trRes = (await mediasoupService.createTransportAsync('send')) as unknown as {
      transport_id: string;
      ice_parameters: unknown;
      ice_candidates: unknown;
      dtls_parameters: unknown;
    };
    if (gen !== this.gen) return;
    this.device = device;
    const transport = device.createSendTransport({
      id: trRes.transport_id,
      iceParameters: trRes.ice_parameters as any,
      iceCandidates: trRes.ice_candidates as any,
      dtlsParameters: trRes.dtls_parameters as any,
    });
    this.sendTransport = transport;

    transport.on('connect', async ({ dtlsParameters }: any, callback: any, errback: any) => {
      try {
        logger.info('sendTransport connect', { dtlsParameters });
        await mediasoupService.connectTransportAsync(trRes.transport_id, dtlsParameters);
        logger.info('sendTransport connected');
        callback();
      } catch (e) {
        logger.error('sendTransport connect failed', e);
        errback(e as Error);
      }
    });
    transport.on('connectionstatechange', (s: string) => this.onTransportState(transport, s));
    transport.on('produce', async ({ kind, rtpParameters }: any, callback: any, errback: any) => {
      try {
        logger.info('sendTransport produce kind=' + kind);
        const res = (await mediasoupService.produceAsync(
          trRes.transport_id,
          kind,
          rtpParameters,
        )) as unknown as { producer_id: string };
        logger.info('produced ' + kind + ' id=' + res.producer_id);
        callback({ id: res.producer_id });
      } catch (e) {
        logger.error('produce failed kind=' + kind, e);
        errback(e as Error);
      }
    });

    const videoTrack = this.localStream?.getVideoTracks()[0];
    const audioTrack = this.localStream?.getAudioTracks()[0];
    // stopTracks:false — mặc định mediasoup-client dừng track khi đóng transport/producer,
    // mà reconnect đóng transport cũ còn recorder đang tap chính track camera này
    if (videoTrack) {
      const producer = await transport.produce({
        track: videoTrack,
        encodings: isProbeActive()
          ? PROBE_ENCODINGS
          : isTrackRecorderCaptureEnabled()
            ? [
                {
                  maxBitrate: WEBRTC_PREVIEW_MAX_BITRATE,
                  scaleResolutionDownBy: WEBRTC_PREVIEW_SCALE_DOWN_BY,
                },
              ]
            : undefined,
        stopTracks: false,
      });
      if (gen !== this.gen) return;
      this.videoProducer = producer;
      await applyProbeSenderParams(producer);
    }
    if (audioTrack) {
      const producer = await transport.produce({ track: audioTrack, stopTracks: false });
      if (gen !== this.gen) return;
      this.audioProducer = producer;
    }
  }

  private async logAudioSendStats(): Promise<void> {
    try {
      const report = await this.audioProducer?.getStats();
      report?.forEach((r: any) => {
        if (r.type === 'outbound-rtp') {
          logger.debug('[audio] preview send', {
            packetsSent: r.packetsSent,
            bytesSent: r.bytesSent,
          });
        } else if (r.type === 'media-source') {
          // Non-zero energy means real mic samples, not silence.
          logger.debug('[audio] preview source', {
            audioLevel: r.audioLevel,
            totalAudioEnergy: r.totalAudioEnergy,
          });
        }
      });
    } catch (e) {
      logger.debug('[audio] getStats failed', e);
    }
  }

  /** Nối lại: signaling + Device + send transport mới, produce lại đúng track cũ. */
  private async rebuildProducer(ms: any, gen: number): Promise<void> {
    this.unwatchSignaling();
    // Chỉ dọn transport dang dở của attempt trước; heldSend (PC cũ) giữ nguyên
    this.closeTransport(this.sendTransport);
    this.sendTransport = null;
    this.videoProducer = null;
    this.audioProducer = null;
    await mediasoupService.connect(this.roomId!, { quality: 'medium', protocol: 'webrtc' });
    if (gen !== this.gen) return;
    this.watchSignaling();
    await this.publish(ms, gen);
  }

  public async switchCamera(): Promise<'user' | 'environment'> {
    if (this.state === 'reconnecting')
      throw new Error('Preview đang kết nối lại — thử đổi cam sau');
    const prevFacing = this.facingMode;
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
    if (!this.localStream || !this.videoProducer) {
      logger.info('switchCamera no active producer, just toggle to ' + this.facingMode);
      return this.facingMode;
    }
    const wrtc = await loadWebRTC();
    let newTrack: any;
    try {
      const newStream = await (
        wrtc.mediaDevices as unknown as { getUserMedia: (c: unknown) => Promise<any> }
      ).getUserMedia({
        video: isTrackRecorderCaptureEnabled()
          ? {
              facingMode: this.facingMode,
              width: WEBRTC_RECORDER_VIDEO_WIDTH,
              height: WEBRTC_RECORDER_VIDEO_HEIGHT,
              frameRate: WEBRTC_RECORDER_FPS,
            }
          : { facingMode: this.facingMode, width: 640, height: 480, frameRate: 15 },
        audio: false,
      });
      newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) throw new Error('No video track for ' + this.facingMode);
      // Đọc producer SAU khi getUserMedia xong: reconnect có thể đã thay producer trong lúc chờ
      const producer = this.videoProducer;
      if (!producer || this.state !== 'live') throw new Error('Preview vừa mất kết nối');
      await producer.replaceTrack({ track: newTrack });
    } catch (e) {
      try {
        newTrack?.stop();
      } catch {}
      this.facingMode = prevFacing;
      throw e;
    }
    const oldTrack = this.localStream.getVideoTracks()[0];
    try {
      oldTrack?.stop();
    } catch {}
    // replace in localStream
    this.localStream.removeTrack(oldTrack);
    this.localStream.addTrack(newTrack);
    attachProbe(newTrack);
    if (isTrackRecorderCaptureEnabled()) {
      this.attachRecorderTap(newTrack);
    }
    logger.info('switchCamera done ' + this.facingMode);
    return this.facingMode;
  }
  public getFacingMode(): string {
    return this.facingMode;
  }

  public stopProducing(): void {
    this.cancelLoop();
    try {
      stopProbe();
    } catch (e) {
      logger.warn('[probe] stop failed', e);
    }
    try {
      this.localStream?.getTracks().forEach((t: any) => t.stop());
    } catch {}
    this.closeSend();
    this.localStream = null;
  }

  public async startConsuming(
    roomId: string,
    onStream: (memberId: string, stream: any) => void,
    onClose?: (memberId: string) => void,
    onMemberState?: (memberId: string, iceState: string) => void,
  ): Promise<() => void> {
    this.disconnect(); // bắt đầu sạch để không chồng consumer/listener nếu gọi lại
    const ms = await loadMediasoup();
    await loadWebRTC();

    this.onStream = onStream;
    this.onClose = onClose;
    this.onMemberState = onMemberState;
    const gen = this.begin('controller', roomId);
    try {
      await this.buildConsumer(ms, gen);
      if (gen === this.gen) this.goLive();
    } catch (e) {
      if (gen === this.gen) this.disconnect();
      throw e;
    }
    return () => this.disconnect();
  }

  /** Signaling + Device + recv transport mới + consume mọi producer hiện có. Dùng cho lần đầu lẫn nối lại. */
  private async buildConsumer(ms: any, gen: number): Promise<void> {
    this.unwatchSignaling();
    this.closeConsumers(true);
    await mediasoupService.connect(this.roomId!, { quality: 'low', protocol: 'webrtc' });
    if (gen !== this.gen) return;
    this.watchSignaling();
    // Đăng ký trước get-producers để producer xuất hiện giữa chừng không bị sót (consumeOne tự chống trùng)
    this.offSignal.push(
      mediasoupService.on('new-producer', msg => {
        const m = msg as unknown as { member_id: string; producer_id: string };
        void this.consumeOne(m.member_id, m.producer_id);
      }),
      mediasoupService.on('producer-closed', msg => {
        const m = msg as unknown as { producer_id: string };
        const entry = [...this.consumers.entries()].find(
          ([, v]) => v.consumer.producerId === m.producer_id,
        );
        if (!entry) return;
        const [consumerId, { consumer, memberId }] = entry;
        try {
          consumer.close();
        } catch {}
        this.consumers.delete(consumerId);
        this.consuming.delete(m.producer_id);
        // Chỉ video đóng mới làm mất tile; audio đóng thì tile vẫn còn
        if (consumer.kind === 'video') this.onClose?.(memberId);
      }),
      mediasoupService.on('member-state', msg => {
        const m = msg as unknown as { member_id: string; ice_state: string };
        this.onMemberState?.(m.member_id, m.ice_state);
      }),
    );

    const rtpCaps = mediasoupService.getState().rtpCapabilities as unknown as any;
    if (!rtpCaps) throw new Error('No rtpCapabilities from welcome');
    const device = new ms.Device();
    await device.load({ routerRtpCapabilities: rtpCaps });
    if (gen !== this.gen) return;

    const trRes = (await mediasoupService.createTransportAsync('recv')) as unknown as {
      transport_id: string;
      ice_parameters: unknown;
      ice_candidates: unknown;
      dtls_parameters: unknown;
    };
    if (gen !== this.gen) return;
    this.device = device;
    const transport = device.createRecvTransport({
      id: trRes.transport_id,
      iceParameters: trRes.ice_parameters as any,
      iceCandidates: trRes.ice_candidates as any,
      dtlsParameters: trRes.dtls_parameters as any,
    });
    this.recvTransport = transport;
    transport.on('connect', async ({ dtlsParameters }: any, callback: any, errback: any) => {
      try {
        await mediasoupService.connectTransportAsync(trRes.transport_id, dtlsParameters);
        callback();
      } catch (e) {
        errback(e as Error);
      }
    });
    transport.on('connectionstatechange', (s: string) => this.onTransportState(transport, s));

    // Lấy danh sách producer hiện có (lỗi ở đây = socket hỏng → để attempt lỗi và retry)
    const list = (await mediasoupService.getProducersAsync()) as unknown as {
      producers: { member_id: string; producer_id: string; kind: string; ice_state?: string }[];
    };
    if (gen !== this.gen) return;
    for (const p of list.producers ?? []) {
      if (p.ice_state) this.onMemberState?.(p.member_id, p.ice_state);
      await this.consumeOne(p.member_id, p.producer_id);
    }
  }

  private closeConsumers(notify: boolean): void {
    const videoMembers = new Set<string>();
    for (const { consumer, memberId } of this.consumers.values()) {
      if (consumer.kind === 'video') videoMembers.add(memberId);
      try {
        consumer.close();
      } catch {}
    }
    this.consumers.clear();
    this.consuming.clear();
    try {
      this.recvTransport?.close();
    } catch {}
    this.recvTransport = null;
    if (notify) videoMembers.forEach(m => this.onClose?.(m));
  }

  private async consumeOne(memberId: string, producerId: string): Promise<void> {
    const transport = this.recvTransport;
    const device = this.device;
    if (!device || !transport || this.consuming.has(producerId)) return;
    this.consuming.add(producerId);
    try {
      const wrtc = await loadWebRTC();
      const res = (await mediasoupService.consumeAsync(
        transport.id,
        producerId,
        device.rtpCapabilities,
      )) as unknown as {
        consumer_id: string;
        producer_id: string;
        kind: string;
        rtp_parameters: unknown;
      };
      const consumer = await transport.consume({
        id: res.consumer_id,
        producerId: res.producer_id,
        kind: res.kind as 'audio' | 'video',
        rtpParameters: res.rtp_parameters as any,
      });
      if (this.recvTransport !== transport) {
        consumer.close(); // đã rebuild trong lúc chờ
        return;
      }
      const stream = new wrtc.MediaStream();
      // @ts-ignore react-native-webrtc MediaStream addTrack
      (stream as unknown as { addTrack: (t: unknown) => void }).addTrack(consumer.track);
      this.consumers.set(consumer.id, { consumer, stream, memberId });
      // Chỉ video lên tile (nếu cả audio cũng gọi thì stream audio ghi đè stream video → tile đen).
      // Audio vẫn được consume + resume để phát tiếng.
      if (consumer.kind === 'video') this.onStream?.(memberId, stream as unknown as any);
      await mediasoupService.resumeConsumerAsync(consumer.id);
      if (consumer.kind === 'video' && typeof consumer.requestKeyFrame === 'function') {
        consumer.requestKeyFrame().catch(() => undefined);
        setTimeout(() => {
          try {
            consumer.requestKeyFrame().catch(() => {});
          } catch {}
        }, 300);
      }
      logger.info('Consuming', { producerId, memberId, kind: consumer.kind });
    } catch (e) {
      if (this.recvTransport !== transport) return;
      this.consuming.delete(producerId);
      logger.error('consumeOne failed', e);
    }
  }

  public attachRecorderTap(videoTrack?: any): void {
    const track = videoTrack ?? this.localStream?.getVideoTracks?.()[0];
    if (!track || !WebrtcRecorder) return;
    try {
      WebrtcRecorder.setRawFrameMode(true);
      const procName = WebrtcRecorder.getProcessorName();
      (track as { _setVideoEffects?: (names: string[]) => void })._setVideoEffects?.([procName]);
    } catch (e) {
      logger.warn('attachRecorderTap failed', e);
    }
  }

  public getLocalVideoTrack(): any | null {
    return this.localStream?.getVideoTracks?.()[0] ?? null;
  }

  public getLocalStream(): any | null {
    return this.localStream;
  }
  public getConsumers(): Map<string, { consumer: any; stream: any; memberId: string }> {
    return this.consumers;
  }
  public disconnect(): void {
    this.stopProducing();
    this.closeConsumers(false);
    mediasoupService.disconnect();
  }
}

export const mediasoupClientService = new MediasoupClientService();
