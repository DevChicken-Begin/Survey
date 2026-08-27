# Leggett & Platt - Hệ Thống Tạo & Quản Trị Khảo Sát

Hệ thống ứng dụng Web tạo và quản trị khảo sát đơn file (`index.html`) chuẩn giao diện Figma Free Bootcamp, tích hợp kiến trúc Backend Cloudflare Worker và Database Neon Serverless PostgreSQL.

---

## 🌟 Tính Năng Nổi Bật

1. **Thiết Kế & Giao Diện Figma Chuẩn 100%**:
   - Header hiển thị Logo chính thức `Leggett & Platt` (`Leggett.jpg`).
   - Tái hiện trọn vẹn phong cách giao diện Bootcamp Survey Form: background coder team chất lượng cao với lớp phủ gradient tím sang trọng (`linear-gradient(135deg, rgba(46, 32, 110, 0.85), rgba(28, 16, 75, 0.90))`), form box glassmorphism mờ viền, nút bấm xanh lá cây Figma (`#22c55e`), các trường nhập liệu tương phản cao và rõ nét.
   - Hoàn toàn gói gọn trong **1 file duy nhất `index.html`** (đã nhúng sẵn Logo Base64, Background Base64, Trình sinh QR Code độc lập, Trình xuất Excel tiếng Việt có dấu và Cơ chế lưu trữ offline/online).

2. **Quy Trình Khảo Sát Tùy Biến (Intro & Xác Thực Nhân Viên)**:
   - **Tùy chỉnh Intro**: Tiêu đề chính (Intro Header) và Mô tả/Hướng dẫn (Intro Description).
   - **Màn hình Intro Xác thực Nhân viên**: Người làm khảo sát phải nhập thông tin trước khi bắt đầu:
     - **Mã Số Nhân Viên (MSNV)** *(Bắt buộc)*
     - **Họ và Tên** *(Bắt buộc)*
     - **Bộ Phận / Phòng Ban** *(Bắt buộc - Menu chọn phòng ban hoặc tự nhập)*
   - **Huy hiệu thông tin (Profile Badge)**: Khi vào làm khảo sát, thông tin nhân viên (`👤 Họ tên • 🆔 MSNV • 🏢 Bộ phận`) được ghim ở đầu bài làm.

3. **Trình Tạo Câu Hỏi Linh Hoạt (Google Forms Style)**:
   - Hỗ trợ đầy đủ các dạng câu hỏi:
     - 🔘 **Trắc nghiệm 1 đáp án** (Single Choice / Radio)
     - ☑️ **Trắc nghiệm nhiều đáp án** (Multiple Choice / Checkbox)
     - 🔽 **Danh sách thả xuống** (Select Dropdown)
     - ✍️ **Tự luận ngắn** (Short Text Answer)
     - 📝 **Tự luận đoạn văn** (Long Paragraph / Textarea)
     - ⭐ **Đánh giá thang điểm** (Rating 1 - 5 Sao)
   - Thêm/Xóa phương án, sắp xếp thứ tự (Move Up/Down), Nhân bản câu hỏi (Duplicate), Bật/Tắt Bắt buộc trả lời (*).

4. **Tự Động Sinh Link Công Khai & Mã QR Riêng**:
   - Sau khi lưu khảo sát, hệ thống tự động sinh:
     - **Link tự sinh**: URL chia sẻ công khai độc lập (chạy được trên máy tính và điện thoại di động).
     - **Mã QR Code**: Mã QR độ nét cao vẽ trực tiếp trên Canvas.
     - Nút **"📋 Sao Chép Link"**, **"📥 Tải Ảnh QR (PNG)"**, **"🔗 Mở Làm Thử"**.

5. **Lưu Trữ & Gửi Dữ Liệu Về Hệ Thống**:
   - Dữ liệu gửi về **Cloudflare Worker** -> Lưu vào Database **Neon Serverless PostgreSQL**.
   - Tự động lưu trữ dự phòng vào **IndexedDB** trên trình duyệt để hoạt động ngoại tuyến (Offline-First) và không bị mất dữ liệu khi mất mạng.

6. **Admin Dashboard, Xuất Excel & Xóa Dữ Liệu (Reset Tránh Phình Neon DB)**:
   - **Bảng Quản lý Dữ liệu**: Thống kê số lượng bài nộp, số nhân viên, số phòng ban; tìm kiếm & lọc theo MSNV, Tên, Bộ phận; xem chi tiết từng bài làm trong Modal.
   - **Xuất File Excel (.xlsx / .xls)**: Bảng tính Excel chuẩn UTF-8 hiển thị hoàn hảo tiếng Việt có dấu, đầy đủ thông tin nhân viên và các cột câu hỏi.
   - **Xóa Toàn Bộ Dữ Liệu (Reset Hệ Thống)**: Nút màu đỏ có xác nhận bảo mật 2 lớp (yêu cầu gõ "XOA") để thực thi lệnh `TRUNCATE TABLE responses;` trên Neon DB và xóa sạch bộ nhớ tạm, đưa hệ thống về trạng thái ban đầu để tránh Neon DB bị phình dung lượng.

---

## 🚀 Hướng Dẫn Thiết Lập Neon DB & Cloudflare Worker

### Bước 1: Tạo Database trên Neon
1. Đăng ký/Đăng nhập tại [https://neon.tech](https://neon.tech) (Miễn phí).
2. Tạo Project mới và copy **Connection String** (ví dụ: `postgresql://user:password@ep-xyz.us-east-2.aws.neon.tech/neondb?sslmode=require`).
3. Vào mục **SQL Editor** trên Neon Dashboard và chạy câu lệnh tạo bảng:

```sql
-- 1. Bảng lưu trữ cấu hình khảo sát
CREATE TABLE IF NOT EXISTS surveys (
    id VARCHAR(64) PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    questions JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Bảng lưu trữ kết quả trả lời từ nhân viên
CREATE TABLE IF NOT EXISTS responses (
    id SERIAL PRIMARY KEY,
    survey_id VARCHAR(64) NOT NULL,
    employee_msnv VARCHAR(64) NOT NULL,
    employee_name VARCHAR(255) NOT NULL,
    employee_dept VARCHAR(255) NOT NULL,
    answers JSONB NOT NULL,
    submitted_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Chỉ mục tối ưu tốc độ tìm kiếm
CREATE INDEX IF NOT EXISTS idx_resp_survey ON responses(survey_id);
CREATE INDEX IF NOT EXISTS idx_resp_msnv ON responses(employee_msnv);
```

### Bước 2: Tạo Cloudflare Worker
1. Đăng nhập [Cloudflare Dashboard](https://dash.cloudflare.com) -> vào **Workers & Pages** -> **Create Application** -> **Create Worker**.
2. Đặt tên worker (ví dụ: `survey-backend`) và chọn **Deploy**.
3. Vào **Settings** -> **Variables and Secrets** -> Thêm Secret:
   - Key: `DATABASE_URL`
   - Value: Connection String lấy từ Neon ở Bước 1.
4. Chọn **Edit Code** và dán toàn bộ mã nguồn Cloudflare Worker (được cung cấp sẵn trong tab **"Cấu Hình Neon / Cloudflare"** bên trong ứng dụng).
5. Lưu và Deploy Worker.

### Bước 3: Cấu hình trong ứng dụng
1. Mở file [index.html](file:///workspaces/Survey/index.html) trên trình duyệt.
2. Chuyển sang tab **"Cấu Hình Neon / Cloudflare"**.
3. Điền URL của Cloudflare Worker (ví dụ: `https://survey-backend.your-account.workers.dev`) và bấm **Lưu Cấu Hình** & **Kiểm Tra Kết Nối**.
