/**
 * Settings Screen
 * Cho phép nhập URL server ngay trong app (lưu AsyncStorage),
 * không cần build lại. Hỗ trợ kiểm tra kết nối tới server (/health).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing, radius } from '../constants/theme';
import { serverConfigService } from '../services/serverConfig';
import { authStore } from '../services/authStore';
import { logout } from '../api/auth';
import { getDeviceId } from '../utils/device';
import { logger } from '../utils/logger';
import AsyncStorage from '@react-native-async-storage/async-storage';

export default function SettingsScreen() {
  const [baseUrl, setBaseUrl] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [account, setAccount] = useState<{ name: string; role: string; phone: string } | null>(
    null,
  );

  useEffect(() => {
    serverConfigService.load().then(config => {
      setBaseUrl(config.baseUrl);
      setIsLoading(false);
    });
    getDeviceId().then(setDeviceId);
    authStore.load().then(session => {
      if (session) {
        const { user, accountRole } = session;
        setAccount({
          name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email,
          role: accountRole === 'controller' ? 'Controller' : 'Remote',
          phone: user.phone || user.email,
        });
      }
    });
  }, []);

  const handleLogout = useCallback(() => {
    Alert.alert('Đăng xuất', 'Bạn muốn đăng xuất khỏi tài khoản này?', [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Đăng xuất',
        style: 'destructive',
        onPress: async () => {
          try { await logout(); } catch(e){ logger.warn('logout api failed, forcing clear', e); await authStore.clear(); }
          // Fallback nếu AuthGate chưa kịp chuyển (do token cũ 9992)
          setTimeout(async()=>{ const s=await authStore.load(); if(s) { await AsyncStorage.removeItem('auth_session'); await authStore.clear(); } }, 800);
        },
      },
    ]);
  }, []);

  const handleForceClear = useCallback(async()=>{
    Alert.alert('Buộc đăng xuất', 'Xóa session local và quay về màn đăng nhập? (Dùng khi "Đăng xuất" không phản hồi do 9992)', [
      { text: 'Hủy', style:'cancel'},
      { text:'Xóa & đăng nhập lại', style:'destructive', onPress: async()=>{
        // Rời phòng trên server trước (best-effort) → tránh member "xác" còn nằm lại.
        try{ await logout(); }catch{}
        try{ await AsyncStorage.removeItem('auth_session'); }catch{}
        await authStore.clear();
        // Xoá deviceId cũ nếu bị kẹt "not owned by user" do DB reset — lần sau getDeviceId sẽ tạo mới
        try{ await AsyncStorage.removeItem('app_device_id'); }catch{}
        Alert.alert('Đã xóa', 'Vui lòng khởi động lại app và đăng nhập lại (0900000002/Remote@123).');
      }}
    ]);
  },[]);

  const handleSave = useCallback(async () => {
    if (!baseUrl.trim()) {
      Alert.alert('Lỗi', 'Vui lòng nhập URL server (vd https://api.example.com).');
      return;
    }

    setIsSaving(true);
    const saved = await serverConfigService.save(baseUrl);
    setBaseUrl(saved.baseUrl);
    setIsSaving(false);
    setTestResult(null);
    Alert.alert('Đã lưu', 'Cấu hình đã lưu.');
  }, [baseUrl]);

  const handleTest = useCallback(async () => {
    if (!baseUrl.trim()) {
      Alert.alert('Lỗi', 'Vui lòng nhập URL server trước khi kiểm tra.');
      return;
    }

    setIsTesting(true);
    setTestResult(null);
    const ok = await serverConfigService.checkHealth(baseUrl);
    setTestResult(ok ? 'success' : 'fail');
    setIsTesting(false);
  }, [baseUrl]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.header}>
            <View style={styles.headerIconWrap}><Text style={styles.headerIcon}>⚙️</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.headerTitle}>Cài đặt</Text>
              <Text style={styles.headerSub}>Server & tài khoản</Text>
            </View>
          </View>

        {isLoading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>🖥️ Server</Text>
              <Text style={styles.label}>Server URL</Text>
              <TextInput
                style={styles.input}
                value={baseUrl}
                onChangeText={setBaseUrl}
                placeholder="https://api.example.com"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />

              <View style={styles.row}>
                <TouchableOpacity
                  style={[styles.button, styles.buttonFlex, isSaving && styles.buttonDisabled]}
                  onPress={handleSave}
                  disabled={isSaving}>
                  <Text style={styles.buttonText}>{isSaving ? '...' : '💾 Lưu'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.button, styles.buttonGhost, styles.buttonFlex, isTesting && styles.buttonDisabled]}
                  onPress={handleTest}
                  disabled={isTesting}>
                  <Text style={styles.buttonGhostText}>{isTesting ? '...' : '📡 Test'}</Text>
                </TouchableOpacity>
              </View>

              {testResult && (
                <View
                  style={[
                    styles.testResult,
                    testResult === 'success' ? styles.testOk : styles.testFail,
                  ]}>
                  <Text
                    style={[
                      styles.testResultText,
                      testResult === 'success' ? styles.testOkText : styles.testFailText,
                    ]}>
                    {testResult === 'success'
                      ? '✓ Server phản hồi tốt'
                      : '✕ Không kết nối được tới server. Kiểm tra URL và mạng.'}
                  </Text>
                </View>
              )}
            </View>

            {account && (
              <View style={styles.infoCard}>
                <View style={styles.infoCardHeader}>
                  <Text style={styles.infoTitle}>👤 {account.name}</Text>
                  <View style={[styles.badge, account.role === 'Controller' ? styles.badgeController : styles.badgeRemote]}>
                    <Text style={styles.badgeText}>{account.role}</Text>
                  </View>
                </View>
                <Text style={styles.infoValueSmall} numberOfLines={1}>{account.phone}</Text>
                <View style={styles.row}>
                  <TouchableOpacity style={[styles.button, styles.logoutButton, styles.buttonFlex]} onPress={handleLogout}>
                    <Text style={styles.buttonText}>🚪 Thoát</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.button, styles.buttonGhost, styles.buttonFlex]} onPress={handleForceClear}>
                    <Text style={styles.buttonGhostText}>🧹 Xóa</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            <View style={styles.infoCard}>
              <Text style={styles.infoTitle}>📱 Thiết bị</Text>
              <Text style={styles.infoValueMono} numberOfLines={1}>{deviceId}</Text>
              <Text style={styles.infoNote}>Dùng để nhận diện trên dashboard</Text>
            </View>
          </>
        )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: 24, gap: spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm },
  headerIconWrap: { width: 40, height: 40, borderRadius: 12, backgroundColor: colors.primaryLight, justifyContent: 'center', alignItems: 'center' },
  headerIcon: { fontSize: 20 },
  headerTitle: { fontSize: 18, fontWeight: '800', color: colors.text },
  headerSub: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 1 },
  cardTitle: { fontSize: 13, fontWeight: '800', color: colors.text, marginBottom: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.sm },
  label: { fontSize: 11, fontWeight: '700', color: colors.textSecondary, marginBottom: 4, marginTop: spacing.sm },
  input: { backgroundColor: colors.background, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 10, fontSize: 14, color: colors.text, borderWidth: 1, borderColor: colors.border },
  button: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center', marginTop: spacing.md },
  buttonFlex: { flex: 1 },
  buttonText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: 'bold',
  },
  buttonGhost: {
    backgroundColor: colors.primaryLight,
    marginTop: spacing.sm,
  },
  buttonGhostText: {
    color: colors.primaryDark,
    fontSize: 15,
    fontWeight: 'bold',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  testResult: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  testOk: {
    backgroundColor: colors.successLight,
  },
  testFail: {
    backgroundColor: colors.dangerLight,
  },
  testResultText: {
    fontSize: 13,
    fontWeight: '600',
  },
  testOkText: {
    color: colors.successDark,
  },
  testFailText: {
    color: colors.dangerDark,
  },
  infoCard: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 1 },
  infoCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  infoTitle: { fontSize: 13, fontWeight: '800', color: colors.text },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.round },
  badgeController: { backgroundColor: colors.primaryLight },
  badgeRemote: { backgroundColor: colors.successLight },
  badgeText: { fontSize: 11, fontWeight: '800', color: colors.primaryDark },
  infoValueSmall: { fontSize: 12, color: colors.textSecondary, marginBottom: spacing.sm },
  infoValueMono: { fontSize: 11, color: colors.text, fontFamily: 'monospace', marginBottom: 4 },
  infoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  infoLabel: { fontSize: 13, color: colors.textSecondary },
  infoValue: { fontSize: 13, color: colors.text, fontWeight: '600', flexShrink: 1, marginLeft: spacing.md, textAlign: 'right' },
  infoNote: { fontSize: 11, color: colors.textMuted, marginTop: 4 },
  infoRowGap: { marginTop: spacing.md },
  logoutButton: {
    backgroundColor: colors.danger,
  },
  loadingBox: {
    paddingVertical: spacing.xl,
    alignItems: 'center',
  },
});
