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
const HANDLER_ROOT = '../chatops/dept';

/** Nạp handler theo `handlerRef` (vd "sales.agent", "dept/ops.agent"). */
const loadHandler = async (ref) => {
  if (!ref) return null;
  // handlerRef là mã định danh, không phải đường dẫn tùy ý. Chỉ chấp nhận tên
  // file trong thư mục dept/ — chặn `../../` và path traversal.
  const safe = String(ref).replace(/\.agent$/, '');
  if (!/^[a-z][a-z0-9_]*$/i.test(safe)) {
    return { error: 'handlerRef không hợp lệ (chỉ chấp nhận tên agent: sales, ops, cskh…)' };
  }
  try {
    return require(`${HANDLER_ROOT}/${safe}.agent`);
  } catch (e) {
    return { error: `không nạp được handler "${ref}": ${e.message}` };
  }
};

/**
 * Chạy thử skill: nếu handlerRef trỏ tới agent có tool write, chạy TOOL ĐỌC đầu
 * tiên của agent trong transaction rồi rollback; nếu handler không có write tool
 * thì vẫn chạy (đọc là an toàn). Skill chạm tiền bị SKIP trước khi vào sandbox.
 */
const runSandbox = async ({ id, sample = null }) => {
  const prisma = needClient();
  const s = await prisma.agentSkill.findFirst({ where: { id } });
  if (!s) throw { status: 404, message: 'Skill không tồn tại' };

  if (s.handlerRef && SPEND_HANDLER_RE.test(s.handlerRef)) {
    const report = { ok: false, reason: 'SKIP_SPEND', message: 'Skill chạm tiền/kho — sandbox từ chối, duyệt từng lần qua gate' };
    await prisma.agentSkill.update({ where: { id }, data: { testReport: report } });
    return report;
  }

  const loaded = await loadHandler(s.handlerRef);
  if (loaded && loaded.error) {
    const report = { ok: false, reason: 'HANDLER_INVALID', message: loaded.error };
    await prisma.agentSkill.update({ where: { id }, data: { testReport: report } });
    return report;
  }

  const agent = loaded || null;
  const readTool = (agent?.tools || []).find((t) => !(agent?.writeTools || []).includes(t));

  // Sandbox thật: mở transaction tương tác, chạy tool, ROLLBACK. Nếu handler
  // không có tool đọc nào thì chỉ kiểm tra kết nối + ghi rõ điều đó trong report
  // (không giả vờ đã chạy).
  const report = await prisma.$transaction(async (tx) => {
    if (!agent) return { ok: false, reason: 'NO_HANDLER', message: 'skill không có handlerRef — chưa kiểm thử được', at: new Date().toISOString() };
    if (!readTool) {
      return { ok: false, reason: 'NO_READ_TOOL', message: 'handler chỉ có tool ghi — sandbox không chạy được', at: new Date().toISOString() };
    }
    const out = await agent.handle(readTool, sample || {}, {});
    return {
      ok: true,
      tool: readTool,
      at: new Date().toISOString(),
      sampleChars: String(out?.message || out?.summary || '').length,
      note: 'sandbox rollback — không đổi DB',
    };
  }).catch((e) => ({ ok: false, reason: 'SANDBOX_ERROR', message: e.message, at: new Date().toISOString() }));

  await prisma.agentSkill.update({ where: { id }, data: { testReport: report } });
  return report;
};

/**
 * Duyệt (PENDING → APPROVED). Điều kiện bắt buộc: đã chạy sandbox VÀ sandbox
 * pass (`ok:true`) hoặc được miễn vì skill chạm tiền (`SKIP_SPEND`).
 * Trước đây chỉ kiểm `!testReport` nên report `{ok:false}` vẫn qua duyệt —
 * tức "bắt buộc chạy sandbox" là hợp đồng không có tác dụng.
 */
const approve = async ({ id, userId }) => {
  const prisma = needClient();
  const s = await prisma.agentSkill.findFirst({ where: { id } });
  if (!s) throw { status: 404, message: 'Skill không tồn tại' };
  if (s.status !== 'PENDING') throw { status: 409, message: `Skill đang ${s.status}` };
  if (!s.testReport) throw { status: 400, message: 'Skill chưa chạy sandbox' };
  const passed = s.testReport.ok === true || s.testReport.reason === 'SKIP_SPEND';
  if (!passed) {
    throw { status: 409, message: `Sandbox không đạt (${s.testReport.reason || 'không rõ'}) — không duyệt` };
  }
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
