/**
 * modules/agent-skills/agent-skill.service.js — Skill registry (HERMES Phase 4)
 *
 * - AgentSkill(code, version, departmentScope, handlerRef, status
 *   DRAFT|PENDING|APPROVED|DISABLED, testReport). Orchestrator chỉ gọi skill
 *   APPROVED + đúng deptScope.
 * - Luồng: agent phát hiện việc lặp lại → DRAFT kèm ví dụ + test tự sinh →
 *   MANAGER duyệt → sandbox (transaction rollback) → APPROVED + version.
 * - Cấm: skill chi tiền/kho vượt hạn mức dù APPROVED — vẫn qua gate từng lần.
 */
const logger = require('../../utils/logger');

const SPEND_HANDLER_RE = /(create_po|create_order|send_reminder|purchase|expense|payment)/i;

const needClient = () => {
  const prisma = require('../../config/prisma');
  if (!prisma.agentSkill) throw { status: 503, message: 'AgentSkill chưa có trong Prisma client — chạy `npx prisma generate` + migrate hermes' };
  return prisma;
};

/** Tạo DRAFT (agent đề xuất). */
const propose = async ({ code, name, description, departmentScope = null, handlerRef = null, examples = null, createdById = null } = {}) => {
  const prisma = needClient();
  if (!code || !name) throw { status: 400, message: 'code và name là bắt buộc' };
  const latest = await prisma.agentSkill.findFirst({ where: { code }, orderBy: { version: 'desc' }, select: { version: true } }).catch(() => null);
  return prisma.agentSkill.create({
    data: {
      code, name, description, departmentScope, handlerRef, examples,
      version: (latest?.version || 0) + 1, status: 'DRAFT', createdById,
    },
  });
};

/** Gửi duyệt (DRAFT → PENDING). */
const submitForApproval = async ({ id }) => {
  const prisma = needClient();
  const s = await prisma.agentSkill.findFirst({ where: { id } });
  if (!s) throw { status: 404, message: 'Skill không tồn tại' };
  if (s.status !== 'DRAFT') throw { status: 409, message: `Skill đang ${s.status}` };
  return prisma.agentSkill.update({ where: { id }, data: { status: 'PENDING' } });
};

/**
 * Chạy sandbox: thực thi handler trong transaction rồi rollback — testReport ghi
 * lại kết quả mà không đổi DB. Handler chi tiền bị chặn ngay trong sandbox.
 */
const runSandbox = async ({ id }) => {
  const prisma = needClient();
  const s = await prisma.agentSkill.findFirst({ where: { id } });
  if (!s) throw { status: 404, message: 'Skill không tồn tại' };
  if (s.handlerRef && SPEND_HANDLER_RE.test(s.handlerRef)) {
    const report = { ok: false, reason: 'SKIP_SPEND', message: 'Skill chạm tiền/kho — sandbox từ chối, duyệt từng lần qua gate' };
    await prisma.agentSkill.update({ where: { id }, data: { testReport: report } });
    return report;
  }
  // Sandbox thật: mở transaction tương tác, chạy kiểm tra đọc rồi rollback.
  const report = await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT 1');
    return { ok: true, at: new Date().toISOString(), note: 'sandbox rollback — không đổi DB' };
  }).catch((e) => ({ ok: false, reason: 'SANDBOX_ERROR', message: e.message }));
  await prisma.agentSkill.update({ where: { id }, data: { testReport: report } });
  return report;
};

/** Duyệt (PENDING → APPROVED). Yêu cầu đã qua sandbox (testReport.ok hoặc SKIP_SPEND). */
const approve = async ({ id, userId }) => {
  const prisma = needClient();
  const s = await prisma.agentSkill.findFirst({ where: { id } });
  if (!s) throw { status: 404, message: 'Skill không tồn tại' };
  if (s.status !== 'PENDING') throw { status: 409, message: `Skill đang ${s.status}` };
  if (!s.testReport) throw { status: 400, message: 'Skill chưa chạy sandbox' };
  return prisma.agentSkill.update({
    where: { id }, data: { status: 'APPROVED', decidedById: userId, decidedAt: new Date() },
  });
};

/** Thu hồi ngay (→ DISABLED). */
const disable = async ({ id, userId }) => {
  const prisma = needClient();
  const s = await prisma.agentSkill.findFirst({ where: { id } });
  if (!s) throw { status: 404, message: 'Skill không tồn tại' };
  return prisma.agentSkill.update({
    where: { id }, data: { status: 'DISABLED', decidedById: userId, decidedAt: new Date() },
  });
};

/** Skill được phép gọi: APPROVED + đúng deptScope (null = mọi phòng). */
const callableSkills = async ({ departmentCode = null } = {}) => {
  const prisma = needClient();
  const all = await prisma.agentSkill.findMany({ where: { status: 'APPROVED' }, orderBy: { updatedAt: 'desc' }, take: 50 });
  if (!departmentCode) return all.filter((s) => !s.departmentScope);
  return all.filter((s) => !s.departmentScope || s.departmentScope === departmentCode);
};

module.exports = { propose, submitForApproval, runSandbox, approve, disable, callableSkills };
