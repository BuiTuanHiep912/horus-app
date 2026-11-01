/**
 * MediasoupClient Service — WebRTC thực tế cho preview SFU
 * Dùng mediasoup-client + react-native-webrtc qua signaling mediasoupService.
 * Remote: getUserMedia → sendTransport → produce
 * Controller: recvTransport → consume → RTCView stream → resume
 */
import { Platform } from 'react-native';
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
import {
  PROBE_ENCODINGS,
  applyProbeSenderParams,
  attachProbe,
  isProbeActive,
  probeVideoConstraints,
  startProbe,
  stopProbe,
} from './recorderProbe';

// Name kept from the Android-only version; now also true on iOS (modules/webrtc-recorder/ios).
const useAndroidRecorderCapture = () =>
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

class MediasoupClientService {
  private device: DeviceType | null = null;
  private sendTransport: Transport | null = null;
  private recvTransport: Transport | null = null;
  private localStream: any | null = null;
  private consumers = new Map<string, { consumer: any; stream: any; memberId: string }>();
  private videoProducer: any | null = null;
  private audioProducer: any | null = null;
  private facingMode: 'user' | 'environment' = 'environment';

  private producingInFlight: Promise<void> | null = null;

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
    if (this.sendTransport || this.videoProducer || this.audioProducer) {
      logger.warn('startProducing called while previous state alive — stopping old first');
      this.stopProducing();
    }

    const wrtc = await loadWebRTC();
    const ms = await loadMediasoup();

    // 1) Nối signaling nếu chưa — dùng medium để 720p. Kiểm luôn WS còn mở
    // (state.connected có thể "true" nhưng socket đã chết → produce sẽ fail).
    const state = mediasoupService.getState();
    if (!state.connected || !mediasoupService.isOpen()) {
      await mediasoupService.connect(roomId, { quality: 'medium', protocol: 'webrtc' });
    }
    const rtpCaps = mediasoupService.getState().rtpCapabilities as unknown as any;
    if (!rtpCaps) throw new Error('No rtpCapabilities from welcome');

    // 2) Tạo Device
    this.device = new ms.Device();
    await this.device.load({ routerRtpCapabilities: rtpCaps });
    logger.info('mediasoup Device loaded', { canProduceVideo: this.device.canProduce('video') });

    // 3) Lấy local camera — thử facingMode theo state, audio bật echoCancellation để đỡ vọng
    const audioConstraints: any = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    const want1080p = isProbeActive() || useAndroidRecorderCapture();
    try {
      this.localStream = await (
        wrtc.mediaDevices as unknown as { getUserMedia: (c: unknown) => Promise<any> }
      ).getUserMedia({
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
        this.localStream = await (
          wrtc.mediaDevices as unknown as { getUserMedia: (c: unknown) => Promise<any> }
        ).getUserMedia({
          audio: audioConstraints,
          video: { facingMode: this.facingMode, width: 1280, height: 720, frameRate: 30 },
        });
      } catch (e2) {
        logger.warn(`getUserMedia ${this.facingMode} 720p failed, retry fallback`, e2);
        this.localStream = await (
          wrtc.mediaDevices as unknown as { getUserMedia: (c: unknown) => Promise<any> }
        ).getUserMedia({
          audio: audioConstraints,
          video: true,
        });
      }
    }

    // 4) Tạo send transport qua server
    const trRes = (await mediasoupService.createTransportAsync('send')) as unknown as {
      transport_id: string;
      ice_parameters: unknown;
      ice_candidates: unknown;
      dtls_parameters: unknown;
    };
    this.sendTransport = this.device.createSendTransport({
      id: trRes.transport_id,
      iceParameters: trRes.ice_parameters as any,
      iceCandidates: trRes.ice_candidates as any,
      dtlsParameters: trRes.dtls_parameters as any,
    });

    this.sendTransport.on(
      'connect',
      async ({ dtlsParameters }: any, callback: any, errback: any) => {
        try {
          logger.info('sendTransport connect', { dtlsParameters });
          await mediasoupService.connectTransportAsync(trRes.transport_id, dtlsParameters);
          logger.info('sendTransport connected');
          callback();
        } catch (e) {
          logger.error('sendTransport connect failed', e);
          errback(e as Error);
        }
      },
    );
    this.sendTransport.on('connectionstatechange', (state: string) =>
      logger.info('sendTransport connectionstatechange ' + state),
    );
    this.sendTransport.on(
      'produce',
      async ({ kind, rtpParameters }: any, callback: any, errback: any) => {
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
      },
    );

    // 5) Produce (log track details before)
    const videoTrack = this.localStream.getVideoTracks()[0];
    const audioTrack = this.localStream.getAudioTracks()[0];
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
    if (videoTrack && isProbeActive()) {
      // M0 experiment: tap frames, low-bitrate preview sender
      startProbe(videoTrack, () => this.videoProducer);
      this.videoProducer = await this.sendTransport.produce({
        track: videoTrack,
        encodings: PROBE_ENCODINGS,
      });
      await applyProbeSenderParams(this.videoProducer);
    } else if (videoTrack && useAndroidRecorderCapture()) {
      // M4: attach raw-frame recorder tap on the 1080p30 track, produce low-bitrate preview
      this.attachRecorderTap(videoTrack);
      this.videoProducer = await this.sendTransport.produce({
        track: videoTrack,
        encodings: [
          {
            maxBitrate: WEBRTC_PREVIEW_MAX_BITRATE,
            scaleResolutionDownBy: WEBRTC_PREVIEW_SCALE_DOWN_BY,
          },
        ],
      });
    } else if (videoTrack) {
      this.videoProducer = await this.sendTransport.produce({ track: videoTrack });
    }
    if (audioTrack) this.audioProducer = await this.sendTransport.produce({ track: audioTrack });
    logger.info('Producing done', { facingMode: this.facingMode });
    // poll connectionstate after 2s
    setTimeout(
      () =>
        logger.info('sendTransport state after 2s ' + (this.sendTransport as any)?.connectionState),
      2000,
    );
  }

  public async switchCamera(): Promise<'user' | 'environment'> {
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
    if (!this.localStream || !this.videoProducer) {
      logger.info('switchCamera no active producer, just toggle to ' + this.facingMode);
      return this.facingMode;
    }
    const wrtc = await loadWebRTC();
    const newStream = await (
      wrtc.mediaDevices as unknown as { getUserMedia: (c: unknown) => Promise<any> }
    ).getUserMedia({
      video: useAndroidRecorderCapture()
        ? {
            facingMode: this.facingMode,
            width: WEBRTC_RECORDER_VIDEO_WIDTH,
            height: WEBRTC_RECORDER_VIDEO_HEIGHT,
            frameRate: WEBRTC_RECORDER_FPS,
          }
        : { facingMode: this.facingMode, width: 640, height: 480, frameRate: 15 },
      audio: false,
    });
    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) throw new Error('No video track for ' + this.facingMode);
    await this.videoProducer.replaceTrack({ track: newTrack });
    const oldTrack = this.localStream.getVideoTracks()[0];
    try {
      oldTrack?.stop();
    } catch {}
    // replace in localStream
    this.localStream.removeTrack(oldTrack);
    this.localStream.addTrack(newTrack);
    attachProbe(newTrack);
    if (useAndroidRecorderCapture()) {
      this.attachRecorderTap(newTrack);
    }
    logger.info('switchCamera done ' + this.facingMode);
    return this.facingMode;
  }
  public getFacingMode(): string {
    return this.facingMode;
  }

  public stopProducing(): void {
    try {
      stopProbe();
    } catch (e) {
      logger.warn('[probe] stop failed', e);
    }
    try {
      this.localStream?.getTracks().forEach((t: any) => t.stop());
    } catch {}
    try {
      this.sendTransport?.close();
    } catch {}
    this.sendTransport = null;
    this.localStream = null;
    this.videoProducer = null;
    this.audioProducer = null;
  }

  public async startConsuming(
    roomId: string,
    onStream: (memberId: string, stream: any) => void,
    onClose?: (memberId: string) => void,
  ): Promise<() => void> {
    const ms = await loadMediasoup();
    await loadWebRTC();

    const state = mediasoupService.getState();
    if (!state.connected || !mediasoupService.isOpen()) {
      await mediasoupService.connect(roomId, { quality: 'low', protocol: 'webrtc' });
    }
    const rtpCaps = mediasoupService.getState().rtpCapabilities as unknown as any;
    if (!this.device) {
      this.device = new ms.Device();
      await this.device.load({ routerRtpCapabilities: rtpCaps });
    }

    // Tạo recv transport
    const trRes = (await mediasoupService.createTransportAsync('recv')) as unknown as {
      transport_id: string;
      ice_parameters: unknown;
      ice_candidates: unknown;
      dtls_parameters: unknown;
    };
    this.recvTransport = this.device.createRecvTransport({
      id: trRes.transport_id,
      iceParameters: trRes.ice_parameters as any,
      iceCandidates: trRes.ice_candidates as any,
      dtlsParameters: trRes.dtls_parameters as any,
    });
    this.recvTransport.on(
      'connect',
      async ({ dtlsParameters }: any, callback: any, errback: any) => {
        try {
          await mediasoupService.connectTransportAsync(trRes.transport_id, dtlsParameters);
          callback();
        } catch (e) {
          errback(e as Error);
        }
      },
    );

    // Lấy danh sách producer hiện có
    try {
      const list = (await mediasoupService.getProducersAsync()) as unknown as {
        producers: { member_id: string; producer_id: string; kind: string }[];
      };
      for (const p of list.producers ?? []) {
        await this.consumeOne(p.member_id, p.producer_id, onStream);
      }
    } catch (e) {
      logger.warn('getProducers failed', e);
    }

    // Lắng new-producer / producer-closed
    const offNew = mediasoupService.on('new-producer', async msg => {
      const m = msg as unknown as { member_id: string; producer_id: string; kind: string };
      await this.consumeOne(m.member_id, m.producer_id, onStream);
    });
    const offClosed = mediasoupService.on('producer-closed', msg => {
      const m = msg as unknown as { producer_id: string };
      const entry = [...this.consumers.entries()].find(
        ([, v]) => v.consumer.producerId === m.producer_id,
      );
      if (entry) {
        try {
          entry[1].consumer.close();
        } catch {}
        this.consumers.delete(entry[0]);
        onClose?.(entry[1].memberId);
      }
    });

    return () => {
      offNew();
      offClosed();
      try {
        this.recvTransport?.close();
      } catch {}
      this.recvTransport = null;
    };
  }

  private async consumeOne(
    memberId: string,
    producerId: string,
    onStream: (memberId: string, stream: any) => void,
  ): Promise<void> {
    if (!this.device || !this.recvTransport) return;
    if ([...this.consumers.values()].some(v => v.consumer.producerId === producerId)) return;
    try {
      const res = (await mediasoupService.consumeAsync(
        this.recvTransport.id,
        producerId,
        this.device.rtpCapabilities,
      )) as unknown as {
        consumer_id: string;
        producer_id: string;
        kind: string;
        rtp_parameters: unknown;
      };
      const consumer = await this.recvTransport.consume({
        id: res.consumer_id,
        producerId: res.producer_id,
        kind: res.kind as 'audio' | 'video',
        rtpParameters: res.rtp_parameters as any,
      });
      const stream = new (await loadWebRTC()).MediaStream();
      // @ts-ignore react-native-webrtc MediaStream addTrack
      (stream as unknown as { addTrack: (t: unknown) => void }).addTrack(consumer.track);
      this.consumers.set(consumer.id, { consumer, stream, memberId });
      onStream(memberId, stream as unknown as any);
      await mediasoupService.resumeConsumerAsync(consumer.id);
      if (consumer.kind === 'video' && typeof consumer.requestKeyFrame === 'function') {
        consumer.requestKeyFrame().catch(() => undefined);
        setTimeout(() => {
          try {
            consumer.requestKeyFrame().catch(() => {});
          } catch {}
        }, 300);
      }
      logger.info('Consuming', { producerId, memberId });
    } catch (e) {
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
    try {
      this.recvTransport?.close();
    } catch {}
    this.recvTransport = null;
    this.consumers.clear();
    mediasoupService.disconnect();
  }
}

export const mediasoupClientService = new MediasoupClientService();
