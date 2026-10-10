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

/** Lấy/tạo envelope tháng hiện tại của phòng. */
const envelope = async ({ departmentId, month, year } = {}) => {
  const prisma = needClient();
  const m = month || currentMonthYear().month;
  const y = year || currentMonthYear().year;
  let row = await prisma.deptBudget.findFirst({ where: { departmentId, month: m, year: y } }).catch(() => null);
  if (!row) {
    const tenantId = require('../../config/tenantContext').getTenantId() || null;
    row = await prisma.deptBudget.create({ data: { tenantId, departmentId, month: m, year: y, limit: 50000000, spent: 0 } });
  }
  return row;
};

/**
 * Kiểm tra 1 khoản chi. Trả về { allowed, approver, reason, overEnvelope }.
 * - amount <5tr + trong envelope → MANAGER phòng (auto chỉ khi trong envelope).
 * - 5–50tr → MANAGER phòng; >50tr → ADMIN.
 * - Vượt envelope → auto-escalate lên ADMIN kèm lý do.
 */
const checkSpend = async ({ departmentId, amount } = {}) => {
  const total = Number(amount || 0);
  const env = await envelope({ departmentId });
  const remaining = Number(env.limit) - Number(env.spent);
  const overEnvelope = total > remaining;
  if (overEnvelope) {
    return { allowed: true, approver: 'ADMIN', overEnvelope: true, envelope: env, reason: `Vượt ngân sách phòng (${remaining.toLocaleString('vi-VN')}đ còn lại) — escalate ADMIN` };
  }
  if (total < AUTO_LIMIT) return { allowed: true, approver: 'MANAGER', overEnvelope: false, envelope: env, reason: 'Trong envelope, dưới 5tr' };
  if (total <= MANAGER_LIMIT) return { allowed: true, approver: 'MANAGER', overEnvelope: false, envelope: env, reason: '5–50tr: MANAGER phòng' };
  return { allowed: true, approver: 'ADMIN', overEnvelope: false, envelope: env, reason: 'Trên 50tr: ADMIN' };
};

/** Cộng dồn spent sau khi gate spend APPROVED + executed. */
const addSpent = async ({ departmentId, amount, month, year } = {}) => {
  const prisma = needClient();
  const m = month || currentMonthYear().month;
  const y = year || currentMonthYear().year;
  const env = await envelope({ departmentId, month: m, year: y });
  return prisma.deptBudget.update({
    where: { id: env.id },
    data: { spent: Number(env.spent) + Number(amount || 0) },
  });
};

module.exports = { envelope, checkSpend, addSpent, AUTO_LIMIT, MANAGER_LIMIT };
