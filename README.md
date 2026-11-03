# Expo App

Ứng dụng React Native dùng Expo để kết nối WebSocket tới server.

## Requirements

- Có 2 loại devices, 1 là máy controller (đăng nhập trên web và dùng acc role controller), 2 là các máy remote (đăng nhập trên các thiết bị đa nền tảng dùng acc role remote). 
- Máy controller có chức năng
   + Tạo 1 project gồm nhiều video quay từ các máy remote gửi lên
   + Tạo phòng để các máy remote cùng join
   + Điều khiển các máy remote qua socket, theo dõi các video đang quay
   + Kết nối với minio để máy remote upload lên minio hoặc thông qua máy controller làm middleware
- Máy remote có chức năng
   + Quay phim, chụp ảnh với thiết bị cấu hình thấp
   + Streaming về máy controller
   + Upload lên minio
   + Có thể điều chỉnh các thông số quay như app blackmagic camera
   + Join vào phòng

## Thiết lập

1. Sao chép file mẫu:
   ```bash
   cp .env.example .env
   ```
2. Chỉnh `WS_HOST` và `WS_PORT` theo máy chủ của bạn.
3. Khởi động Expo:
   ```bash
   npm start
   ```

### iPhone (iOS)

Build và cài app lên iPhone, build lại khi app hết hạn (Apple ID miễn phí: 7 ngày), và các lỗi
thường gặp: [docs/ios-local-setup.md](docs/ios-local-setup.md).
Cách bật backend + MinIO trên Mac nằm ở repo `multicam-server` (`docs/local-lan-setup.md`).

## Biến môi trường

- `WS_HOST`: địa chỉ IP hoặc hostname của server WebSocket.
- `WS_PORT`: cổng server WebSocket.
