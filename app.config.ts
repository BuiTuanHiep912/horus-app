import type { ConfigContext, ExpoConfig } from 'expo/config';

// Mở rộng app.json: URL server lấy từ biến môi trường API_URL lúc build (eas.json env theo profile).
// Rỗng thì người dùng phải nhập ở màn đăng nhập/Cài đặt.
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  extra: { ...config.extra, apiUrl: process.env.API_URL ?? '' },
});
