/**
 * modules/chatops/nl-schedule.service.js — Đặt lịch báo cáo bằng câu chat (HERMES Phase 6)
 *
 * Cú pháp chat: "gửi P&L 8h sáng T2 cho #ketoan" → bản ghi ReportSchedule mở rộng
 * (channel, telegramChatId, template, nlQuery) → executor cron render (tái dùng
 * reports/dashboard) → gửi Telegram/email + cập nhật lastRunAt/nextRunAt.
 * Số liệu lấy từ query, LLM chỉ viết tóm tắt nhận định (không bịa số).
 */
const logger = require('../../utils/logger');

const TEMPLATES = [
  { template: 'weekly_pnl', keys: ['p&l', 'pnl', 'lãi lỗ', 'kết quả kinh doanh'] },
  { template: 'revenue_daily', keys: ['doanh thu'] },
  { template: 'inventory_low', keys: ['tồn kho', 'sắp hết hàng'] },
  { template: 'debts_overdue', keys: ['công nợ', 'nợ quá hạn'] },
  { template: 'orders_daily', keys: ['đơn hàng', 'đơn hôm nay'] },
];

const DOW_MAP = { cn: 0, t2: 1, t3: 2, t4: 3, t5: 4, t6: 5, t7: 6 };

/** Parse câu chat → { cron, template, channel, telegramChatId }. Thuần, test được. */
const parseScheduleChat = (text) => {
  const t = String(text || '').toLowerCase();
  // Không dùng lookahead `(?!.*\d)`: với "9h sáng t2" chữ số "2" trong "t2" làm
  // lookahead thất bại ⇒ giờ rơi về mặc định 8 và người dùng bị gửi báo cáo SAI GIỜ,
  // không có cảnh báo. Bắt số kèm ranh giới không phải chữ số.
  const hourM = t.match(/(?:^|\D)(\d{1,2})\s*(?:h|giờ)(?:\s|$)/) || t.match(/(?:^|\D)(\d{1,2})\s*(?:h|giờ)/);
  const hour = hourM ? Math.min(Math.max(Number(hourM[1]), 0), 23) : 8;
  let dow = null;
  for (const [k, v] of Object.entries(DOW_MAP)) {
    if (t.includes(k)) { dow = v; break; }
  }
  if (/hằng ngày|mỗi ngày|hang ngay/.test(t)) dow = '*';
  const tpl = TEMPLATES.find((x) => x.keys.some((k) => t.includes(k)));
  const template = tpl ? tpl.template : 'revenue_daily';
  const cron = dow === null || dow === '*' ? `0 ${hour} * * *` : `0 ${hour} * * ${dow}`;
  const chanM = t.match(/#(\S+)/);
  const telegramChatId = chanM ? chanM[1] : null;
  const channel = /telegram/.test(t) || telegramChatId ? (t.includes('email') ? 'BOTH' : 'TELEGRAM') : 'EMAIL';
  return { cron, template, channel, telegramChatId };
};

/** Tính nextRunAt từ cron 5-field (hỗ trợ phút/giờ/ngày/tháng/thứ, *, số, step). */
const nextRunAfter = (cron, from = new Date()) => {
  const parts = String(cron).trim().split(/\s+/);
  if (parts.length !== 5) return new Date(from.getTime() + 86400000);
  const [mi, hh, dd, mo, dw] = parts;
  const match = (expr, val) => {
    if (expr === '*') return true;
    if (expr.includes('/')) {
      const [base, step] = expr.split('/');
      const s = Number(step);
      if (!s) return false;
      if (base === '*') return val % s === 0;
      return false;
    }
    return expr.split(',').some((p) => {
      if (p.includes('-')) {
        const [a, b] = p.split('-').map(Number);
        return val >= a && val <= b;
      }
      return Number(p) === val;
    });
  };
  const cand = new Date(from.getTime() + 60000);
  cand.setSeconds(0, 0);
  for (let i = 0; i < 525600; i += 1) { // tối đa ~1 năm theo phút
    if (
      match(mi, cand.getMinutes()) && match(hh, cand.getHours()) &&
      match(dd, cand.getDate()) && match(mo, cand.getMonth() + 1) &&
      (dw === '*' || match(dw, cand.getDay()))
    ) return cand;
    cand.setTime(cand.getTime() + 60000);
  }
  return new Date(from.getTime() + 86400000);
};

/** Tạo lịch từ câu chat (cần reportId của SavedReport mẫu hoặc tạo mới). */
const createFromChat = async ({ text, user, reportId = null } = {}) => {
  const prisma = require('../../config/prisma');
  if (!text) throw { status: 400, message: 'Thiếu câu chat đặt lịch' };
  const parsed = parseScheduleChat(text);

  // CHỐNG RÒ DỮ LIỆU: `telegramChatId` do người dùng gõ trong chat (#ketoan...).
  // Nếu lấy đại trà thì bất kỳ user nào cũng ghim báo cáo doanh thu/công nợ của
  // tenant vào một chat Telegram bất kỳ — tức gửi số liệu tài chính ra ngoài.
  // Chỉ chấp nhận chat đã BIND của chính người đặt lịch (xem ChatBinding).
  if (parsed.telegramChatId) {
    const mine = await prisma.chatBinding.findFirst({
      where: { tenantId: user.tenantId, userId: user.id, provider: 'TELEGRAM', isActive: true },
      select: { chatId: true, externalUserId: true },
    }).catch(() => null);
    const allowed = [mine?.chatId, mine?.externalUserId].filter(Boolean);
    if (!allowed.includes(parsed.telegramChatId)) {
      throw { status: 403, message: 'chatId phải là chat Telegram đã buộc với chính bạn' };
    }
  }

  let rid = reportId;
  if (!rid) {
    const existing = await prisma.savedReport.findFirst({ where: { name: `Hermes: ${parsed.template}` } }).catch(() => null);
    if (existing) rid = existing.id;
    else {
      const created = await prisma.savedReport.create({
        data: { name: `Hermes: ${parsed.template}`, description: `Tự tạo từ chat: ${text}`.slice(0, 500), config: { template: parsed.template }, isPublic: false, createdById: user.id },
      });
      rid = created.id;
    }
  }
  const { getTenantId } = require('../../config/tenantContext');
  const now = new Date();
  return prisma.reportSchedule.create({
    data: {
      tenantId: getTenantId() || user.tenantId || null,
      reportId: rid, cron: parsed.cron, emailTo: [],
      channel: parsed.channel, telegramChatId: parsed.telegramChatId,
      template: parsed.template, nlQuery: String(text).slice(0, 2000),
      createdById: user.id, isActive: true,
      nextRunAt: nextRunAfter(parsed.cron, now),
    },
  });
};

/** Render số liệu theo template (query DB, không cho LLM bịa số). */
const renderTemplate = async (template) => {
  const prisma = require('../../config/prisma');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(today.getTime() - today.getDay() * 86400000);

  if (template === 'weekly_pnl') {
    // TUẦN chứ không phải hôm nay: trước đây weekly_pnl dùng chung nhánh với
    // revenue_daily (chỉ lấy 1 ngày) ⇒ báo cáo "P&L tuần" gửi số của 1 ngày.
    const [week, day] = await Promise.all([
      prisma.order.aggregate({
        where: { createdAt: { gte: startOfWeek }, status: { not: 'CANCELLED' } },
        _sum: { total: true }, _count: { id: true },
      }),
      prisma.order.aggregate({
        where: { createdAt: { gte: today }, status: { not: 'CANCELLED' } },
        _sum: { total: true }, _count: { id: true },
      }),
    ]);
    return {
      period: 'week',
      total: Number(week._sum.total || 0),
      orders: week._count.id,
      todayTotal: Number(day._sum.total || 0),
      todayOrders: day._count.id,
    };
  }

  if (template === 'revenue_daily') {
    const agg = await prisma.order.aggregate({
      where: { createdAt: { gte: today }, status: { not: 'CANCELLED' } },
      _sum: { total: true }, _count: { id: true },
    });
    return { period: 'day', total: Number(agg._sum.total || 0), orders: agg._count.id };
  }

  if (template === 'inventory_low') {
    // `take:10` rồi lấy `.length` ⇒ lowCount luôn ≤10, tức báo cáo "tồn kho thấp"
    // báo "có 10 mã sắp hết" dù thực tế 47 mã. Đếm riêng bằng _count.
    const [rows, counted] = await Promise.all([
      prisma.inventory.findMany({
        where: { quantity: { lte: 5 } }, take: 10,
        include: { product: { select: { name: true, sku: true } } },
        orderBy: { quantity: 'asc' },
      }),
      prisma.inventory.count({ where: { quantity: { lte: 5 } } }).catch(() => 0),
    ]);
    return {
      lowCount: counted,
      items: rows.map((r) => ({ sku: r.product?.sku, name: r.product?.name, qty: r.quantity })),
    };
  }

  if (template === 'debts_overdue') {
    // QUÁ HẠN = dueDate đã qua và khoản chưa đóng. Trước đây lấy
    // `status PENDING` (giá trị không tồn tại trong DebtStatus: OPEN/PARTIAL/
    // CLOSED/OVERDUE) ⇒ truy vấn luôn hỏng, rơi về `.catch(() => 0)` và báo cáo
    // ra 0 đồng — sai hoàn toàn mà không có dấu hiệu lỗi.
    // `Debt` KHÔNG có cột `remaining`: số dư = amount - paidAmount.
    const now = new Date();
    const rows = await prisma.debt.findMany({
      where: {
        dueDate: { lt: now },
        status: { in: ['OPEN', 'PARTIAL', 'OVERDUE'] },
      },
      select: { amount: true, paidAmount: true },
    }).catch(() => []);
    const total = rows.reduce(
      (s, d) => s + (Number(d.amount || 0) - Number(d.paidAmount || 0)),
      0,
    );
    const count = rows.length;
    return { period: 'overdue', total, count, avg: count ? Math.round(total / count) : 0 };
  }

  const count = await prisma.order.count({ where: { createdAt: { gte: today } } });
  return { period: 'day', orders: count };
};

/** Tóm tắt LLM cho nhận định (số liệu đã có từ query). Lỗi → dùng mẫu. */
const summarize = async (template, figures) => {
  try {
    const policy = require('../../config/llm-policy');
    const r = await policy.callTask('REPORT_SUMMARY', {
      system: 'Viết tóm tắt báo cáo TIẾNG VIỆT, ngắn gọn. CHỈ dùng số liệu được đưa — không bịa thêm số.',
      prompt: `Mẫu: ${template}\nSố liệu: ${JSON.stringify(figures)}\nViết 3-5 dòng nhận định.`,
      maxOutputTokens: 1024,
    });
    if (r && r.ok === true && r.text) return r.text;
  } catch (e) {
    logger.warn(`[nl-schedule] summarize fallback mẫu: ${e.message}`);
  }
  return `Báo cáo ${template}: ${JSON.stringify(figures)} (tạo bằng mẫu — LLM chưa sẵn sàng)`;
};

/**
 * Executor: chạy các lịch đến hạn (gọi từ cron mỗi 5 phút).
 *
 * `tenantId` giới hạn phạm vi: cron truyền `null` (chạy mọi tenant, an toàn vì
 * đây là tiến trình server), còn route thủ công truyền tenant của người gọi —
 * nếu không, một MANAGER tenant A sẽ kích hoạt được lịch của tenant B.
 */
const runDueSchedules = async ({ tenantId = null } = {}) => {
  const prisma = require('../../config/prisma');
  const now = new Date();
  const where = { isActive: true, nextRunAt: { lte: now } };
  if (tenantId) where.tenantId = tenantId;
  const due = await prisma.reportSchedule.findMany({
    where,
    include: { report: { select: { id: true, name: true } } },
    take: 20,
  }).catch(() => []);
  const results = [];
  const { runWithTenant } = require('../../config/tenantContext');
  for (const s of due) {
    try {
      await runWithTenant(s.tenantId, async () => {
        const figures = await renderTemplate(s.template || 'revenue_daily');
        const summary = await summarize(s.template || 'revenue_daily', figures);
        const text = `📊 *${s.report?.name || s.template}*\n${summary}`;
        if ((s.channel === 'TELEGRAM' || s.channel === 'BOTH') && s.telegramChatId) {
          try {
            const tg = require('./telegram.service');
            if (tg.isConfigured()) await tg.sendMessage(s.telegramChatId, text);
          } catch (e) { logger.warn(`[nl-schedule] gửi Telegram bỏ qua: ${e.message}`); }
        }
        if ((s.channel === 'EMAIL' || s.channel === 'BOTH') && s.emailTo?.length) {
          try {
            const email = require('../../utils/email');
            if (email.sendMail) {
              await email.sendMail({ to: s.emailTo, subject: `Báo cáo ${s.report?.name || s.template}`, text: summary });
            }
          } catch (e) { logger.warn(`[nl-schedule] gửi email bỏ qua: ${e.message}`); }
        }
        await prisma.reportSchedule.update({
          where: { id: s.id },
          data: { lastRunAt: now, nextRunAt: nextRunAfter(s.cron, now) },
        });
      });
      results.push({ id: s.id, ok: true });
    } catch (e) {
      logger.error(`[nl-schedule] lịch ${s.id} thất bại: ${e.message}`);
      results.push({ id: s.id, ok: false, error: e.message });
    }
  }
  return results;
};

module.exports = { parseScheduleChat, nextRunAfter, createFromChat, renderTemplate, summarize, runDueSchedules, TEMPLATES };
