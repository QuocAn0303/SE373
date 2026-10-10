/**
 * modules/chatops/memory.service.js — Bộ nhớ sự thật công ty đa phiên (HERMES Phase 3)
 *
 * - AgentMemory(scope COMPANY|DEPT, status PENDING|ACTIVE|RETIRED), tenant-scoped.
 * - Recall: trước mỗi processQuery (orchestrator.recallMemories) — chỉ ACTIVE.
 * - Ghi: cuối thread, LLM tóm tắt → ứng viên fact → fact COMPANY phải qua duyệt
 *   (tái dùng human-gate DATA_REQUEST, tool='memory_fact') mới ACTIVE.
 * - Điền contextSnapshot khi tạo/đóng session (orchestrator đã làm).
 */
const logger = require('../../utils/logger');
const { buildDataRequestGate, buildDecisionData, createGate } = require('../ai/agent.humangate');

/** LLM tóm tắt thread → ứng viên fact (không DB). Lỗi → [] (đường lui). */
const proposeCandidates = async ({ messages, deptCode, sessionId } = {}) => {
  try {
    const policy = require('../../config/llm-policy');
    const text = (messages || []).map((m) => `${m.role}: ${m.content}`).join('\n').slice(0, 4000);
    if (!text.trim()) return [];
    const r = await policy.callTask('MEMORY_PROPOSE', {
      system: 'Trích sự thật công ty lâu dài từ hội thoại. Chỉ trả JSON {"facts":[{"key":"...","fact":"...","scope":"COMPANY|DEPT"}]}. Bỏ qua số liệu nhất thời.',
      prompt: `Phòng: ${deptCode || '?'}\nHội thoại:\n${text}\nTrả JSON.`,
      jsonMode: true,
      maxOutputTokens: 1024,
    });
    if (!r || r.ok !== true || !r.text) return [];
    const llm = require('../../config/llm');
    const parsed = llm.parseJsonLoose(r.text);
    const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
    return facts
      .filter((f) => f && f.key && f.fact)
      .slice(0, 5)
      .map((f) => ({ key: String(f.key).slice(0, 120), fact: String(f.fact).slice(0, 2000), scope: f.scope === 'DEPT' ? 'DEPT' : 'COMPANY', sourceSessionId: sessionId || null }));
  } catch (e) {
    logger.warn(`[memory] propose bỏ qua: ${e.message}`);
    return [];
  }
};

/**
 * Tạo fact ứng viên.
 *
 * - scope COMPANY → status PENDING + gate duyệt (ADMIN/MANAGER mới nạp được).
 * - scope DEPT → ACTIVE ngay, NHƯNG chỉ MANAGER/ADMIN được tạo, và `departmentId`
 *   phải là phòng của chính người tạo (nếu không, user phòng A ghi được fact vào
 *   phòng B và fact đó lọt vào system prompt của phòng B).
 */
const saveCandidate = async ({ key, fact, scope = 'COMPANY', departmentId = null, sessionId = null, createdById = null, user = null } = {}) => {
  const prisma = require('../../config/prisma');
  if (!prisma.agentMemory) throw { status: 503, message: 'AgentMemory chưa có trong Prisma client — chạy `npx prisma generate` + migrate hermes' };

  const isManager = Boolean(user && ['ADMIN', 'MANAGER', 'SUPER_ADMIN', 'SUPER_OMEGA_ULTRA_ADMIN'].includes(user.role));
  if (scope === 'DEPT' && !isManager) {
    throw { status: 403, message: 'Chỉ MANAGER/ADMIN được ghi fact cấp phòng ban' };
  }

  let deptId = departmentId;
  if (scope === 'DEPT') {
    if (!deptId && user?.deptCode) {
      const d = await prisma.department.findFirst({ where: { code: user.deptCode }, select: { id: true } }).catch(() => null);
      deptId = d?.id || null;
    }
    // MANAGER chỉ được ghi vào phòng mình; ADMIN/SUPER_* được ghi phòng bất kỳ.
    const ownDept = await prisma.department.findFirst({
      where: user?.deptCode ? { code: user.deptCode } : { id: '__none__' },
      select: { id: true },
    }).catch(() => null);
    if (user?.role === 'MANAGER' && ownDept && deptId && deptId !== ownDept.id) {
      throw { status: 403, message: 'MANAGER chỉ được ghi fact cho phòng của mình' };
    }
  } else {
    deptId = null; // COMPANY không gắn phòng
  }

  const mem = await prisma.agentMemory.create({
    data: { scope, departmentId: deptId, key, fact, sourceSessionId: sessionId, status: 'PENDING', createdById },
  });
  let gateId = null;
  if (scope === 'COMPANY') {
    try {
      const gate = await createGate(buildDataRequestGate({
        sessionId, tool: 'memory_fact',
        params: { memoryId: mem.id, key, fact, scope },
        role: null, requestedById: createdById,
      }));
      gateId = gate.id;
    } catch (e) {
      logger.error(`[memory] tạo gate duyệt fact thất bại mem=${mem.id}: ${e.message}`);
      throw e;
    }
  } else {
    // Fact DEPT do MANAGER phòng tự chốt → ACTIVE ngay (vẫn ghi audit gate).
    await prisma.agentMemory.update({ where: { id: mem.id }, data: { status: 'ACTIVE', decidedById: createdById, decidedAt: new Date() } });
  }
  return { memory: mem, gateId };
};

/** Duyệt fact PENDING → ACTIVE (MANAGER/ADMIN). */
const approveMemory = async ({ memoryId, userId, note = null } = {}) => {
  const prisma = require('../../config/prisma');
  const mem = await prisma.agentMemory.findFirst({ where: { id: memoryId } });
  if (!mem) throw { status: 404, message: 'Fact không tồn tại' };
  if (mem.status !== 'PENDING') throw { status: 409, message: `Fact đã ${mem.status}` };
  return prisma.agentMemory.update({
    where: { id: memoryId },
    data: { status: 'ACTIVE', decidedById: userId, decidedAt: new Date() },
  });
};

/** Thu hồi fact → RETIRED. */
const retireMemory = async ({ memoryId, userId } = {}) => {
  const prisma = require('../../config/prisma');
  const mem = await prisma.agentMemory.findFirst({ where: { id: memoryId } });
  if (!mem) throw { status: 404, message: 'Fact không tồn tại' };
  return prisma.agentMemory.update({ where: { id: memoryId }, data: { status: 'RETIRED', decidedById: userId, decidedAt: new Date() } });
};

module.exports = { proposeCandidates, saveCandidate, approveMemory, retireMemory };
