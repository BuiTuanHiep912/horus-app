/**
 * ControllerScreen — theo dõi nhiều phone (Remote) đang stream về server cùng lúc.
 * - Tạo/quản lý phòng, mã mời, duyệt/kick thành viên
 * - Lưới video (grid) hiển thị tất cả camera đang phát — tap camera để xem fullscreen
 * - Gửi set_camera_config (Flash/zoom), start/stop recording
 */
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing, radius } from '../constants/theme';
import { logger } from '../utils/logger';
import {
  createRoom,
  refreshInviteCode,
  joinRoom,
  leaveRoom,
  setCameraConfig,
  closeRoom,
  approveMember,
  denyMember,
  kickMember,
  listMyRooms,
} from '../api/rooms';
import type { MyRoom } from '../api/rooms';
import { getDeviceId } from '../utils/device';
import { useRoomSync } from '../hooks/useRoomSync';
import { useAuthSession } from '../hooks/useAuthSession';
import { mediasoupClientService, type PreviewState } from '../services/mediasoupClient';
import { ApiError } from '../api/client';

function RTCFrame({
  stream,
  name,
  sub,
  onPress,
}: {
  stream: any;
  name: string;
  sub?: string;
  onPress?: () => void;
}) {
  return (
    <View style={styles.frameWrap}>
      {Platform.OS !== 'web' ? (
        (() => {
          try {
            const { RTCView } = require('react-native-webrtc');
            return (
              <RTCView streamURL={stream.toURL()} style={styles.frameVideo} objectFit="contain" />
            );
          } catch {
            return (
              <View style={[styles.frameVideo, styles.frameError]}>
                <Text style={styles.muted}>RTCView lỗi</Text>
              </View>
            );
          }
        })()
      ) : (
        <View style={[styles.frameVideo, styles.frameError]}>
          <Text style={styles.muted}>RTCView chỉ native</Text>
        </View>
      )}
      <View style={styles.frameBadge}>
        <View style={styles.liveDot} />
        <Text style={styles.frameName} numberOfLines={1}>
          {name}
        </Text>
        {sub ? (
          <Text style={styles.frameSub} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      {onPress ? (
        <TouchableOpacity style={styles.frameTap} onPress={onPress} activeOpacity={0.9} />
      ) : null}
    </View>
  );
}

export default function ControllerScreen() {
  const { width } = useWindowDimensions();
  const [roomId, setRoomId] = useState<string | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [inviteExpires, setInviteExpires] = useState<string | null>(null);
  const [inviteExpired, setInviteExpired] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const { data: syncData } = useRoomSync(roomId, !!roomId);
  const [mediaLog, setMediaLog] = useState<string[]>([]);
  const [streams, setStreams] = useState<Map<string, any>>(new Map());
  const [iceStates, setIceStates] = useState<Map<string, string>>(new Map());
  const [previewState, setPreviewState] = useState<PreviewState>('idle');
  const [previewDetail, setPreviewDetail] = useState<string | undefined>();
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [fullMember, setFullMember] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joinLog, setJoinLog] = useState<string[]>([]);
  const [autoApprove, setAutoApprove] = useState<0 | 1>(1);
  const [myRooms, setMyRooms] = useState<MyRoom[] | null>(null);
  const previewCleanupRef = useRef<(() => void) | null>(null);
  const appendLog = useCallback(
    (m: string) =>
      setMediaLog(prev => [...prev.slice(-40), `${new Date().toLocaleTimeString()} ${m}`]),
    [],
  );
  const autoCreateRef = useRef(false);
  const { session } = useAuthSession();

  const loadMyRooms = useCallback(async () => {
    if (session?.accountRole !== 'controller') return;
    try {
      const r = await listMyRooms();
      setMyRooms(r.rooms);
    } catch (e) {
      logger.error('listMyRooms failed', e);
      setMyRooms([]);
    }
  }, [session?.accountRole]);

  useEffect(() => {
    if (!roomId) return;
    (async () => {
      await loadMyRooms();
    })();
  }, [roomId, loadMyRooms]);

  useEffect(() => {
    getDeviceId().then(setDeviceId);
  }, []);

  // Trạng thái nối lại preview từ service; rời màn hình thì ngắt hẳn để vòng retry không chạy ngầm
  useEffect(() => {
    const off = mediasoupClientService.subscribe((st, detail) => {
      setPreviewState(st);
      setPreviewDetail(detail);
      if (st !== 'idle') appendLog(`preview ${st}${detail ? ` (${detail})` : ''}`);
    });
    return () => {
      off();
      previewCleanupRef.current?.();
    };
  }, [appendLog]);

  // Controller tự TẠO phòng riêng + join luôn khi mở app (chỉ 1 lần): vì các
  // route approve/kick/sync chỉ cho phép OWNER (requireOwnerRoom), controller
  // join phòng của user khác (vd phòng chung của default-room@) sẽ bị 401 →
  // "không join quản lý được". Tự tạo phòng (tự duyệt) để controller
  // là owner: remote nhập mã mời là vào ngay.
  useEffect(() => {
    if (roomId || !deviceId || session?.accountRole !== 'controller' || autoCreateRef.current) {
      return;
    }
    autoCreateRef.current = true;
    (async () => {
      try {
        logger.info('Auto-create phòng cho controller', { deviceId });
        const r = await createRoom({ max_members: 16, auto_approve: 1 });
        setRoomId(r.room_id);
        setInvite(r.invite_code);
        setInviteExpires(r.expires_at ?? null);
        setInviteExpired(!!r.expires_at && new Date(r.expires_at).getTime() < Date.now());
        logger.info('Auto room OK', { room_id: r.room_id, invite: r.invite_code });
      } catch (e) {
        autoCreateRef.current = false;
        logger.error('Auto-create phòng thất bại — bấm "Tạo phòng" thủ công', e);
      }
    })();
  }, [deviceId, session, roomId]);

  const memberName = useMemo(() => {
    const m = new Map<string, string>();
    for (const mem of syncData?.members ?? []) {
      m.set(mem.member_id, mem.camera_name || `Cam ${mem.device_id.slice(0, 6)}`);
    }
    return m;
  }, [syncData]);

  const handleCreate = useCallback(async () => {
    setLoading(true);
    try {
      logger.info('createRoom request', { deviceId });
      const r = await createRoom({
        max_members: 16,
        auto_approve: autoApprove,
      });
      setRoomId(r.room_id);
      setInvite(r.invite_code);
      setInviteExpires(r.expires_at ?? null);
      setInviteExpired(!!r.expires_at && new Date(r.expires_at).getTime() < Date.now());
      const exp = r.expires_at ? new Date(r.expires_at).toLocaleTimeString() : 'unknown';
      logger.info('createRoom success', {
        room_id: r.room_id,
        invite: r.invite_code,
        expires_at: r.expires_at,
      });
      if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) {
        Alert.alert(
          'Mã mời đã hết hạn',
          `Mã ${r.invite_code} hết lúc ${exp}. Bấm "Mã mới" để lấy mã mới (TTL 10 phút).`,
        );
      } else {
        Alert.alert('Phòng đã tạo', `Mã mời: ${r.invite_code}\nHết hạn: ${exp} (10 phút)`);
      }
      loadMyRooms();
    } catch (e) {
      const msg = e instanceof ApiError ? `[${e.code}] ${e.message}` : String(e);
      logger.error('createRoom failed', { msg, deviceId });
      Alert.alert('Lỗi tạo phòng', msg);
    } finally {
      setLoading(false);
    }
  }, [deviceId, autoApprove, loadMyRooms]);

  const handleRefreshCode = useCallback(async () => {
    if (!roomId) return;
    try {
      const r = await refreshInviteCode(roomId);
      setInvite(r.invite_code);
      setInviteExpires(r.expires_at);
      setInviteExpired(false);
      Alert.alert(
        'Mã mới',
        `${r.invite_code}\nHết hạn: ${new Date(r.expires_at).toLocaleTimeString()}`,
      );
    } catch (e) {
      Alert.alert('Lỗi refresh mã', e instanceof ApiError ? `[${e.code}] ${e.message}` : String(e));
    }
  }, [roomId]);

  const handlePreview = useCallback(async () => {
    if (!roomId) return;
    if (Platform.OS === 'web') {
      Alert.alert(
        'Preview',
        'Web cần react-native-webrtc native — hãy chạy trên iOS/Android (Expo prebuild)',
      );
      return;
    }
    try {
      appendLog('Đang nối mediasoup...');
      setIsPreviewing(true);
      const cleanup = await mediasoupClientService.startConsuming(
        roomId,
        (memberId, stream) => {
          appendLog(`onStream member=${memberId.slice(0, 6)}`);
          setStreams(prev => {
            const next = new Map(prev);
            next.set(memberId, stream);
            return next;
          });
        },
        memberId => {
          appendLog(`producer-closed member=${memberId.slice(0, 6)}`);
          setStreams(prev => {
            const next = new Map(prev);
            next.delete(memberId);
            return next;
          });
          setIceStates(prev => {
            const next = new Map(prev);
            next.delete(memberId);
            return next;
          });
          setFullMember(prev => (prev === memberId ? null : prev));
        },
        (memberId, iceState) =>
          setIceStates(prev =>
            prev.get(memberId) === iceState ? prev : new Map(prev).set(memberId, iceState),
          ),
      );
      previewCleanupRef.current = cleanup;
      appendLog('Preview đang chạy — chờ Remote produce');
    } catch (e) {
      logger.error('Preview connect failed', e);
      setIsPreviewing(false);
      Alert.alert('Preview lỗi', String(e instanceof Error ? e.message : e));
    }
  }, [roomId, appendLog]);

  const handleStopPreview = useCallback(() => {
    const c = previewCleanupRef.current;
    previewCleanupRef.current = null;
    try {
      c?.();
    } catch {}
    mediasoupClientService.disconnect();
    setStreams(new Map());
    setIceStates(new Map());
    setFullMember(null);
    setIsPreviewing(false);
  }, []);

  // Remote mất ICE thì tile giữ frame cuối; báo để biết hình đang đứng
  const isSignalLost = (memberId: string) =>
    ['disconnected', 'failed', 'closed'].includes(iceStates.get(memberId) ?? '');
  const previewStatus =
    previewState === 'connecting'
      ? 'Đang kết nối preview…'
      : previewState === 'reconnecting'
        ? 'Mất kết nối, đang kết nối lại preview…'
        : previewState === 'failed'
          ? `Preview đã dừng${previewDetail ? `: ${previewDetail}` : ''} — bấm Ngắt rồi bật lại`
          : null;

  const gridGap = spacing.sm;
  const cellWidth = (width - spacing.lg * 2 - gridGap) / 2;
  const streamEntries = [...streams.entries()];

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.safe}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>🎛️ Phòng & Streaming</Text>
          <Text style={styles.sub}>Device: {deviceId.slice(0, 12) || '...'}</Text>
        </View>
        {roomId && (
          <View style={styles.countBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.countText}>{streams.size} cam</Text>
          </View>
        )}
      </View>

      <ScrollView
        style={styles.container}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl }}>
        {!roomId ? (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Chế độ duyệt thành viên</Text>
              <View style={styles.row}>
                <TouchableOpacity
                  style={[
                    styles.segBtn,
                    {
                      flex: 1,
                      backgroundColor: autoApprove === 0 ? colors.primary : colors.background,
                    },
                  ]}
                  onPress={() => setAutoApprove(0)}>
                  <Text
                    style={[
                      styles.segText,
                      { color: autoApprove === 0 ? colors.white : colors.textSecondary },
                    ]}>
                    🙋 Cần duyệt
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.segBtn,
                    {
                      flex: 1,
                      backgroundColor: autoApprove === 1 ? colors.primary : colors.background,
                    },
                  ]}
                  onPress={() => setAutoApprove(1)}>
                  <Text
                    style={[
                      styles.segText,
                      { color: autoApprove === 1 ? colors.white : colors.textSecondary },
                    ]}>
                    ⚡ Tự duyệt
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
            <TouchableOpacity style={styles.primaryBtn} onPress={handleCreate} disabled={loading}>
              {loading ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <Text style={styles.btnText}>Tạo phòng</Text>
              )}
            </TouchableOpacity>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Join phòng có sẵn (dùng mã mời)</Text>
              <View style={styles.row}>
                <TextInput
                  value={joinCode}
                  onChangeText={setJoinCode}
                  placeholder="Mã mời 6 ký tự (vd ABCD12)"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="characters"
                  style={styles.codeInput}
                />
                <TouchableOpacity
                  style={[
                    styles.segBtn,
                    { justifyContent: 'center', paddingHorizontal: spacing.lg },
                  ]}
                  onPress={async () => {
                    const code = joinCode.trim().toUpperCase();
                    if (!code) return Alert.alert('Thiếu mã mời');
                    try {
                      const r = await joinRoom({
                        invite_code: code,
                        device_id: deviceId,
                        camera_name: 'Controller-' + deviceId.slice(-4),
                        grant_control: true,
                      });
                      setRoomId(r.room_id);
                      setInvite(code);
                      setInviteExpired(false);
                      setJoinLog(prev => [
                        ...prev.slice(-8),
                        `${new Date().toLocaleTimeString()} join OK ${code}`,
                      ]);
                      Alert.alert('Đã join', r.room_id);
                    } catch (e) {
                      const codeErr = e instanceof ApiError ? e.code : 0;
                      const msg = e instanceof ApiError ? e.message : String(e);
                      setJoinLog(prev => [
                        ...prev.slice(-8),
                        `${new Date().toLocaleTimeString()} join FAIL [${codeErr}] ${msg}`,
                      ]);
                      Alert.alert(
                        codeErr === 9992 ? 'Mã mời hết hạn' : 'Join lỗi',
                        `${msg} | invite=${code}`,
                      );
                    }
                  }}>
                  <Text style={styles.segText}>Join</Text>
                </TouchableOpacity>
              </View>
              {joinLog.length > 0 &&
                joinLog.map((l, i) => (
                  <Text key={i} style={styles.logText}>
                    {l}
                  </Text>
                ))}
            </View>
          </>
        ) : (
          <>
            <View style={styles.card}>
              <View style={styles.roomRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>Phòng {roomId.slice(0, 8)}</Text>
                  <Text style={styles.invite}>Mã mời: {invite ?? '...'}</Text>
                  {inviteExpires && (
                    <Text style={styles.muted}>
                      Hết hạn: {new Date(inviteExpires).toLocaleString()}
                      {inviteExpired ? ' ⚠️ đã hết hạn' : ''}
                    </Text>
                  )}
                </View>
                <View style={styles.actionCol}>
                  <TouchableOpacity style={styles.cellBtn} onPress={handleRefreshCode}>
                    <Text style={styles.cellBtnText}>↻ Mã mới</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.cellBtn, { backgroundColor: colors.danger }]}
                    onPress={async () => {
                      if (isPreviewing) handleStopPreview();
                      setFullMember(null);
                      await closeRoom(roomId);
                      setRoomId(null);
                    }}>
                    <Text style={styles.cellBtnText}>Đóng phòng</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.cellBtn, { backgroundColor: colors.textSecondary }]}
                    onPress={async () => {
                      if (isPreviewing) handleStopPreview();
                      setFullMember(null);
                      await leaveRoom(roomId);
                      setRoomId(null);
                    }}>
                    <Text style={styles.cellBtnText}>Rời phòng</Text>
                  </TouchableOpacity>
                </View>
              </View>
              {!isPreviewing ? (
                <TouchableOpacity
                  style={[styles.primaryBtn, { backgroundColor: colors.success }]}
                  onPress={handlePreview}>
                  <Text style={styles.btnText}>👁️ Bật xem trực tiếp (WebRTC)</Text>
                </TouchableOpacity>
              ) : (
                <>
                  <TouchableOpacity
                    style={[styles.primaryBtn, { backgroundColor: colors.danger }]}
                    onPress={handleStopPreview}>
                    <Text style={styles.btnText}>⏹ Ngắt xem trực tiếp</Text>
                  </TouchableOpacity>
                  {previewStatus && (
                    <Text
                      style={[
                        styles.muted,
                        { color: previewState === 'failed' ? colors.danger : colors.warning },
                      ]}>
                      {previewStatus}
                    </Text>
                  )}
                  {streamEntries.length === 0 && previewState === 'live' && (
                    <View style={styles.waitingBox}>
                      <ActivityIndicator color={colors.primary} />
                      <Text style={styles.muted}>
                        Chờ Remote phát sóng… camera tắt phát sẽ tự biến mất khỏi lưới.
                      </Text>
                    </View>
                  )}
                </>
              )}
            </View>

            {fullMember && streams.get(fullMember) ? (
              <View style={styles.card}>
                <TouchableOpacity onPress={() => setFullMember(null)} style={styles.backRow}>
                  <Text style={styles.backText}>‹ Về lưới</Text>
                  <Text style={styles.cardTitle}>
                    {memberName.get(fullMember) ?? fullMember.slice(0, 8)}
                  </Text>
                </TouchableOpacity>
                <RTCFrame
                  stream={streams.get(fullMember)}
                  name={memberName.get(fullMember) ?? fullMember.slice(0, 8)}
                  sub={isSignalLost(fullMember) ? '⚠️ mất tín hiệu' : undefined}
                />
              </View>
            ) : (
              streamEntries.length > 0 && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Camera đang phát ({streamEntries.length})</Text>
                  <View style={styles.grid}>
                    {streamEntries.map(([mid, stream]) => (
                      <View key={mid} style={{ width: cellWidth }}>
                        <RTCFrame
                          stream={stream}
                          name={memberName.get(mid) ?? mid.slice(0, 8)}
                          sub={isSignalLost(mid) ? '⚠️ mất tín hiệu' : undefined}
                          onPress={() => setFullMember(mid)}
                        />
                      </View>
                    ))}
                  </View>
                  <Text style={styles.scanNote}>
                    Tap camera để xem toàn màn hình. Camera đã tắt phát sẽ tự biến mất.
                  </Text>
                </View>
              )
            )}

            <View style={styles.card}>
              <Text style={styles.cardTitle}>
                Members (sync_room rev={syncData?.revision ?? 0})
              </Text>
              {(syncData?.pending?.length ?? 0) > 0 && (
                <>
                  <Text
                    style={[
                      styles.muted,
                      { marginTop: spacing.xs, fontWeight: '700', color: colors.warning },
                    ]}>
                    ⏳ Chờ duyệt ({syncData!.pending.length})
                  </Text>
                  {syncData!.pending.map(m => (
                    <View key={m.member_id} style={styles.memberRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.memberName}>
                          {m.camera_name} · {m.device_id.slice(0, 8)}
                        </Text>
                        <Text style={styles.muted}>
                          yêu cầu join lúc {new Date(m.last_seen || '').toLocaleTimeString()}
                        </Text>
                      </View>
                      <TouchableOpacity
                        onPress={async () => {
                          try {
                            await approveMember(roomId, m.member_id);
                          } catch (e) {
                            Alert.alert('Lỗi duyệt', e instanceof ApiError ? e.message : String(e));
                          }
                        }}>
                        <Text style={{ color: colors.success, fontWeight: '700', marginRight: 8 }}>
                          ✓ Duyệt
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={async () => {
                          try {
                            await denyMember(roomId, m.member_id);
                          } catch (e) {
                            Alert.alert(
                              'Lỗi từ chối',
                              e instanceof ApiError ? e.message : String(e),
                            );
                          }
                        }}>
                        <Text style={{ color: colors.danger, fontWeight: '700' }}>✕ Từ chối</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </>
              )}
              {!syncData ? (
                <ActivityIndicator />
              ) : syncData.members.length === 0 ? (
                <Text style={styles.muted}>Chưa có thành viên</Text>
              ) : (
                syncData.members.map(m => (
                  <View key={m.member_id} style={styles.memberRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.memberName}>
                        {m.camera_name} · {m.device_id.slice(0, 8)}
                      </Text>
                      <Text style={styles.muted}>
                        recording={m.recording_state} · batt={m.battery_level} · online=
                        {m.is_online}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() =>
                        setCameraConfig(roomId, m.member_id, {
                          flash_mode: 'auto',
                          zoom_factor: 2.0,
                          client_command_id: `cam_${Date.now()}`,
                        })
                      }>
                      <Text style={{ color: colors.primary }}>⚡ Flash</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={async () => {
                        try {
                          await kickMember(roomId, m.member_id);
                          Alert.alert('Đã kick', `${m.camera_name} đã bị đưa ra khỏi phòng.`);
                        } catch (e) {
                          Alert.alert('Lỗi kick', e instanceof ApiError ? e.message : String(e));
                        }
                      }}>
                      <Text style={{ color: colors.danger, marginLeft: spacing.md }}>🚫 Kick</Text>
                    </TouchableOpacity>
                  </View>
                ))
              )}
              {syncData?.joined?.length ? (
                <Text style={styles.muted}>
                  Joined: {syncData.joined.map(j => j.camera_name).join(', ')}
                </Text>
              ) : null}
              {syncData?.left?.length ? (
                <Text style={styles.muted}>Left: {syncData.left.join(', ')}</Text>
              ) : null}
            </View>

            <View style={styles.card}>
              <View style={styles.backRow}>
                <Text style={styles.cardTitle}>Phòng của tôi ({myRooms?.length ?? '…'})</Text>
                <TouchableOpacity onPress={loadMyRooms}>
                  <Text style={styles.backText}>↻ Làm mới</Text>
                </TouchableOpacity>
              </View>
              {!myRooms ? (
                <ActivityIndicator />
              ) : myRooms.length === 0 ? (
                <Text style={styles.muted}>Chưa có phòng nào.</Text>
              ) : (
                myRooms.map(r => {
                  const isCurrent = r.room_id === roomId;
                  return (
                    <View key={r.room_id} style={styles.memberRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.memberName} numberOfLines={1}>
                          {r.room_name || `Phòng ${r.room_id.slice(0, 6)}`}
                          {isCurrent ? '  👈 đang dùng' : ''}
                        </Text>
                        <Text style={styles.muted}>
                          {r.invite_code} · {r.member_count}/{r.max_members} thành viên · {r.status}
                        </Text>
                      </View>
                      {!isCurrent && (
                        <TouchableOpacity
                          onPress={async () => {
                            try {
                              await closeRoom(r.room_id);
                              Alert.alert('Đã xóa', `Đã xóa hẳn phòng ${r.room_id.slice(0, 6)}.`);
                              loadMyRooms();
                            } catch (err) {
                              Alert.alert(
                                'Lỗi xóa phòng',
                                err instanceof ApiError ? err.message : String(err),
                              );
                            }
                          }}>
                          <Text style={{ color: colors.danger, fontWeight: '700' }}>🗑 Xóa</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })
              )}
              <Text style={styles.muted}>
                Server tự động chỉ giữ 1 phòng/controller — các phòng cũ sẽ bị xóa hẳn khi tạo phòng
                mới.
              </Text>
            </View>

            {mediaLog.length > 0 && (
              <View style={styles.card}>
                <TouchableOpacity onPress={() => setShowLog(v => !v)} style={styles.backRow}>
                  <Text style={styles.cardTitle}>Mediasoup log ({mediaLog.length})</Text>
                  <Text style={styles.backText}>{showLog ? '▾' : '▸'}</Text>
                </TouchableOpacity>
                {showLog && (
                  <>
                    {mediaLog.map((l, i) => (
                      <Text key={i} style={styles.logText}>
                        {l}
                      </Text>
                    ))}
                    <TouchableOpacity onPress={handleStopPreview}>
                      <Text style={{ color: colors.danger, marginTop: 8 }}>Ngắt WS</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  title: { fontSize: 20, fontWeight: 'bold', color: colors.text },
  sub: { fontSize: 12, color: colors.textMuted, marginTop: 4, fontFamily: 'monospace' },
  countBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.round,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginLeft: spacing.sm,
  },
  countText: { color: colors.primaryDark, fontWeight: '700', fontSize: 13 },
  liveDot: { width: 8, height: 8, borderRadius: radius.round, backgroundColor: colors.success },
  primaryBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  btnText: { color: colors.white, fontWeight: 'bold' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  cardTitle: { fontWeight: 'bold', color: colors.text, marginBottom: 6 },
  invite: { fontSize: 18, fontWeight: 'bold', color: colors.primary, letterSpacing: 2 },
  row: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  segBtn: {
    backgroundColor: colors.background,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  segText: { color: colors.white, fontWeight: '600', fontSize: 12 },
  roomRow: { flexDirection: 'row', gap: spacing.md },
  actionCol: { gap: spacing.xs, alignItems: 'flex-end' },
  cellBtn: {
    backgroundColor: colors.primaryLight,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  cellBtnText: { color: colors.primaryDark, fontWeight: '600', fontSize: 12 },
  codeInput: {
    flex: 1,
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.sm,
    color: colors.text,
    fontFamily: 'monospace',
  },
  waitingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  frameWrap: { borderRadius: radius.md, overflow: 'hidden', backgroundColor: '#000' },
  frameVideo: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000' },
  frameError: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.overlay },
  frameBadge: {
    position: 'absolute',
    left: spacing.xs,
    bottom: spacing.xs,
    right: spacing.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: 'rgba(15,23,42,0.6)',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  frameName: { color: colors.white, fontWeight: '600', fontSize: 12, flexShrink: 1 },
  frameSub: { color: colors.white, fontSize: 10, opacity: 0.85 },
  frameTap: { position: 'absolute', inset: 0 },
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  backText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  scanNote: { fontSize: 12, color: colors.textMuted, marginTop: spacing.sm, textAlign: 'center' },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  memberName: { fontWeight: '600', color: colors.text },
  muted: { fontSize: 12, color: colors.textMuted },
  logText: { fontSize: 11, color: colors.textSecondary, fontFamily: 'monospace' },
});
