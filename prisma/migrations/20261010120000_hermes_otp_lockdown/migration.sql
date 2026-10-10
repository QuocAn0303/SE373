-- HERMES (2026-10-10) — siết bảo mật sau code review: OTP chống dò + fail-closed webhook
--
-- VÌ SAO CẦN MIGRATION NÀY
-- `chat_bindings.otpCode` lưu OTP 6 chữ số PLAINTEXT và được tra cứu TOÀN CỤC
-- (`findFirst({ where: { provider, otpCode } })`) từ webhook PUBLIC. Không có bộ đếm
-- lần sai, không có khoá. Kết hợp với webhook fail-open (chấp nhận khi secret
-- chưa set), kẻ tấn công chỉ cần đoán 6 chữ số rồi buộc Telegram của mình vào
-- tài khoản ERP ADMIN/MANAGER — đường chiếm tài khoản hoàn chỉnh.
--
-- AN TOÀN
--   - ADDITIVE: chỉ thêm cột, không xoá gì.
--   - `otpCode` cũ chứa plaintext của các binding CHƯA xác thực. Xóa chúng ở đây
--     (điều kiện `otpCode IS NOT NULL`) thay vì migrate thành hash: giá trị này là
--     bí mật tạm, người dùng chỉ cần gọi lại GET /bind để có mã mới. Giữ lại
--     plaintext sau khi khai báo "lưu hash" là hợp đồng sai.

-- 1. Cột đếm lần sai + khoá
ALTER TABLE "chat_bindings"
    ADD COLUMN IF NOT EXISTS "otpAttempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "otpLockedUntil" TIMESTAMP(3);

-- 2. Index tìm theo hash: tra cứu vẫn phải nhanh (webhook gọi mỗi tin nhắn).
--    Index cũ trên "otpCode" vẫn dùng được (cùng cột) — không cần index mới.
CREATE INDEX IF NOT EXISTS "chat_bindings_otpCode_hash_idx" ON "chat_bindings"("otpCode");

-- 3. Vô hiệu các OTP plaintext còn sót (chỉ dòng CHƯA bind).
--    `isActive = false` ⇒ đây là binding đang chờ xác thực.
UPDATE "chat_bindings"
   SET "otpCode" = NULL, "otpAttempts" = 0, "otpLockedUntil" = NULL
 WHERE "otpCode" IS NOT NULL
   AND "isActive" = false;

COMMENT ON COLUMN "chat_bindings"."otpCode" IS
    'SHA-256 của mã OTP 6 chữ số. KHÔNG lưu plaintext — endpoint webhook là public.';
COMMENT ON COLUMN "chat_bindings"."otpAttempts" IS
    'Số lần đoán OTP sai. Vượt 5 lần thì khoá tới otpLockedUntil.';
COMMENT ON COLUMN "chat_bindings"."otpLockedUntil" IS
    'Mốc khoá OTP sau N lần đoán sai. NULL = không bị khoá.';