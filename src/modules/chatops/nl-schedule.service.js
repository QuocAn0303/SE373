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
  const hourM = t.match(/(\d{1,2})\s*h(?!.*\d)/) || t.match(/(\d{1,2})\s*giờ/);
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
  if (template === 'revenue_daily' || template === 'weekly_pnl') {
    const agg = await prisma.order.aggregate({
      where: { createdAt: { gte: today }, status: { not: 'CANCELLED' } },
      _sum: { total: true }, _count: { id: true },
    });
    return { total: Number(agg._sum.total || 0), orders: agg._count.id };
  }
  if (template === 'inventory_low') {
    const rows = await prisma.inventory.findMany({ where: { quantity: { lte: 5 } }, take: 10, include: { product: { select: { name: true, sku: true } } }, orderBy: { quantity: 'asc' } });
    return { lowCount: rows.length, items: rows.map((r) => ({ sku: r.product?.sku, name: r.product?.name, qty: r.quantity })) };
  }
  if (template === 'debts_overdue') {
    const agg = await prisma.debt.aggregate({ where: { status: { in: ['OVERDUE', 'PENDING'] } }, _sum: { remaining: true }, _count: { id: true } }).catch(() => ({ _sum: {}, _count: {} }));
    return { total: Number(agg._sum?.remaining || 0), count: agg._count?.id || 0 };
  }
  const count = await prisma.order.count({ where: { createdAt: { gte: today } } });
  return { orders: count };
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

/** Executor: chạy các lịch đến hạn (gọi từ cron mỗi 5 phút). */
const runDueSchedules = async () => {
  const prisma = require('../../config/prisma');
  const now = new Date();
  const due = await prisma.reportSchedule.findMany({
    where: { isActive: true, nextRunAt: { lte: now } },
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
