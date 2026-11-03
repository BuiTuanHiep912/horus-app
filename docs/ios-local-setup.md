# Build và cài app lên iPhone

Hướng dẫn build app (vai trò **Remote**) từ máy Mac, cài lên iPhone qua cáp, và **build lại khi app
hết hạn** (Apple ID miễn phí — Personal Team — chỉ cho app chạy 7 ngày).

App cần backend để đăng nhập/quay/upload. Cách bật backend + MinIO trên Mac nằm ở repo server:
`multicam-server/docs/local-lan-setup.md`.

Mọi lệnh chạy trong Terminal trên Mac.

---

## 0. Debug hay Release?

| | Release (khuyên dùng) | Debug |
|---|---|---|
| Cần Metro chạy trên Mac | Không — JavaScript đóng gói sẵn trong app | Có (cổng 8081) |
| Sửa code JS | Phải build lại | Chỉ cần Reload |
| Xem log app | Không | Có, ở cửa sổ Metro |
| Dùng khi | Dùng app bình thường | Đang sửa code |

---

## 1. Chuẩn bị một lần

1. **Xcode** đã cài, đã đăng nhập Apple ID: Xcode → Settings → Apple Accounts.
2. **CocoaPods**: `pod --version` (nếu thiếu: `brew install cocoapods`).
3. **iPhone:**
   - Cắm cáp vào Mac, mở khoá, bấm **Tin cậy** máy tính này. Khi Mac hỏi cho phép phụ kiện kết
     nối → **Cho phép**.
   - Mở Xcode → **Window → Devices and Simulators**, chọn iPhone, đợi Xcode chuẩn bị xong.
   - Trên iPhone: **Cài đặt → Quyền riêng tư & Bảo mật → Chế độ nhà phát triển** → bật → khởi động
     lại → **Bật**.
4. Thư viện JS của app:

   ```bash
   cd ~/Documents/horus-app && npm ci
   ```

---

## 2. Lấy mã thiết bị (UDID) của iPhone

Cắm iPhone, mở khoá, rồi:

```bash
xcrun xctrace list devices
```

Dòng của iPhone có dạng `BTH (26.7.1) (00008120-000C029A0E69A01E)` — chuỗi trong ngoặc cuối là
**UDID**. Lưu vào biến để dùng cho các lệnh sau (thay bằng UDID của bạn):

```bash
export UDID=00008120-000C029A0E69A01E
```

Kiểm tra iPhone sẵn sàng (phải thấy `developerModeStatus: enabled` và `pairingState: paired`):

```bash
xcrun devicectl device info details --device $UDID | grep -E "developerModeStatus|pairingState"
```

---

## 3. Khi nào phải chạy lại `prebuild` / `pod install`

Thư mục `ios/` là **sinh tự động** (không nằm trong git). Chỉ cần tạo lại khi:

- clone repo mới / đã xoá thư mục `ios/`,
- sửa `app.json` (bundle ID, quyền, scheme…),
- thêm/bớt thư viện native hoặc sửa `modules/webrtc-recorder/ios/*.podspec` / thêm file native mới.

```bash
cd ~/Documents/horus-app
npx expo prebuild --platform ios --no-install
git checkout package.json        # prebuild tự sửa scripts trong package.json — trả lại như cũ
cd ios && pod install
```

Chỉ sửa code JS hoặc code `.m`/`.swift` có sẵn thì **không cần** bước này.

---

## 4. Build bản Release và cài lên iPhone (khuyên dùng)

```bash
cd ~/Documents/horus-app/ios

xcodebuild -workspace expocameratriggerapp.xcworkspace \
  -scheme expocameratriggerapp -configuration Release \
  -destination "id=$UDID" \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=76RV26GUZQ CODE_SIGN_STYLE=Automatic \
  -derivedDataPath build/release

xcrun devicectl device install app --device $UDID \
  build/release/Build/Products/Release-iphoneos/expocameratriggerapp.app

xcrun devicectl device process launch --device $UDID --terminate-existing \
  com.buituanhiep912.horusapp
```

- Lần đầu mất vài phút; các lần sau nhanh hơn. Thấy `** BUILD SUCCEEDED **` là được.
- `DEVELOPMENT_TEAM=76RV26GUZQ` là Team ID (Personal Team) của tài khoản Apple đang dùng. Đổi tài
  khoản thì sửa giá trị này **và** `ios.appleTeamId` trong `app.json` (rồi làm lại mục 3).
  Xem Team ID của mình: `security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject`
  → giá trị sau `OU=`.
- **Luôn để thư mục build trong `ios/build/...`** (như `build/release`). Đặt ở chỗ khác bên trong
  `ios/` (ví dụ `ios/build-release`) sẽ làm `pod install` lỗi `invalid byte sequence in UTF-8`.

Lần đầu cài trên một iPhone: **Cài đặt → Cài đặt chung → Quản lý VPN & Thiết bị** → chọn
**Apple Development: …** → **Tin cậy**.

Mở app: Server URL `http://<IP của Mac>:<PORT của backend>` (ví dụ `http://192.168.0.116:3000`;
cách lấy IP và PORT xem `multicam-server/docs/local-lan-setup.md`, mục 4) → **Kiểm tra kết nối** → đăng nhập
`0900000002` / `Remote@123`.

---

## 5. Build bản Debug (khi sửa code)

Bật Metro ở một cửa sổ Terminal riêng (để mở suốt lúc dùng; cổng 8081 để không đụng cổng 3000 của
backend):

```bash
cd ~/Documents/horus-app && npx expo start --dev-client --port 8081 --host lan
```

Build, cài và mở app trỏ thẳng tới Metro (thay `192.168.0.116` bằng IP của Mac —
`ipconfig getifaddr en0`):

```bash
cd ~/Documents/horus-app/ios

xcodebuild -workspace expocameratriggerapp.xcworkspace \
  -scheme expocameratriggerapp -configuration Debug \
  -destination "id=$UDID" \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=76RV26GUZQ CODE_SIGN_STYLE=Automatic \
  -derivedDataPath build

xcrun devicectl device install app --device $UDID \
  build/Build/Products/Debug-iphoneos/expocameratriggerapp.app

xcrun devicectl device process launch --device $UDID --terminate-existing \
  --payload-url "exp+expo-camera-trigger-app://expo-development-client/?url=http%3A%2F%2F192.168.0.116%3A8081" \
  com.buituanhiep912.horusapp
```

- Log của app hiện ở cửa sổ Metro.
- Trên iPhone: **lắc máy** để mở menu (Reload, Go home…).
- Lần đầu app hỏi quyền **Mạng cục bộ** → **Cho phép** (nếu lỡ từ chối: Cài đặt → Quyền riêng tư &
  Bảo mật → Mạng cục bộ → bật cho app).

---

## 6. Cách khác: build bằng giao diện Xcode

1. `open ~/Documents/horus-app/ios/expocameratriggerapp.xcworkspace`
   (mở file **.xcworkspace**, không phải .xcodeproj).
2. Chọn target `expocameratriggerapp` → tab **Signing & Capabilities** → **Team**: tài khoản của bạn
   (Personal Team).
3. Thanh trên cùng: chọn iPhone của bạn làm thiết bị chạy.
4. Muốn bản Release: **Product → Scheme → Edit Scheme… → Run → Build Configuration: Release**.
5. Bấm **▶ (Run)**.

---

## 7. Khi app hết hạn (sau 7 ngày)

Với Personal Team, Apple chỉ cho app chạy **7 ngày** kể từ lúc build. Hết hạn thì app không mở được
(iOS báo app "không còn khả dụng" hoặc mở lên tắt ngay).

**Cách xử lý: build và cài lại — không cần gỡ app:**

1. Cắm iPhone vào Mac, mở khoá. Đảm bảo **Chế độ nhà phát triển** đang bật (mục 1).
2. Lấy UDID (mục 2).
3. Làm lại **mục 4** (Release) — hoặc mục 5 nếu đang dùng bản Debug.

Cài đè lên app cũ thì **dữ liệu trong app được giữ** (đăng nhập, video trong tab Files). Nếu gỡ app
rồi cài lại thì các video chưa upload trong tab Files **sẽ mất** — upload hết trước khi gỡ.

Muốn app dùng lâu dài / cài cho nhiều người: cần tài khoản **Apple Developer** (trả phí) và phát qua
**TestFlight**.

Khi không làm project nữa, có thể tắt **Chế độ nhà phát triển** trên iPhone (app bản thử sẽ không
mở được cho tới khi bật lại).

---

## 8. Lỗi thường gặp

| Hiện tượng | Nguyên nhân / cách sửa |
|---|---|
| Mac không thấy iPhone (`xcrun xctrace list devices` không có iPhone) | Mở khoá iPhone, bấm **Tin cậy**. Khi Mac hỏi cho phép phụ kiện → **Cho phép** (Cài đặt hệ thống → Quyền riêng tư & Bảo mật → **Accessories**). Vẫn không thấy → đổi cáp (cáp chỉ sạc không truyền dữ liệu). |
| Không thấy mục Chế độ nhà phát triển trên iPhone | Mở Xcode → Window → Devices and Simulators, chọn iPhone cho Xcode chuẩn bị xong, rồi mở lại Cài đặt. |
| Build lỗi `errSecInternalComponent` ở bước CodeSign | Keychain đang khoá (thường sau khi Mac ngủ). Chạy `security unlock-keychain ~/Library/Keychains/login.keychain-db`, nhập mật khẩu Mac, build lại. |
| Build lỗi `No profiles for 'com.buituanhiep912.horusapp' were found` | Thiếu `-allowProvisioningUpdates` trong lệnh `xcodebuild`, hoặc chưa đăng nhập Apple ID trong Xcode. |
| `pod install` lỗi `invalid byte sequence in UTF-8` | Có thư mục build nằm trong `ios/` nhưng không tên `build/` (ví dụ `ios/build-release`). Xoá nó, dùng `build/release`. |
| Mở app báo "nhà phát triển không được tin cậy" | Cài đặt → Cài đặt chung → Quản lý VPN & Thiết bị → **Tin cậy**. |
| Bản Release mở lên tắt ngay | Xem lỗi: `xcrun devicectl device process launch --device $UDID --terminate-existing --console com.buituanhiep912.horusapp`. (Lỗi `Cannot make a deep link … no custom scheme` đã sửa bằng `"scheme": "horusapp"` trong `app.json`.) |
| Bản Debug: `Failed to connect to http://…:8081` | Metro chưa chạy, hoặc app chưa được bật quyền **Mạng cục bộ**. |
| Bản Debug: `Expected MIME-Type … but got '(null)'` | Đã nhập sai URL (ví dụ có `/status`). Lắc máy → **Go home** → chọn đúng `http://<IP>:8081`. |
| **Kiểm tra kết nối** trong app thất bại | Backend chưa chạy, sai IP, hoặc iPhone khác mạng Wi-Fi với Mac — xem `multicam-server/docs/local-lan-setup.md`. |
| Không đổi được camera khi đang quay | Hành vi có sẵn của app (chặn đổi cam lúc quay). |
| App bị tắt giữa lúc quay | Mở lại app: video được khôi phục vào tab **Files**, cần **upload tay**. |
