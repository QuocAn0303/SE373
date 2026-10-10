/**
 * modules/ai/agent.routes.js — Chat agent AI nội bộ
 * 
 * Tổng quan:
 * - Xử lý chat với người dùng, phát hiện intent và gọi tool tương ứng
 * - Hỗ trợ 15 intents (đặc tả §3.3): tồn kho, nhân sự, đơn hàng, chi tiết đơn, khách hàng,
 *   dashboard, doanh thu, churn alerts, RFM/CLV, leads, GRN, hóa đơn NCC + 3 write intents
 * - Lưu session và feedback
 * - Thống kê analytics agent
 * 
 * Routes:
 * - POST /chat: Xử lý tin nhắn chat, detect intent → gọi tool handler → trả lời
 * - GET /sessions: Lịch sử session agent của user
 * - POST /feedback: Gửi feedback cho session
 * - GET /analytics: Thống kê agent (số session, độ trễ, feedback)
 * 
 * Handlers:
 * - TOOL_HANDLERS: queryInventory, getEmployeeInfo, listOrders, getOrderDetail, customerLookup,
 *   viewDashboard, getRevenue, queryChurnAlerts, queryRfmSegments, queryLeads, queryGrn, queryPurchaseInvoices
 *   + write: createOrder, createPO, sendReminder
 * - detectIntent(text): Phân tích text để tìm intent phù hợp
 */
const express = require('express');
const { authenticate, authorize } = require('../../middleware/auth.middleware');
const { requireModule } = require('../../middleware/plan.middleware');

const router = express.Router();
router.use(authenticate, requireModule("ai"));

const prisma = require('../../config/prisma');
const { processQuery, generateResponse, HANDLERS } = require('./db-agent.service');
const logger = require('../../utils/logger');
const { parseAmount } = require('../../utils/vietnameseAmount');
const {
  buildDataRequestGate,
  buildWriteActionGate,
  buildDecisionData,
  createGate,
  PO_PROPOSAL,
} = require('./agent.humangate');
const { executeGate, retryExecution } = require('./agent.gate.exec');

// ─────────────────────────────────────────────────────────────
// M3: Role matrix cho tool AI
// - Tool nhạy cảm (PII: SĐT/email/địa chỉ KH, nhân viên, tài chính, nợ)
//   chỉ chạy trực tiếp với ADMIN/MANAGER/ACCOUNTANT
// - Role thấp (CASHIER/WAREHOUSE) → tạo DATA_REQUEST chờ ADMIN/MANAGER
//   phê duyệt (nút request: GET /human-gates → POST /human-gates/:id/decide)
// ─────────────────────────────────────────────────────────────
const SENSITIVE_TOOLS = new Set([
  'getEmployeeInfo',
  'getOrderDetail',
  'customerLookup',
  // CRM/SRM — PII khách hàng (SĐT, hành vi, điểm churn/RFM)
  'queryChurnAlerts',
  'queryRfmSegments',
  'queryLeads',
]);

const SENSITIVE_DB_TOOLS = new Set([
  'search_customers',
  'search_hr',
  'search_debts',
  'search_finance',
  'search_vendors',
  'search_churn_alerts',
  'search_customer_rfm',
  'search_leads',
  // PRM — hai tool này lấy dữ liệu từ `roi.service.js` và `referral.service.js`.
  // `search_partner_performance` chỉ trả số liệu cấp đối tác (tên đối tác, lợi nhuận),
  // không có PII khách — nhưng nó vẫn để trong danh sách nhạy cảm vì CÙNG đường với
  // `search_partner_referrals`, mà cái sau TRẢ TÊN KHÁCH HÀNG. Tách ra thì mọi
  // người đọc danh sách đều phải phân tích lại nội dung từng tool, và chỉ một
  // người đã viết mới biết. Giữ cả hai trong danh sách là lựa chọn an toàn hơn.
  'search_partner_performance',
  'search_partner_referrals',
]);

const SENSITIVE_ALLOWED_ROLES = [
  'SUPER_OMEGA_ULTRA_ADMIN',
  'SUPER_ADMIN',
  'ADMIN',
  'MANAGER',
  'ACCOUNTANT',
];

const isSensitiveAllowed = (role) => SENSITIVE_ALLOWED_ROLES.includes(role);

const createDataRequest = (sessionId, tool, params, user = {}) =>
  createGate(buildDataRequestGate({
    sessionId,
    tool,
    params,
    role: user.role || null,
    requestedById: user.id || null,
  }));

// HERMES Phase 1.2: bật notification cho gate (cột humanGateId/requiresAction đã
// có từ trước nhưng chưa ai set). Lỗi notification không làm hỏng gate.
const notifyGateCreated = async (gate) => {
  try {
    await prisma.notification.create({
      data: {
        // NotificationType enum — AI_ACTION không tồn tại (smoke-chatops đã bắt).
        type: gate?.actionType === PO_PROPOSAL ? 'PO_PENDING_APPROVAL' : 'SYSTEM',
        severity: 'WARNING',
        title: `Chờ duyệt: ${gate.actionSummary}`.slice(0, 200),
        message: gate.actionSummary,
        roleScope: 'MANAGER',
        meta: { gateId: gate.id, sessionId: gate.sessionId, actionType: gate.actionType },
        humanGateId: gate.id,
        requiresAction: true,
      },
    });
  } catch (e) {
    logger.warn(`[Agent Gate] notification gate ${gate?.id} bỏ qua: ${e.message}`);
  }
};

const DATA_REQUEST_REPLY =
  'Dữ liệu bạn yêu cầu thuộc loại nhạy cảm (thông tin khách hàng, nhân viên hoặc tài chính). ' +
  'Yêu cầu đã được gửi tới ADMIN/MANAGER để phê duyệt. Kết quả sẽ được cập nhật sau khi được duyệt.';

const DATA_REQUEST_FAILED_REPLY =
  'Yêu cầu của bạn liên quan đến dữ liệu nhạy cảm và cần ADMIN/MANAGER phê duyệt, ' +
  'nhưng hệ thống chưa ghi được yêu cầu. Vui lòng thử lại hoặc liên hệ quản trị viên.';

/**
 * Ghi audit gate cho một write action đã thực hiện xong.
 * Không được làm hỏng response (hành động đã xảy ra rồi) nhưng lỗi PHẢI được log
 * rõ ràng — trước đây lỗi bị nuốt khiến mất hoàn toàn dấu vết kiểm toán.
 */
const recordWriteAudit = async (sessionId, actionType, params, userId) => {
  try {
    await createGate(buildWriteActionGate({ sessionId, actionType, params, decidedById: userId }));
    return true;
  } catch (e) {
    logger.error(`[Agent Gate] MẤT audit trail cho write action ${actionType} (session ${sessionId}): ${e.message}`);
    return false;
  }
};

const TOOL_HANDLERS = {
  queryInventory: async ({ query }) => {
    const q = query || '';
    const items = await prisma.inventory.findMany({
      where: { product: { isActive: true, OR: [{ name: { contains: q, mode: 'insensitive' } }, { sku: { contains: q, mode: 'insensitive' } }] } },
      include: { product: { select: { id: true, name: true, sku: true, price: true } } },
      orderBy: { quantity: 'asc' }, take: 15,
    });
    if (!items.length) return 'Không tìm thấy sản phẩm nào.';
    return items.map(i => `• ${i.product?.name} (SKU: ${i.product?.sku}): Tồn ${i.quantity}, Khả dụng ${i.quantity - (i.reserved || 0)}, Tối thiểu ${i.minStock}`).join('\n');
  },
  getEmployeeInfo: async ({ employeeName }) => {
    const q = employeeName || '';
    const users = await prisma.user.findMany({
      where: { fullName: { contains: q, mode: 'insensitive' }, isActive: true },
      include: { employee: { include: { shifts: { take: 5, orderBy: { date: 'desc' } } } } },
      take: 5,
    });
    const employees = users.filter(u => u.employee).map(u => u.employee);
    if (!employees.length) return 'Không tìm thấy nhân viên nào.';
    return employees.map(e => `• ${e.user?.fullName || 'N/A'} (${e.employeeCode || 'N/A'}) - ${e.position} - Email: ${e.user?.email || 'N/A'}, SĐT: ${e.phone || 'N/A'}`).join('\n');
  },
  listOrders: async ({ status }) => {
    const where = {};
    if (status) where.status = status;
    const orders = await prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10, include: { customer: { select: { name: true } } } });
    if (!orders.length) return 'Không có đơn hàng nào.';
    return orders.map(o => `• ${o.orderCode} - ${o.status} - ${Number(o.total).toLocaleString()}đ - KH: ${o.customer?.name || 'N/A'} (${o.createdAt.toISOString().slice(0, 10)})`).join('\n');
  },
  getOrderDetail: async ({ orderCode }) => {
    const c = orderCode || '';
    const order = await prisma.order.findFirst({ where: { orderCode: c }, include: { customer: { select: { name: true, phone: true } }, items: { include: { product: { select: { name: true, sku: true } } } } } });
    if (!order) return 'Không tìm thấy đơn hàng.';
    return `Đơn ${order.orderCode} - ${order.status}\nKH: ${order.customer?.name || 'N/A'} - SĐT: ${order.customer?.phone || 'N/A'}\nTổng: ${Number(order.total).toLocaleString()}đ\nSản phẩm:\n${order.items.map(i => `  • ${i.product?.name} (${i.product?.sku}) x${i.quantity} = ${Number(i.price).toLocaleString()}đ`).join('\n')}`;
  },
  customerLookup: async ({ query }) => {
    const q = query || '';
    const customers = await prisma.customer.findMany({ where: { isActive: true, OR: [{ name: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }] }, take: 10, orderBy: { totalSpent: 'desc' } });
    if (!customers.length) return 'Không tìm thấy khách hàng nào.';
    return customers.map(c => `• ${c.name} - SĐT: ${c.phone || 'N/A'} - Email: ${c.email || 'N/A'} - Đã mua: ${Number(c.totalSpent).toLocaleString()}đ - Còn nợ: ${Number(c.totalDebt || 0).toLocaleString()}đ`).join('\n');
  },
  viewDashboard: async () => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const [orderCount, revenueAgg, customerCount] = await Promise.all([
      prisma.order.count({ where: { createdAt: { gte: today } } }),
      prisma.order.aggregate({ where: { createdAt: { gte: today } }, _sum: { total: true } }),
      prisma.customer.count({ where: { isActive: true } }),
    ]);
    return `📊 Tổng quan hôm nay:\n• Đơn hàng: ${orderCount}\n• Doanh thu: ${Number(revenueAgg._sum.total || 0).toLocaleString()}đ\n• Tổng khách hàng: ${customerCount}`;
  },
  getRevenue: async ({ period }) => {
    const now = new Date(); let start, label;
    if (period === 'today') { start = new Date(now.getFullYear(), now.getMonth(), now.getDate()); label = 'hôm nay'; }
    else if (period === 'last_month') { start = new Date(now.getFullYear(), now.getMonth() - 1, 1); label = 'tháng trước'; }
    else { start = new Date(now.getFullYear(), now.getMonth(), 1); label = 'tháng này'; }
    const agg = await prisma.order.aggregate({ where: { createdAt: { gte: start }, status: { not: 'CANCELLED' } }, _sum: { total: true }, _count: { id: true } });

    const total = Number(agg._sum.total || 0);
    const orderCount = agg._count.id;

    // Kỳ không có đơn nào: nói rõ kỳ + chỉ ra kỳ gần nhất CÓ dữ liệu để
    // người dùng không tưởng hệ thống bị lỗi (0đ rất dễ gây hiểu nhầm).
    if (orderCount === 0) {
      const latest = await prisma.order.findFirst({
        where: { status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const lines = [
        `💰 Doanh thu ${label}:`,
        '• Tổng: 0đ',
        '• Số đơn: 0',
        `• Chưa có đơn nào trong kỳ này (${start.toLocaleDateString('vi-VN')} → nay).`,
      ];
      if (latest) {
        lines.push(`• Đơn gần nhất: ${new Date(latest.createdAt).toLocaleDateString('vi-VN')}. Hãy thử "doanh thu tháng trước" hoặc "doanh thu năm nay".`);
      }
      return lines.join('\n');
    }

    return `💰 Doanh thu ${label}:\n• Tổng: ${total.toLocaleString('vi-VN')}đ\n• Số đơn: ${orderCount}\n• Trung bình: ${Math.round(total / orderCount).toLocaleString('vi-VN')}đ/đơn`;
  },

  // ─── CRM/SRM fast-path (đặc tả §3.3: 15 intents) — wrap db-agent HANDLERS ───
  queryChurnAlerts: async (params = {}) => {
    const r = await HANDLERS.search_churn_alerts(params);
    return r.message || r.summary;
  },
  queryRfmSegments: async (params = {}) => {
    const r = await HANDLERS.search_customer_rfm(params);
    return r.message || r.summary;
  },
  queryLeads: async (params = {}) => {
    const r = await HANDLERS.search_leads(params);
    return r.message || r.summary;
  },
  queryGrn: async (params = {}) => {
    const r = await HANDLERS.search_grn(params);
    return r.message || r.summary;
  },
  queryPurchaseInvoices: async (params = {}) => {
    const r = await HANDLERS.search_purchase_invoices(params);
    return r.message || r.summary;
  },

  // ════════════════ WRITE TOOL HANDLERS ════════════════

  createOrder: async ({ customerName, productName, quantity }, userId, sessionId) => {
    const result = await HANDLERS.create_order({
      customerName: customerName || '',
      productName: productName || '',
      quantity: parseInt(quantity) || 1,
    }, userId);
    return result.summary || result.message || 'Đã tạo đơn hàng';
  },

  createPO: async ({ vendorName, productName, quantity, unitCost }, userId, sessionId) => {
    const result = await HANDLERS.create_po({
      vendorName: vendorName || '',
      productName: productName || '',
      quantity: parseInt(quantity) || 1,
      unitCost: parseFloat(unitCost) || 0,
    }, userId);
    return result.summary || result.message || 'Đã tạo đơn nhập hàng';
  },

  sendReminder: async ({ customerName }, userId, sessionId) => {
    const result = await HANDLERS.send_reminder({
      customerName: customerName || '',
    }, userId, sessionId);
    return result.summary || result.message || 'Đã gửi nhắc nợ';
  },
};

/**
 * Bóc tham số tạo PO từ câu lệnh tự nhiên.
 *
 * Bối cảnh (bug): regex cũ chỉ nhận đơn vị "đ|vnđ|vnd|k|tr", thiếu "triệu".
 * Với câu "tạo PO giá 5 triệu", số "5" bị bóc ra làm số lượng, còn chuỗi
 * "giá triệu" thành tên sản phẩm → báo lỗi "Không tìm thấy sản phẩm giá triệu".
 *
 * Cách sửa: dùng parseAmount() (utils/vietnameseAmount) để nhận diện đủ
 * đơn vị tiền tệ VN, bóc số tiền TRƯỚC rồi mới dựng tên sản phẩm.
 *
 * @param {string} msg
 * @returns {{vendorName: string, productName: string, quantity: string|number, unitCost: number}}
 */
const QTY_PATTERN = /(\d+)\s*(cái|chiếc|hộp|chai|lon|bóc|thùng|túi|kg|gam|gram|sp|sản phẩm)\b/i;

const extractPO = (msg) => {
  const text = String(msg || '');
  const vendor = text.match(/(từ|ncc|nhà cung cấp)\s+(.+?)(?:\s+\d+\s|$)/i);

  // Số lượng phải CÓ đơn vị đếm — nếu không, "5 triệu" sẽ bị đọc thành qty=5.
  const qtyMatch = text.match(QTY_PATTERN);
  const amount = parseAmount(text);

  // Xoá MỆNH ĐỀ TIỀN theo đúng span đã bóc ("5 triệu") trước khi dựng tên SP —
  // nếu xoá số trước thì mệnh đề vỡ thành "triệu" rơi lại vào tên sản phẩm.
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let rest = text;
  if (amount && amount.matched) {
    rest = rest.replace(new RegExp(escapeRe(amount.matched), 'gi'), ' ');
  }
  if (qtyMatch) {
    rest = rest.replace(new RegExp(escapeRe(qtyMatch[0]), 'gi'), ' ');
  }

  const product = rest
    .replace(/tạo đơn nhập|tạo po|đặt hàng nhập|nhập thêm|cho|từ|ncc|nhà cung cấp/gi, '')
    // Bỏ từ bám theo mệnh đề tiền còn sót ("giá" trong "… giá 5 triệu")
    .replace(/(giá trị|tổng tiền|thành tiền|giá bán|giá|tiền)/gi, '')
    // Người dùng có thể gõ "tạo PO giá triệu" (quên con số) — đơn vị tiền tệ
    // đứng lẻ không phải tên sản phẩm, phải dọn để create_po báo thiếu thông tin
    .replace(/(?<![\p{L}\p{N}])(nghìn|nghin|ngàn|triệu|trieu|ngàn|ng|đồng|tỷ|ty|tr|k)(?![\p{L}\p{N}])/giu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—,.:;]+|[\s\-–—,.:;]+$/g, '')
    .trim();

  return {
    vendorName: vendor ? vendor[2].trim() : '',
    productName: product,
    quantity: qtyMatch ? qtyMatch[1] : 1,
    unitCost: amount ? amount.value : 0,
  };
};

const INTENTS = [
  // Write intents MUST come first — they conflict with read patterns (y hệt db-agent INTENT_MAP)
  { keywords: ['tạo đơn hàng', 'tạo order', 'đặt hàng', 'bán cho'], tool: 'createOrder', isWrite: true,
    extract: (msg) => {
      const customer = msg.match(/(cho|khách)\s+(.+?)(?:\s+\d+\s|$)/i);
      const qtyMatch = msg.match(/(\d+)\s*(cái|chiếc|hộp|kg|sản phẩm|sp)?/i);
      const product = msg.replace(/tạo đơn hàng|tạo order|đặt hàng|bán cho|cho|khách|nhập|thêm/gi, '').replace(/\d+\s*(cái|chiếc|hộp|kg|sp)?/gi, '').trim();
      return {
        customerName: customer ? customer[2].trim() : '',
        productName: product,
        quantity: qtyMatch ? qtyMatch[1] : 1,
      };
    }
  },
  { keywords: ['tạo đơn nhập', 'tạo po', 'đặt hàng nhập', 'nhập thêm', 'tạo purchase order'], tool: 'createPO', isWrite: true,
    extract: extractPO },
  { keywords: ['nhắc nợ', 'gửi nhắc', 'nhắc khách', 'đòi nợ', 'remind'], tool: 'sendReminder', isWrite: true,
    extract: (msg) => {
      const customer = msg.match(/(nhắc|khách|cho)\s+(.+?)(?:\s|$)/i);
      return { customerName: customer ? customer[2].trim() : msg.replace(/nhắc nợ|gửi nhắc|nhắc khách|đòi nợ|remind/gi, '').trim() };
    }
  },

  // CRM/SRM intents — 5 intents mới (đặc tả §3.3: tổng 15 intents)
  { keywords: ['churn', 'khách sắp mất', 'khách có nguy cơ', 'giữ chân'], tool: 'queryChurnAlerts',
    extract: (msg) => {
      const m = msg.toLowerCase().match(/triggered|retained|lost|pending/);
      return { status: m ? m[0].toUpperCase() : undefined };
    }},
  { keywords: ['rfm', 'clv', 'phân khúc khách', 'giá trị vòng đời'], tool: 'queryRfmSegments',
    extract: (msg) => {
      const map = { champions: 'Champions', loyal: 'Loyal', potential: 'Potential', 'at-risk': 'At-Risk', hibernating: 'Hibernating' };
      const m = msg.toLowerCase().match(/champions|loyal|potential|at-risk|hibernating/);
      return { segment: m ? map[m[0]] : undefined };
    }},
  { keywords: ['lead', 'khách tiềm năng', 'nguồn khách'], tool: 'queryLeads',
    extract: (msg) => {
      const m = msg.toLowerCase().match(/contacted|qualified|dead|new/);
      return { leadStatus: m ? m[0].toUpperCase() : undefined };
    }},
  { keywords: ['phiếu nhập kho', 'grn', 'nhận hàng po', 'kiểm hàng'], tool: 'queryGrn',
    extract: (msg) => {
      if (/posted|đã ghi/i.test(msg)) return { status: 'POSTED' };
      if (/\bqc\b|xong|hoàn tất kiểm/i.test(msg)) return { status: 'QC_DONE' };
      return {};
    }},
  { keywords: ['hóa đơn mua', 'đối soát hóa đơn', '3-way', 'purchase invoice'], tool: 'queryPurchaseInvoices',
    extract: (msg) => {
      if (/variance|lệch|vượt dung sai/i.test(msg)) return { matchStatus: 'VARIANCE_HOLD' };
      if (/matched|khớp|đã đối soát/i.test(msg)) return { matchStatus: 'MATCHED' };
      if (/pending|chờ/i.test(msg)) return { matchStatus: 'PENDING' };
      return {};
    }},

  { keywords: ['tồn kho', 'hàng tồn', 'còn hàng', 'sản phẩm', 'inventory'], tool: 'queryInventory', extract: (msg) => ({ query: msg.replace(/tồn kho|sản phẩm|hàng tồn|còn hàng|còn không|có.*không/gi, '').trim() || msg.trim() }) },
  { keywords: ['nhân sự', 'nhân viên', 'employee', 'hr'], tool: 'getEmployeeInfo', extract: (msg) => ({ employeeName: msg.replace(/nhân sự|nhân viên|thông tin|tra cứu/gi, '').trim() || msg.trim() }) },
  { keywords: ['đơn hàng', 'order', 'danh sách đơn'], tool: 'listOrders', extract: (msg) => {
    const s = msg.match(/(pending|confirmed|shipping|completed|cancelled)/i);
    return { status: s ? s[1].toUpperCase() : undefined };
  }},
  { keywords: ['chi tiết đơn', 'xem đơn', 'mã đơn', 'order detail', 'ord-'], tool: 'getOrderDetail', extract: (msg) => {
    const c = msg.match(/(ORD-\d{8}-\d{4})/i);
    return { orderCode: c ? c[1].toUpperCase() : msg.trim() };
  }},
  { keywords: ['khách hàng', 'customer'], tool: 'customerLookup', extract: (msg) => ({ query: msg.replace(/khách hàng|thông tin|tra cứu/gi, '').trim() || msg.trim() }) },
  { keywords: ['dashboard', 'tổng quan', 'tình hình kinh doanh', 'business'], tool: 'viewDashboard', extract: () => ({}) },
  { keywords: ['doanh thu', 'revenue'], tool: 'getRevenue', extract: (msg) => {
    if (/hôm nay|today/i.test(msg)) return { period: 'today' };
    if (/tháng trước|last month/i.test(msg)) return { period: 'last_month' };
    return { period: 'this_month' };
  }},
];

function detectIntent(text) {
  const lower = text.toLowerCase();
  for (const intent of INTENTS) {
    if (intent.keywords.some(k => lower.includes(k))) {
      return { tool: intent.tool, params: intent.extract(text), isWrite: intent.isWrite || false };
    }
  }
  return null;
}

router.post('/chat', async (req, res, next) => {
  try {
    const { messages } = req.body;
    if (!messages || messages.length === 0) {
      throw { status: 400, message: 'messages is required' };
    }

    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    if (!lastUserMsg) return res.json({ success: true, data: { response: 'Bạn muốn hỏi gì?' } });

    const userMsg = lastUserMsg.content || '';
    const intent = detectIntent(userMsg);
    logger.info('[Agent Chat] Intent:', intent?.tool, 'Msg:', logger.truncateLog(userMsg));

    // Tạo session
    const session = await prisma.agentSession.create({
      data: {
        userId: req.user.id,
        userMessage: userMsg,
        intent: intent?.tool || null,
        status: 'RUNNING',
        triggerSource: 'USER_CHAT',
      },
    });

    const startTime = Date.now();
    // type là enum AgentStepType (LLM_CALL | TOOL_CALL | HUMAN_GATE | RENDER_UI).
    // Giá trị mặc định 'FAST_PATH' không tồn tại trong enum → PrismaClientValidationError → 500.
    let reply, stepType = 'TOOL_CALL', toolName = null;

    if (intent && TOOL_HANDLERS[intent.tool]) {
      toolName = intent.tool;

      if (intent.isWrite) {
        // Write operations: require ADMIN or MANAGER role
        if (!['ADMIN', 'MANAGER'].includes(req.user.role)) {
          reply = 'Xin lỗi, bạn không có quyền thực hiện thao tác này. Chỉ ADMIN và MANAGER mới có thể tạo đơn hàng, nhập hàng, hoặc gửi nhắc nợ.';
          stepType = 'TOOL_CALL';
        } else {
          reply = await TOOL_HANDLERS[intent.tool](intent.params, req.user.id, session.id);
          stepType = 'TOOL_CALL';

          const audited = await recordWriteAudit(session.id, toolName, intent.params, req.user.id);
          if (!audited) {
            reply += '\n\n⚠️ Thao tác đã thực hiện nhưng KHÔNG ghi được bản ghi kiểm toán — vui lòng báo quản trị viên.';
          }
        }
      } else if (SENSITIVE_TOOLS.has(intent.tool) && !isSensitiveAllowed(req.user.role)) {
        // M3: role thấp hỏi tool nhạy cảm → tạo request chờ phê duyệt
        stepType = 'TOOL_CALL';
        try {
          const gate = await createDataRequest(session.id, intent.tool, intent.params, req.user);
          await notifyGateCreated(gate);
          reply = DATA_REQUEST_REPLY;
        } catch (gateErr) {
          logger.error(`[Agent Gate] Không tạo được DATA_REQUEST cho ${intent.tool}: ${gateErr.message}`);
          reply = DATA_REQUEST_FAILED_REPLY;
        }
      } else {
        reply = await TOOL_HANDLERS[intent.tool](intent.params);
        reply = `📋 **${intent.tool}**\n\n${reply}`;
      }
    } else {
      try {
        const dbResult = await processQuery(userMsg);
        if (dbResult.success && dbResult.data?.length > 0) {
          if (SENSITIVE_DB_TOOLS.has(dbResult.tool) && !isSensitiveAllowed(req.user.role)) {
            // M3: fallback tool nhạy cảm → request chờ phê duyệt
            stepType = 'TOOL_CALL';
            try {
              const gate = await createDataRequest(session.id, dbResult.tool, dbResult.params, req.user);
              await notifyGateCreated(gate);
              reply = DATA_REQUEST_REPLY;
            } catch (gateErr) {
              logger.error(`[Agent Gate] Không tạo được DATA_REQUEST cho ${dbResult.tool}: ${gateErr.message}`);
              reply = DATA_REQUEST_FAILED_REPLY;
            }
          } else {
            // KHÔNG phải LLM_CALL. `generateResponse` chỉ nối chuỗi summary+message
            // từ kết quả processQuery (xem db-agent.service.js:989-997) — không có
            // lời gọi mô hình nào. Trước đây gắn nhãn LLM_CALL và path gợi ý đây là
            // nhánh LLM, khiến số liệu thống kê agent trên UI phản ánh sai mức dùng LLM thật.
            // Nhãn đúng cho nhánh này là TOOL_CALL (đã chạy truy vấn), path là keyword.
            stepType = 'TOOL_CALL';
            reply = await generateResponse(userMsg, dbResult);
          }
        } else {
          reply = 'Xin chào! Tôi có thể giúp bạn:\n' +
            '• 📦 Tra cứu tồn kho (vd: "tồn kho sáp treo")\n' +
            '• 📋 Xem đơn hàng (vd: "đơn hàng hôm nay")\n' +
            '• 👤 Tra cứu khách hàng (vd: "khách hàng Nguyễn Văn A")\n' +
            '• 📊 Dashboard (vd: "tình hình kinh doanh")\n' +
            '• 💰 Doanh thu (vd: "doanh thu tháng này")\n' +
            '• 👥 Nhân sự (vd: "thông tin nhân sự")\n' +
            '• 🏭 Sản xuất (vd: "lệnh sản xuất tháng này")\n' +
            '• 💳 Công nợ (vd: "công nợ khách hàng")\n' +
            '• 📄 Đơn nhập hàng (vd: "PO chờ duyệt")\n' +
            '• 📊 Báo cáo tài chính (vd: "chi phí tháng này")';
        }
      } catch {
        reply = 'Xin chào! Tôi có thể giúp bạn tra cứu dữ liệu database. Hãy đặt câu hỏi về sản phẩm, đơn hàng, khách hàng, doanh thu...';
      }
    }

    const durationMs = Date.now() - startTime;

    // Lưu step
    await prisma.agentStep.create({
      data: {
        sessionId: session.id,
        sequence: 1,
        type: stepType,
        toolName,
        toolOutput: { response: reply },
        status: 'COMPLETED',
        durationMs,
        path: intent?.tool ? 'fast_path' : 'fallback_keyword',
      },
    });

    // Cập nhật session
    await prisma.agentSession.update({
      where: { id: session.id },
      data: {
        status: 'COMPLETED',
        finalResult: { response: reply },
        endedAt: new Date(),
      },
    });

    res.json({ success: true, data: { response: reply } });
  } catch (e) {
    next(e);
  }
});

// ─── Sessions ───
router.get('/sessions', async (req, res, next) => {
  try {
    const sessions = await prisma.agentSession.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' }, take: 20,
      include: { steps: { orderBy: { sequence: 'asc' }, take: 5 }, feedback: true },
    });
    res.json({ success: true, data: sessions });
  } catch (e) {
    next(e);
  }
});

// ─── Feedback ───
router.post('/feedback', async (req, res, next) => {
  try {
    const { sessionId, rating, comment } = req.body;
    if (!sessionId || rating === undefined) {
      throw { status: 400, message: 'sessionId and rating are required' };
    }
    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
      select: { userMessage: true, finalResult: true },
    });
    if (!session) {
      throw { status: 404, message: 'Session not found' };
    }
    const feedback = await prisma.agentFeedback.create({
      data: {
        sessionId,
        userId: req.user.id,
        rating,
        comment,
        query: session.userMessage,
        response: session.finalResult ? JSON.stringify(session.finalResult) : '',
      },
    });
    res.json({ success: true, data: feedback });
  } catch (e) {
    next(e);
  }
});

// ─── Analytics (HERMES Phase 6: + gate SLA, approve/reject, token/user) ───
router.get('/analytics', async (req, res, next) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [totalSessions, avgLatencyAgg, feedback, gates, tokens] = await Promise.all([
      prisma.agentSession.count({ where: { createdAt: { gte: startOfToday } } }),
      prisma.agentStep.aggregate({
        where: { session: { createdAt: { gte: startOfToday } }, durationMs: { not: null } },
        _avg: { durationMs: true },
      }),
      prisma.agentFeedback.groupBy({
        by: ['rating'],
        _count: { rating: true },
        where: { session: { createdAt: { gte: startOfToday } } },
      }),
      prisma.agentHumanGate.groupBy({
        by: ['status'],
        _count: { status: true },
        where: { createdAt: { gte: startOfToday } },
      }).catch(() => []),
      prisma.llmUsageLog.aggregate({
        where: { createdAt: { gte: startOfToday } },
        _sum: { totalTokens: true, promptTokens: true, completionTokens: true },
        _count: { id: true },
      }).catch(() => ({ _sum: {}, _count: {} })),
    ]);

    // Gate SLA: thời gian duyệt trung bình (decidedAt - createdAt) của gate hôm nay.
    let gateSlaMs = null;
    try {
      const decided = await prisma.agentHumanGate.findMany({
        where: { createdAt: { gte: startOfToday }, decidedAt: { not: null } },
        select: { createdAt: true, decidedAt: true },
        take: 200,
      });
      if (decided.length) {
        gateSlaMs = Math.round(decided.reduce((s, g) => s + (new Date(g.decidedAt) - new Date(g.createdAt)), 0) / decided.length);
      }
    } catch { /* giữ null */ }

    res.json({
      success: true,
      data: {
        totalSessions,
        avgLatency: avgLatencyAgg._avg.durationMs || 0,
        feedback: feedback.map(f => ({ rating: f.rating, _count: f._count.rating })),
        gates: gates.map((g) => ({ status: g.status, count: g._count.status })),
        gateSlaMs,
        tokens: {
          calls: tokens._count?.id || 0,
          total: tokens._sum?.totalTokens || 0,
          prompt: tokens._sum?.promptTokens || 0,
          completion: tokens._sum?.completionTokens || 0,
        },
      },
    });
  } catch (e) {
    next(e);
  }
});

// ─── Human Gates ───
// M2: chỉ ADMIN/MANAGER mới xem + phê duyệt yêu cầu (write + DATA_REQUEST)

router.get('/human-gates', authorize('ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const gates = await prisma.agentHumanGate.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      include: { session: { select: { userMessage: true, userId: true } } },
      take: 50,
    });
    res.json({ success: true, data: gates });
  } catch (e) {
    next(e);
  }
});

/**
 * @swagger
 * /api/agent/human-gates/by-status:
 *   get:
 *     summary: Liệt kê human-gate theo trạng thái (chỉ đọc)
 *     description: >
 *       CHỈ ĐỌC. `GET /human-gates` cố tình chỉ trả PENDING, nên trạng thái "lơ lửng"
 *       (APPROVED nhưng `resultRef` IS NULL ⇒ đã duyệt mà PO chưa tạo được) không đọc
 *       được qua API. Route này là đường đọc cho trạng thái đó. Không có tác dụng phụ:
 *       không ghi, không đổi trạng thái. Cách ly tenant do Prisma extension
 *       (`AgentHumanGate` nằm trong `TENANT_SCOPED_MODELS`).
 *     tags: [Agent]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         required: false
 *         schema: { type: string, enum: [PENDING, APPROVED, REJECTED, EXPIRED, CANCELLED] }
 *       - in: query
 *         name: pendingResult
 *         required: false
 *         description: "1 = chỉ gate PO_PROPOSAL đã duyệt mà chưa có resultRef (trạng thái lơ lửng)"
 *         schema: { type: string, enum: ["0", "1"] }
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, default: 50, maximum: 200 }
 *     responses:
 *       200: { description: Danh sách gate }
 *       400: { description: status/pendingResult không hợp lệ }
 */
router.get('/human-gates/by-status', authorize('ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const ALLOWED = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'];
    const { status, pendingResult, limit } = req.query;

    // Whitelist thay vì nội suy vào `where` — không nhét chuỗi tùy ý của người gọi
    // vào truy vấn, và status sai thì báo 400 chứ không âm thầm trả rỗng.
    if (status && !ALLOWED.includes(String(status))) {
      throw { status: 400, message: `status phải là: ${ALLOWED.join(', ')}` };
    }
    const onlyPendingResult = String(pendingResult || '') === '1';
    if (pendingResult !== undefined && !['0', '1'].includes(String(pendingResult))) {
      throw { status: 400, message: 'pendingResult phải là 0 hoặc 1' };
    }
    const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    // Ba điều kiện phải khớp CÙNG LÚC (00b §4.2): resultRef null một mình không đủ,
    // vì mọi gate DATA_REQUEST cũng có resultRef null.
    const where = {
      ...(status ? { status } : {}),
      ...(onlyPendingResult ? { actionType: PO_PROPOSAL, resultRef: null } : {}),
    };

    const gates = await prisma.agentHumanGate.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { session: { select: { userMessage: true, userId: true } } },
      take,
    });

    res.json({
      success: true,
      data: gates,
      meta: { count: gates.length, status: status || null, pendingResult: onlyPendingResult },
    });
  } catch (e) {
    next(e);
  }
});

router.post('/human-gates/:id/decide', authorize('ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { decision, note, acknowledgeDrift } = req.body;

    if (!['APPROVED', 'REJECTED'].includes(decision)) {
      throw { status: 400, message: 'decision must be APPROVED or REJECTED' };
    }
    // Từ chối mà không ghi lý do thì người sau không biết vì sao phải sửa.
    if (decision === 'REJECTED' && !String(note || '').trim()) {
      throw { status: 400, message: 'Từ chối đề xuất cần nhập lý do' };
    }

    const gate = await prisma.agentHumanGate.findFirst({
      where: { id },
      include: { session: { select: { userId: true, triggerSource: true } } },
    });
    if (!gate) throw { status: 404, message: 'Human gate not found' };
    if (gate.status !== 'PENDING') throw { status: 400, message: `Gate is already ${gate.status}` };
    if (new Date(gate.expiresAt) < new Date()) throw { status: 400, message: 'Gate has expired' };

    // ĐẢO TRẠNG THÁI BẰNG updateMany CÓ ĐIỀU KIỆN, không dùng update().
    // `update()` đọc-rồi-ghi nên hai request song song đều thấy PENDING và cùng
    // ghi được ⇒ bấm duyệt hai lần tạo hai PO. `updateMany` khoá dòng, chỉ một
    // bên nhận count=1, bên kia nhận count=0 ⇒ 409 (00b §10 test #3).
    const claimed = await prisma.agentHumanGate.updateMany({
      where: { id, status: 'PENDING' },
      data: buildDecisionData({ decision, note, userId: req.user.id }),
    });
    if (claimed.count !== 1) {
      throw { status: 409, message: 'Gate đã được xử lý bởi người khác' };
    }

    const updated = await prisma.agentHumanGate.findFirst({ where: { id } });

    // ── HERMES Phase 5: cấm self-approval với spend gate ───────────────────
    // PO là chi tiền: người tạo đề xuất không được tự duyệt (cần người thứ hai).
    // Gate đọc (DATA_REQUEST) vẫn cho self-approval (chỉ xem, không mất tiền).
    // SME 1 chủ shop: ADMIN khác hoặc MANAGER duyệt — audit bắt buộc ghi lại.
    const selfApproved =
      gate.session?.triggerSource === 'USER_CHAT' &&
      gate.session?.userId === req.user.id;
    if (decision === 'APPROVED' && gate.actionType === PO_PROPOSAL && selfApproved) {
      throw { status: 409, message: 'Không được tự duyệt đề xuất chi tiền do chính mình tạo (cần người thứ hai)' };
    }

    let po = null;
    if (decision === 'APPROVED') {
      if (gate.actionType === PO_PROPOSAL) {
        // ĐÂY LÀ NHÁNH CÓ HIỆU LỰC ĐẦU TIÊN TRONG HỆ THỐNG: chỉ sau khi gate
        // được duyệt thì PO mới tồn tại. Re-validation tính lại từ DB (ATP/ROP/đơn
        // giá); lệch quá ngưỡng ⇒ 409 kèm diff, người duyệt phải xác nhận có chủ đích.
        const result = await executeGate(id, req.user.id, { acknowledgeDrift: Boolean(acknowledgeDrift) });
        po = result.po;
      }
      // Gate đã lưu quyết định thành công → không được fail response. Nhưng nếu không đánh
      // dấu được session COMPLETED thì phiên chat kẹt PENDING vĩnh viễn → PHẢI log có id để trace.
      try {
        await prisma.agentSession.update({
          where: { id: gate.sessionId },
          data: {
            status: 'COMPLETED',
            finalResult: {
              approved: true,
              actionType: gate.actionType,
              payload: gate.actionPayload,
              selfApproved,
              ...(po ? { poId: po.id, poCode: po.poCode } : {}),
            },
          },
        });
      } catch (e) {
        logger.error(
          `[Agent Gate] Gate ${id} đã APPROVED nhưng không đóng được AgentSession ${gate.sessionId}: ${e.message}`,
        );
      }
    }

    // HERMES Phase 5: mọi decide gate ghi AuditLog + điền agentSessionId
    // (trước đây AuditLog bỏ trống 2 field này nên không trace được phiên nào duyệt gate nào).
    try {
      const step = await prisma.agentStep.findFirst({
        where: { sessionId: gate.sessionId },
        orderBy: { sequence: 'desc' },
        select: { id: true },
      });
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: decision === 'APPROVED' ? 'APPROVE_HUMAN_GATE' : 'REJECT_HUMAN_GATE',
          entity: 'AgentHumanGate',
          entityId: id,
          afterJson: { decision, note: note || null, selfApproved, poId: po?.id || null },
          agentSessionId: gate.sessionId,
          agentStepId: step?.id || null,
          meta: { channel: 'API', actionType: gate.actionType },
        },
      });
    } catch (auditErr) {
      logger.error(`[Agent Gate] MẤT audit decide gate ${id}: ${auditErr.message}`);
    }
    // HERMES: báo cho người đề xuất biết gate đã được xử lý (in-app notification).
    try {
      if (gate.session?.userId && gate.session.userId !== req.user.id) {
        await prisma.notification.create({
          data: {
            type: gate.actionType === PO_PROPOSAL ? 'PO_PENDING_APPROVAL' : 'SYSTEM',
            // NotificationSeverity enum: INFO|WARNING|CRITICAL (SUCCESS không tồn tại).
            severity: decision === 'APPROVED' ? 'INFO' : 'WARNING',
            title: decision === 'APPROVED' ? 'Đề xuất đã được duyệt' : 'Đề xuất bị từ chối',
            message: `${gate.actionSummary} — ${decision === 'APPROVED' ? (po ? `tạo PO ${po.poCode}` : 'đã duyệt') : `lý do: ${note}`}`,
            userId: gate.session.userId,
            meta: { gateId: id, decision },
            humanGateId: id,
            requiresAction: false,
          },
        });
      }
    } catch (notifErr) {
      logger.warn(`[Agent Gate] notification decide bỏ qua: ${notifErr.message}`);
    }

    res.json({
      success: true,
      data: {
        ...updated,
        selfApproved,
        po: po ? { id: po.id, poCode: po.poCode, total: po.total } : null,
      },
      message: decision === 'APPROVED'
        ? (po ? `Đã phê duyệt — tạo PO ${po.poCode}` : 'Đã phê duyệt')
        : 'Đã từ chối',
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Thử lại thực thi cho đề xuất PO đã duyệt nhưng `resultRef` vẫn null.
 *
 * Thao tác CỐ Ý — KHÔNG có cron tự gọi. PO là hành động tài chính nên không được
 * tự retry. Chạy lại đầy đủ re-validation vì dữ liệu đã cũ hơn lần đầu.
 * Điều kiện nhận diện trạng thái lỗi là BA điều kiện CÙNG LÚC
 * (`actionType` + `status` + `resultRef IS NULL`) — không được tính nhầm gate
 * loại khác, xem 00b §4.2.
 */
router.post('/human-gates/:id/retry-execution', authorize('ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { acknowledgeDrift } = req.body || {};
    const { po, linked } = await retryExecution(id, req.user.id, {
      acknowledgeDrift: Boolean(acknowledgeDrift),
    });
    res.json({
      success: true,
      data: { id: po.id, poCode: po.poCode, total: po.total },
      linked,
      message: linked
        ? `PO ${po.poCode} đã được tạo từ đề xuất này — đã liên kết, không tạo mới`
        : `Đã tạo PO ${po.poCode}`,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
// Export phụ để test được parser (INTENTS/extract không nằm trên router).
module.exports.extractPO = extractPO;
module.exports.INTENTS = INTENTS;
module.exports.TOOL_HANDLERS = TOOL_HANDLERS;