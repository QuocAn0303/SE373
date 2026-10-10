/**
 * modules/dept-budget/dept-budget.service.js — Ngân sách chi tiêu phòng ban (HERMES Phase 5)
 *
 * - DeptBudget(departmentId, month, limit, spent) + approver chain
 *   (MANAGER phòng → ADMIN). Chi vượt envelope → auto-escalate.
 * - PO <5tr auto chỉ khi trong envelope (nguyên tắc §0: chi tiền không bao giờ auto
 *   ngoài envelope; trong envelope vẫn qua gate từng lần).
 */
const AUTO_LIMIT = 5000000; // <5tr
const MANAGER_LIMIT = 50000000; // 5–50tr MANAGER, >50tr ADMIN

const needClient = () => {
  const prisma = require('../../config/prisma');
  if (!prisma.deptBudget) throw { status: 503, message: 'DeptBudget chưa có trong Prisma client — chạy `npx prisma generate` + migrate hermes' };
  return prisma;
};

const currentMonthYear = () => {
  const n = new Date();
  return { month: n.getMonth() + 1, year: n.getFullYear() };
};

/** Lấy/tạo envelope tháng (upsert — tránh race findFirst→create). */
const envelope = async ({ departmentId, month, year } = {}) => {
  const prisma = needClient();
  const m = month || currentMonthYear().month;
  const y = year || currentMonthYear().year;
  const { getTenantId } = require('../../config/tenantContext');
  const tenantId = getTenantId() || null;
  return prisma.deptBudget.upsert({
    where: { tenantId_departmentId_month_year: { tenantId, departmentId, month: m, year: y } },
    create: { tenantId, departmentId, month: m, year: y, limit: 50000000, spent: 0 },
    update: {}, // không ghi đè limit/spent đã có
  });
};

/**
 * Kiểm tra 1 khoản chi. Trả về { allowed, approver, reason, overEnvelope, envelope, remaining }.
 *
 * `allowed` LUÔN true vì mọi khoản chi đều đi qua gate (nguyên tắc: chi tiền
 * không bao giờ auto). `allowed` ở đây chỉ nói "khoản này CÓ cần duyệt" — nó
 * không phải cổng chặn, và trước đây là field trang trí ai cũng tưởng là guard.
 * Muốn chặn thật thì kiểm `approver` và `overEnvelope`, rồi ép gate.
 *
 * - amount <5tr + trong envelope → MANAGER phòng.
 * - 5–50tr → MANAGER phòng; >50tr → ADMIN.
 * - Vượt envelope → auto-escalate lên ADMIN kèm lý do.
 */
const checkSpend = async ({ departmentId, amount } = {}) => {
  const total = Number(amount || 0);
  const env = await envelope({ departmentId });
  const remaining = Number(env.limit) - Number(env.spent);
  const base = { envelope: env, remaining, needsApproval: true };
  if (total > remaining) {
    return { ...base, allowed: true, approver: 'ADMIN', overEnvelope: true, reason: `Vượt ngân sách phòng (${remaining.toLocaleString('vi-VN')}đ còn lại) — escalate ADMIN` };
  }
  if (total < AUTO_LIMIT) return { ...base, allowed: true, approver: 'MANAGER', overEnvelope: false, reason: 'Trong envelope, dưới 5tr' };
  if (total <= MANAGER_LIMIT) return { ...base, allowed: true, approver: 'MANAGER', overEnvelope: false, reason: '5–50tr: MANAGER phòng' };
  return { ...base, allowed: true, approver: 'ADMIN', overEnvelope: false, reason: 'Trên 50tr: ADMIN' };
};

/**
 * Cộng dồn spent sau khi gate spend APPROVED + executed.
 * Dùng `increment` (UPDATE ... SET spent = spent + x) thay vì đọc-rồi-ghi:
 * hai lần duyệt song song sẽ không làm mất một khoản (read-modify-write mất).
 */
const addSpent = async ({ departmentId, amount, month, year } = {}) => {
  const prisma = needClient();
  const m = month || currentMonthYear().month;
  const y = year || currentMonthYear().year;
  const env = await envelope({ departmentId, month: m, year: y });
  return prisma.deptBudget.update({
    where: { id: env.id },
    data: { spent: { increment: Number(amount || 0) } },
  });
};

module.exports = { envelope, checkSpend, addSpent, AUTO_LIMIT, MANAGER_LIMIT };
