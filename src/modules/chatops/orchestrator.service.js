/**
 * modules/chatops/orchestrator.service.js — Điều phối Hermes (HERMES Phase 1+5)
 *
 * - Gemma: intent + dept routing + tổng hợp. Qwen-thinking khi yêu cầu đa bước.
 * - Mỗi turn ≤ MAX_TOOL_CALLS tool calls, log đủ AgentStep
 *   (LLM_CALL/TOOL_CALL/HUMAN_GATE) thay vì 1 step như agent.routes hiện tại.
 * - WRITE/SPEND luôn qua AgentHumanGate (PENDING) — không thực hiện trực tiếp.
 * - Không gọi thẳng config/llm khi tắt: qua llm-policy (callTask) để có đường lui.
 */
const logger = require('../../utils/logger');
const crypto = require('crypto');
const { getAgent, listAgents } = require('./dept');
const { buildDataRequestGate, buildPoProposalGate, createGate } = require('../ai/agent.humangate');

// Từ khóa → phòng ban (routing nhanh, không cần LLM).
const DEPT_KEYWORDS = [
  { dept: 'SALES', keys: ['tồn kho', 'đơn hàng', 'đặt hàng', 'sản phẩm', 'khuyến mãi', 'giá bán', 'pos'] },
  { dept: 'CSKH', keys: ['đổi trả', 'bảo hành', 'khiếu nại', 'cskh', 'chăm sóc', 'nhắc nợ', 'công nợ kh'] },
  { dept: 'MARKETING', keys: ['chiến dịch', 'campaign', 'phân khúc', 'segment', 'lead', 'rfm', 'churn', 'marketing'] },
  { dept: 'HR', keys: ['nhân sự', 'chấm công', 'lương', 'payroll', 'vi phạm', 'ca làm', 'nhân viên'] },
  { dept: 'ACCOUNTING', keys: ['kế toán', 'sổ cái', 'nhật ký', 'thuế', 'đối soát', 'hóa đơn mua', 'chi phí', 'chi tiêu', 'chính sách', 'công nợ ncc'] },
  { dept: 'OPS', keys: ['nhập hàng', 'tạo po', 'ncc', 'kho', 'chuyển kho', 'kiểm kê', 'sản xuất', 'giao hàng'] },
];

// Tool theo từ khóa (map vào whitelist của từng agent).
// Write tool PHẢI đứng trước (giống INTENTS ở agent.routes.js): "nhắc nợ" vừa khớp
// search_debts vừa khớp send_reminder — đặt write trước để không chặn nhầm read.
const TOOL_KEYWORDS = [
  { tool: 'create_order', dept: 'SALES', keys: ['tạo đơn hàng', 'tạo order', 'bán cho'] },
  { tool: 'create_po', dept: 'OPS', keys: ['tạo po', 'tạo đơn nhập', 'nhập thêm'] },
  { tool: 'send_reminder', dept: 'CSKH', keys: ['nhắc nợ', 'gửi nhắc', 'đòi nợ'] },
  { tool: 'search_inventory', dept: 'OPS', keys: ['tồn kho', 'còn hàng', 'hết hàng'] },
  { tool: 'search_products', dept: 'SALES', keys: ['sản phẩm', 'sku', 'giá bán'] },
  { tool: 'search_orders', dept: 'SALES', keys: ['đơn hàng', 'order'] },
  { tool: 'search_customers', dept: 'CSKH', keys: ['khách hàng', 'customer'] },
  { tool: 'search_promotions', dept: 'SALES', keys: ['khuyến mãi', 'giảm giá'] },
  { tool: 'search_leads', dept: 'MARKETING', keys: ['lead', 'khách tiềm năng'] },
  { tool: 'search_customer_rfm', dept: 'MARKETING', keys: ['rfm', 'phân khúc'] },
  { tool: 'search_churn_alerts', dept: 'MARKETING', keys: ['churn', 'rời bỏ'] },
  { tool: 'search_hr', dept: 'HR', keys: ['nhân sự', 'nhân viên', 'chấm công', 'lương'] },
  { tool: 'search_finance', dept: 'ACCOUNTING', keys: ['sổ', 'kế toán', 'thuế', 'doanh thu'] },
  { tool: 'search_debts', dept: 'CSKH', keys: ['công nợ', 'nợ quá hạn', 'nhắc nợ'] },
  { tool: 'search_vendors', dept: 'OPS', keys: ['ncc', 'nhà cung cấp'] },
  { tool: 'search_purchase_orders', dept: 'OPS', keys: ['đơn nhập', 'purchase order'] },
  { tool: 'search_deliveries', dept: 'OPS', keys: ['giao hàng', 'vận chuyển'] },
  { tool: 'search_production', dept: 'OPS', keys: ['sản xuất', 'lệnh sx'] },
];

// Trần số tool call mỗi lượt. Hiện luồng chỉ gọi MỘT tool (điều phối 1 ý định
// → 1 tool), nên hằng này là CHIẀM BAO vòng lặp thay vì chặn thật — giữ để
// chặn sai sót khi ai đó thêm tool call trong vòng lặp. Xem `toolCallCount`.
const MAX_TOOL_CALLS = 4;

const norm = (s) => String(s || '').toLowerCase();

/** Routing thuần (không LLM/DB) — test được trực tiếp. */
const routeDept = (text) => {
  const t = norm(text);
  let best = null;
  let bestHits = 0;
  for (const d of DEPT_KEYWORDS) {
    const hits = d.keys.filter((k) => t.includes(k)).length;
    if (hits > bestHits) { bestHits = hits; best = d.dept; }
  }
  return bestHits > 0 ? best : null;
};

/** Nhận diện tool + phòng ban thuần keyword. */
const extractTool = (text) => {
  const t = norm(text);
  for (const e of TOOL_KEYWORDS) {
    if (e.keys.some((k) => t.includes(k))) return { tool: e.tool, dept: e.dept };
  }
  return null;
};

/** Yêu cầu đa bước? (2+ mệnh đề nối và/hỏi kép) → dùng Qwen thinking. */
const isMultiStep = (text) => {
  const t = norm(text);
  const joins = [' và ', ' rồi ', ' sau đó ', ';', ' đồng thời ', '+'];
  const hits = joins.filter((j) => t.includes(j)).length;
  return hits >= 1 || t.length > 220;
};

/** Gọi LLM điều phối (Gemma nhanh / Qwen khi đa bước). Lỗi → null (dùng keyword). */
const llmRoute = async (text, deptHint) => {
  try {
    const policy = require('../../config/llm-policy');
    const agents = listAgents().map((a) => `${a.code}: ${a.description}`).join('\n');
    const system = [
      'Bạn là bộ điều phối Hermes của CANDORA. Chỉ trả JSON {"dept","tool","params","needReasoning"}.',
      'Danh sách agent:',
      agents,
      'Không bịa số liệu. WRITE tool (create_order/create_po/send_reminder) luôn cần gate.',
    ].join('\n');
    const multi = isMultiStep(text);
    const r = await policy.callTask('CHATOPS_ROUTE', {
      system,
      prompt: `Dept gợi ý keyword: ${deptHint || 'không rõ'}\nTin nhắn: ${text}\nTrả JSON.`,
      jsonMode: true,
      reasoning: multi,
      maxOutputTokens: multi ? 4000 : 2000,
    });
    if (!r || r.ok !== true || !r.text) return null;
    const llm = require('../../config/llm');
    const parsed = llm.parseJsonLoose(r.text);
    if (!parsed || !parsed.dept) return null;
    return { ...parsed, viaLLM: true, reasoning: multi };
  } catch (e) {
    logger.warn(`[orchestrator] llmRoute fallback keyword: ${e.message}`);
    return null;
  }
};

/** Nạp memory ACTIVE (company + dept) vào system prompt (Phase 3). */
const recallMemories = async (prisma, tenantId, deptCode) => {
  try {
    if (!prisma.agentMemory) return [];
    const dept = deptCode
      ? await prisma.department.findFirst({ where: { code: deptCode }, select: { id: true } }).catch(() => null)
      : null;
    return await prisma.agentMemory.findMany({
      where: {
        status: 'ACTIVE',
        OR: [{ scope: 'COMPANY' }, ...(dept ? [{ scope: 'DEPT', departmentId: dept.id }] : [])],
      },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });
  } catch (e) {
    logger.warn(`[orchestrator] recallMemories bỏ qua: ${e.message}`);
    return [];
  }
};

const memoryBlock = (memories) => {
  if (!memories.length) return '';
  const lines = memories.map((m) => `• [${m.scope}${m.departmentId ? '/dept' : ''}] ${m.key}: ${m.fact} (nguồn: session ${m.sourceSessionId || '?'})`);
  return `\nSự thật công ty đã duyệt (chỉ dùng, không bịa thêm):\n${lines.join('\n')}`;
};

/**
 * Resolve product/vendor THẬT cho đề xuất PO từ câu chat.
 * Câu chat không có SKU/NCC rõ ràng thì trả {ok:false} để orchestrator chuyển sang
 * gate hỏi lại, thay vì dựng gate PO không thể thực thi được.
 */
const resolvePoEntities = async (text) => {
  const prisma = require('../../config/prisma');
  const t = String(text || '');
  const qtyMatch = t.match(/(\d+)\s*(cái|chiếc|hộp|kg|thùng|túi)/i);
  const quantity = qtyMatch ? Number(qtyMatch[1]) : 1;
  const { parseAmount } = require('../../utils/vietnameseAmount');
  const amount = parseAmount(t);

  // TÁCH TÊN NCC TRƯỚC. Nếu không, tên "sáp treo từ NCC An Khang" bị dùng làm
  // điều kiện tìm Product và không sản phẩm nào khớp ⇒ mọi đề xuất PO rơi
  // về nhánh hỏi lại, dù dữ liệu có đầy đủ.
  const vendorPhrase = t.match(/(?:từ|ở|ncc|nhà cung cấp)\s+(.+?)(?:\s+\d+\s|\s*$)/i);
  const vendorName = vendorPhrase ? vendorPhrase[1].trim() : '';

  let rest = t
    .replace(/tạo po|tạo đơn nhập|đặt hàng nhập|nhập thêm/gi, ' ')
    .replace(/(?:từ|ở|ncc|nhà cung cấp)\s+.+$/i, ' ')
    .replace(/\d+\s*(cái|chiếc|hộp|kg|thùng|túi)/gi, ' ')
    .replace(/(triệu|nghìn|tỷ|ng|đồng|tr|k)\b/gi, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (rest.length < 2) {
    return { ok: false, missing: ['productName'] };
  }
  const product = await prisma.product.findFirst({
    where: { isActive: true, name: { contains: rest.slice(0, 60), mode: 'insensitive' } },
    select: { id: true, name: true, sku: true, costPrice: true, price: true },
    orderBy: { createdAt: 'desc' },
  }).catch(() => null);
  if (!product) return { ok: false, missing: ['product'] };

  if (!vendorName) return { ok: false, missing: ['vendorName'] };
  const vendor = await prisma.vendor.findFirst({
    where: { isActive: true, name: { contains: vendorName.slice(0, 60), mode: 'insensitive' } },
    select: { id: true, name: true },
    orderBy: { createdAt: 'desc' },
  }).catch(() => null);
  // Không tìm thấy NCC trong câu chat ⇒ executor không có vendorId hợp lệ để
  // revalidate, nên hỏi lại thay vì dựng gate chắc chắn không thực thi được.
  if (!vendor) return { ok: false, missing: ['vendor'] };

  const unitCost = Number(product.costPrice || amount?.value || 0);
  if (!unitCost) return { ok: false, missing: ['unitCost'] };

  return {
    ok: true,
    items: [{
      productId: product.id, sku: product.sku, productName: product.name,
      vendorId: vendor.id, vendorName: vendor.name,
      quantity, unitCost, totalEstimate: quantity * unitCost,
    }],
  };
};

/**
 * Xử lý 1 tin nhắn chat (dùng chung cho Telegram webhook + API).
 * Trả về { reply, dept, tool, sessionId, gateId, citations }.
 */
const processMessage = async ({ text, user, chatId = null, updateId = null } = {}) => {
  const prisma = require('../../config/prisma');
  const started = Date.now();
  if (!text || !text.trim()) return { reply: 'Bạn muốn hỏi gì?', dept: null, tool: null };
  if (!user || !user.id) throw Object.assign(new Error('Thiếu user'), { status: 401 });

  // Phòng ban của user (User.departmentId → Employee.departmentId).
  let userDept = user.deptCode || null;
  if (!userDept) {
    try {
      const full = await prisma.user.findUnique({
        where: { id: user.id },
        select: { department: { select: { code: true } }, employee: { select: { department: { select: { code: true } } } } },
      }).catch(() => null);
      userDept = full?.department?.code || full?.employee?.department?.code || null;
    } catch { /* giữ null */ }
  }

  const kwTool = extractTool(text);
  const kwDept = routeDept(text);
  const llmPlan = await llmRoute(text, kwDept || userDept);
  const deptCode = (llmPlan?.dept || kwTool?.dept || kwDept || userDept || 'SALES').toUpperCase();
  const tool = llmPlan?.tool || kwTool?.tool || null;

  // Tạo session (thread id nhóm nhiều message: dùng chatId+ngày).
  const session = await prisma.agentSession.create({
    data: {
      userId: user.id,
      userMessage: String(text).slice(0, 4000),
      intent: tool || `CHATOPS:${deptCode}`,
      status: 'RUNNING',
      triggerSource: chatId ? 'TELEGRAM' : 'USER_CHAT',
      contextSnapshot: { deptCode, chatId, updateId, userDept, viaLLM: Boolean(llmPlan?.viaLLM) },
    },
  });
  const steps = [];
  let toolCallCount = 0;
  const pushStep = async (seq, data) => {
    steps.push(data);
    try {
      await prisma.agentStep.create({ data: { sessionId: session.id, sequence: seq, status: 'COMPLETED', ...data } });
    } catch (e) { logger.warn(`[orchestrator] ghi step thất bại: ${e.message}`); }
  };
  await pushStep(1, { type: 'LLM_CALL', toolName: null, toolInput: { text, deptHint: kwDept }, toolOutput: { plan: llmPlan || kwTool }, path: llmPlan?.viaLLM ? 'orchestrator_llm' : 'orchestrator_keyword', durationMs: Date.now() - started });

  const resolved = getAgent(deptCode) || getAgent('SALES');
  const memories = await recallMemories(prisma, user.tenantId, deptCode);
  const memNote = memoryBlock(memories);

  // Hỏi tài liệu nội bộ (Phase 2): từ khóa quy trình/chính sách → cited-QA.
  let citations = [];
  let reply;
  const looksLikePolicyQ = /quy trình|chính sách|quy định|điều \d|bao nhiêu|ai duyệt|thủ tục/i.test(text);
  if (looksLikePolicyQ && !tool) {
    try {
      const cited = require('../ai/cited-qa.service');
      const out = await cited.answerWithCitations(text, user, { departmentCode: userDept });
      citations = out.citations || [];
      reply = out.answer + memNote;
      await pushStep(2, { type: 'TOOL_CALL', toolName: 'cited_qa', toolInput: { text }, toolOutput: { citations }, path: 'cited_qa', durationMs: 0 });
    } catch (e) {
      logger.warn(`[orchestrator] cited-qa fallback: ${e.message}`);
      reply = null;
    }
  }

  if (!reply) {
    if (!tool) {
      reply = `Mình đã chuyển câu hỏi sang *${resolved.name}*. Bạn hỏi cụ thể hơn nhé (vd: "tồn kho SKU X?", "công nợ KH Y?", "chi trên 5tr ai duyệt?").${memNote}`;
      await pushStep(2, { type: 'TOOL_CALL', toolName: 'clarify', toolInput: { text }, toolOutput: { reply }, path: 'clarify', durationMs: 0 });
    } else if ((resolved.writeTools || []).includes(tool)) {
      // WRITE/SPEND → gate PENDING, không thực hiện. Chi tiền không bao giờ auto.
      //
      // KHÔNG ĐƯỢC BỊA PAYLOAD PO. `buildPoProposalGate` cần productId/vendorId THẬT
      // vì `agent.gate.exec` revalidate sẽ tra NCC/SKUs và từ chối nếu không tồn
      // tại — payload `productId:'CHATOPS'` khiến mọi lần duyệt PO đều 400 trong
      // im lặng và người duyệt bị báo "thành công" dù không có PO nào.
      let gatePayload;
      if (tool === 'create_po') {
        const resolvedPo = await resolvePoEntities(text);
        gatePayload = resolvedPo.ok
          ? buildPoProposalGate({ sessionId: session.id, ...resolvedPo.items[0] })
          : buildDataRequestGate({
            sessionId: session.id,
            tool: 'create_po_needs_clarification',
            params: { text, missing: resolvedPo.missing },
            role: user.role,
            requestedById: user.id,
          });
      } else {
        gatePayload = buildDataRequestGate({ sessionId: session.id, tool, params: { text }, role: user.role, requestedById: user.id });
      }
      let gate;
      try {
        gate = await createGate(gatePayload);
      } catch (e) {
        logger.error(`[orchestrator] tạo gate thất bại: ${e.message}`);
        reply = 'Yêu cầu cần phê duyệt nhưng hệ thống chưa ghi được yêu cầu. Vui lòng thử lại.';
        await pushStep(2, { type: 'HUMAN_GATE', toolName: tool, toolInput: { text }, toolOutput: { error: e.message }, path: 'gate_failed', durationMs: 0 });
        gate = null;
      }
      if (gate) {
        // Bật notification in-app (cột humanGateId/requiresAction đã có, chưa ai set).
        try {
          const notif = require('../notifications/notification.service');
          if (notif.createOne) {
            await notif.createOne({
              // NotificationType enum: PO_PENDING_APPROVAL cho gate PO, SYSTEM cho còn lại
              // (AI_ACTION không tồn tại trong enum — smoke-chatops đã bắt).
              type: gate.actionType === 'PURCHASE_ORDER_PROPOSAL' ? 'PO_PENDING_APPROVAL' : 'SYSTEM',
              severity: 'WARNING', title: `Chờ duyệt: ${gate.actionSummary}`.slice(0, 200),
              message: gate.actionSummary, roleScope: 'MANAGER',
              meta: { gateId: gate.id, sessionId: session.id, channel: 'TELEGRAM' },
              humanGateId: gate.id, requiresAction: true,
            });
          }
        } catch (e) { logger.warn(`[orchestrator] notification gate bỏ qua: ${e.message}`); }
        // Tin Telegram kèm nút (fire-and-forget — lỗi gửi không làm hỏng gate).
        if (chatId) {
          try {
            const tg = require('./telegram.service');
            await tg.sendGateCard(chatId, gate);
          } catch (e) { logger.warn(`[orchestrator] gửi Telegram gate bỏ qua: ${e.message}`); }
        }
        reply = `📝 Đã ghi nhận *${tool}* và gửi tới quản lý phê duyệt (mã gate \`${gate.id}\`).${memNote}`;
        await pushStep(2, { type: 'HUMAN_GATE', toolName: tool, toolInput: { text }, toolOutput: { gateId: gate.id }, path: 'human_gate', durationMs: 0 });
        try {
          await prisma.agentSession.update({ where: { id: session.id }, data: { status: 'WAITING_HUMAN', finalResult: { waitingGateId: gate.id } } });
        } catch { /* giữ RUNNING */ }
        return { reply, dept: deptCode, tool, sessionId: session.id, gateId: gate.id, citations };
      }
    } else {
      // Read tool (≤ MAX_TOOL_CALLS thật sự, không phải chỉ trong comment).
      toolCallCount += 1;
      if (toolCallCount > MAX_TOOL_CALLS) {
        reply = 'Câu này cần quá nhiều bước tra cứu trong một lượt. Bạn hỏi riêng từng phần nhé.';
        await pushStep(2, { type: 'TOOL_CALL', toolName: 'budget_exceeded', toolInput: { text, toolCallCount }, toolOutput: {}, path: 'tool_budget', durationMs: 0 });
      } else {
      try {
        const out = await resolved.handle(tool, { search: text, query: text }, { userId: user.id, sessionId: session.id });
        const summary = out?.message || out?.summary || (typeof out === 'string' ? out : JSON.stringify(out).slice(0, 1500));
        reply = `${summary}${memNote}`;
        await pushStep(2, { type: 'TOOL_CALL', toolName: tool, toolInput: { text }, toolOutput: { summary: String(summary).slice(0, 2000) }, path: 'dept_tool', durationMs: Date.now() - started });
      } catch (e) {
        // KHÔNG lộ lỗi hệ thống (Prisma/SQL) cho người dùng Telegram. Chỉ log id
        // tra cứu rồi trả câu chung — chi tiết kỹ thuật có thể chứa tên bảng,
        // tên cột và đoạn truy vấn.
        const errId = crypto.randomBytes(4).toString('hex');
        logger.error(`[orchestrator] tool ${tool} lỗi (ref=${errId}): ${e.message}`);
        reply = e.status === 403
          ? 'Xin lỗi, phòng của bạn không có quyền xem thông tin này. Mình đã ghi nhận để quản lý xem xét.'
          : `Mình chưa tra được dữ liệu lúc này. Mã lỗi: ${errId} (nhờ quản lý tra log).`;
        await pushStep(2, { type: 'TOOL_CALL', toolName: tool, toolInput: { text }, toolOutput: { ref: errId }, path: 'dept_tool_error', durationMs: 0 });
      }
      }
    }
  }

  try {
    await prisma.agentSession.update({
      where: { id: session.id },
      data: { status: 'COMPLETED', finalResult: { response: reply }, endedAt: new Date(), contextSnapshot: { deptCode, chatId, userDept, memoryCount: memories.length } },
    });
  } catch { /* ignore */ }
  return { reply, dept: deptCode, tool, sessionId: session.id, gateId: null, citations };
};

module.exports = {
  DEPT_KEYWORDS,
  TOOL_KEYWORDS,
  MAX_TOOL_CALLS,
  routeDept,
  extractTool,
  isMultiStep,
  llmRoute,
  recallMemories,
  processMessage,
};
