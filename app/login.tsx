/**
 * Login Screen
 * Đăng nhập vào multicam-server (API v1). Sau khi đăng nhập thành công,
 * token được lưu ở AsyncStorage và router tự chuyển về tab chính.
 */

import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Constants from 'expo-constants';
import { getDeviceInfo } from '../src/services/deviceInfo';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radius, spacing } from '../src/constants/theme';
import { getDeviceId } from '../src/utils/device';
import { login } from '../src/api/auth';
import { ApiError } from '../src/api/client';
import { serverConfigService } from '../src/services/serverConfig';
import { logger } from '../src/utils/logger';

export default function LoginScreen() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [showServer, setShowServer] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [showDemos, setShowDemos] = useState(false);

  const passwordRef = useRef<TextInput>(null);

  useEffect(() => {
    serverConfigService.load().then(config => {
      setBaseUrl(config.baseUrl);
      if (!config.baseUrl) setShowServer(true);
    });
  }, []);

  const submittingRef = useRef(false);

  const handleTest = async () => {
    if (isTesting || !baseUrl.trim()) return;
    setIsTesting(true);
    setError(null);
    setSuccess(null);
    const ok = await serverConfigService.checkHealth(baseUrl);
    if (ok) setSuccess('Server phản hồi tốt.');
    else setError('Không kết nối được server. Kiểm tra URL và mạng.');
    setIsTesting(false);
  };

  const handleSubmit = async () => {
    if (submittingRef.current) return;
    if (!identifier.trim() || !password) {
      setError('Vui lòng nhập tài khoản và mật khẩu.');
      return;
    }
    if (!baseUrl.trim()) {
      setError('Vui lòng nhập URL server (vd https://api.example.com).');
      setShowServer(true);
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      await serverConfigService.save(baseUrl);
      const deviceId = await getDeviceId();
      const deviceInfo = getDeviceInfo();
      await login({
        identifier: identifier.trim(),
        password,
        deviceId,
        deviceType: Platform.OS === 'ios' ? 2 : 1,
        deviceName:
          (Constants as any).deviceName ||
          `${Platform.OS === 'ios' ? 'iPhone' : 'Android'} của tôi`,
        model: deviceInfo.model,
        osVersion: deviceInfo.osVersion,
      });
      router.replace('/(tabs)');
    } catch (err: any) {
      logger.warn('Login failed', err);
      const message =
        err instanceof ApiError
          ? err.code === 9995
            ? 'Số điện thoại/email hoặc mật khẩu không đúng.'
            : err.code === -1
              ? 'Không kết nối được server. Kiểm tra lại URL server phía dưới.'
              : err.message
          : 'Đăng nhập thất bại. Vui lòng thử lại.';
      setError(message);
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  const serverTarget = baseUrl.trim() || 'Chưa cấu hình';

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          <View style={styles.header}>
            <View style={styles.logoBadge}>
              <Text style={styles.logo}>🎥</Text>
            </View>
            <Text style={styles.title}>Multi-Cam Recorder</Text>
            <Text style={styles.subtitle}>Quay, upload và quản lý video</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>Số điện thoại / Email</Text>
            <TextInput
              style={styles.input}
              value={identifier}
              onChangeText={value => {
                setIdentifier(value);
                setError(null);
              }}
              placeholder="VD: 0900000002"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="username"
              textContentType="username"
              keyboardType="email-address"
              returnKeyType="next"
              editable={!submitting}
              onSubmitEditing={() => passwordRef.current?.focus()}
            />

            <Text style={styles.label}>Mật khẩu</Text>
            <View style={styles.passwordWrap}>
              <TextInput
                ref={passwordRef}
                style={[styles.input, styles.passwordInput]}
                value={password}
                onChangeText={value => {
                  setPassword(value);
                  setError(null);
                }}
                placeholder="Nhập mật khẩu"
                placeholderTextColor={colors.textMuted}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="password"
                returnKeyType="done"
                editable={!submitting}
                onSubmitEditing={handleSubmit}
              />
              <TouchableOpacity
                style={styles.eyeButton}
                onPress={() => setShowPassword(v => !v)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={styles.eyeIcon}>{showPassword ? '🙈' : '👁️'}</Text>
              </TouchableOpacity>
            </View>

            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
            {success && (
              <View style={styles.successBox}>
                <Text style={styles.successText}>{success}</Text>
              </View>
            )}

            <View style={styles.serverHeaderRow}>
              <TouchableOpacity
                style={styles.serverToggleRow}
                onPress={() => setShowServer(v => !v)}
                activeOpacity={0.7}>
                <View style={styles.serverToggleLeft}>
                  <Text
                    style={[styles.serverToggleIcon, showServer ? styles.serverToggleOpen : null]}>
                    ▸
                  </Text>
                  <Text style={styles.serverToggleLabel}>Kết nối server</Text>
                </View>
                <View style={styles.serverChip}>
                  <Text style={styles.serverChipText} numberOfLines={1}>
                    {serverTarget}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>

            {showServer && (
              <View style={styles.serverBox}>
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
                  editable={!submitting}
                />
                <TouchableOpacity
                  style={[styles.testButton, isTesting && styles.buttonDisabled]}
                  onPress={handleTest}
                  disabled={isTesting}>
                  <Text style={styles.testButtonText}>
                    {isTesting ? 'Đang kiểm tra…' : '📡 Kiểm tra kết nối'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity
              style={[styles.button, submitting && styles.buttonDisabled]}
              onPress={handleSubmit}
              disabled={submitting}
              activeOpacity={0.85}>
              {submitting ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <Text style={styles.buttonText}>Đăng nhập</Text>
              )}
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.demoToggle} onPress={() => setShowDemos(v => !v)}>
            <Text style={styles.demoToggleText}>{showDemos ? '▾' : '▸'} Tài khoản demo</Text>
          </TouchableOpacity>
          {showDemos && (
            <View style={styles.hintBox}>
              <Text style={styles.hintLine}>Controller: 0900000001 / Controller@123</Text>
              <Text style={styles.hintLine}>Remote: 0900000002..4 / Remote@123</Text>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
  },
  header: {
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  logoBadge: {
    width: 76,
    height: 76,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  logo: {
    fontSize: 40,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: colors.text,
  },
  subtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: spacing.xs,
    marginTop: spacing.md,
  },
  input: {
    backgroundColor: colors.background,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: 16,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
  },
  passwordWrap: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  passwordInput: {
    flex: 1,
    paddingRight: spacing.xl * 1.5,
  },
  eyeButton: {
    position: 'absolute',
    right: spacing.md,
    padding: spacing.xs,
  },
  eyeIcon: {
    fontSize: 16,
  },
  errorBox: {
    backgroundColor: colors.dangerLight,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  errorText: {
    color: colors.dangerDark,
    fontSize: 13,
    fontWeight: '600',
  },
  successBox: {
    backgroundColor: colors.successLight,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  successText: {
    color: colors.successDark,
    fontSize: 13,
    fontWeight: '600',
  },
  serverHeaderRow: {
    marginTop: spacing.lg,
  },
  serverToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  serverToggleLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  serverToggleIcon: {
    fontSize: 14,
    color: colors.textMuted,
    transform: [{ rotate: '90deg' }],
  },
  serverToggleOpen: {
    transform: [{ rotate: '90deg' }],
    color: colors.primary,
  },
  serverToggleLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  serverChip: {
    maxWidth: '55%',
    backgroundColor: colors.primaryLight,
    borderRadius: radius.round,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  serverChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.primaryDark,
  },
  serverBox: {
    marginTop: spacing.sm,
    backgroundColor: colors.background,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  testButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  testButtonText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '600',
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.xl,
  },
  buttonText: {
    color: colors.white,
    fontSize: 16,
    fontWeight: 'bold',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  demoToggle: {
    alignSelf: 'center',
    marginTop: spacing.lg,
    padding: spacing.sm,
  },
  demoToggleText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textMuted,
  },
  hintBox: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    marginHorizontal: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
  },
  hintLine: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 20,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
