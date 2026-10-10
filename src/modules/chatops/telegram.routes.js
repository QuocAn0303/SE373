/**
 * modules/chatops/telegram.routes.js — Telegram ingress (HERMES Phase 1)
 *
 * - POST /api/chatops/telegram/webhook — nhận update từ Bot API (public,
 *   verify TELEGRAM_WEBHOOK_SECRET, idempotency theo update_id, runWithTenant).
 * - GET /api/chatops/bind — user đã login lấy mã OTP để buộc tài khoản Telegram.
 * - Callback Duyệt/Từ chối trên inline keyboard → decide gate với đúng userId
 *   người bấm (chống double-approve bằng updateMany có điều kiện).
 */
const express = require('express');
const crypto = require('crypto');
const { authenticate, authorize } = require('../../middleware/auth.middleware');
const { requireModule } = require('../../middleware/plan.middleware');
const { runWithTenant } = require('../../config/tenantContext');
const logger = require('../../utils/logger');
const { success, created } = require('../../utils/response');

const router = express.Router();

// Idempotency update_id trong tiến trình (khởi động lại thì ChatBinding.lastUpdateId
// vẫn chặn trùng ở tầng DB). Học từ lead-capture IDEM 24h.
const seenUpdates = new Set();
const MAX_SEEN = 5000;
const markSeen = (id) => {
  if (seenUpdates.has(id)) return false;
  seenUpdates.add(id);
  if (seenUpdates.size > MAX_SEEN) {
    const first = seenUpdates.values().next().value;
    seenUpdates.delete(first);
  }
  return true;
};

const verifyWebhook = (req) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  if (!secret) return true; // dev: chưa cấu hình thì cho qua (log cảnh báo 1 lần)
  const got = req.headers['x-telegram-bot-api-secret-token'] || req.query.secret || '';
  return got === secret;
};

/**
 * @swagger
 * /api/chatops/bind:
 *   get:
 *     summary: Lấy mã OTP để buộc tài khoản Telegram với user ERP
 *     tags: [ChatOps]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: OTP + hướng dẫn nhắn bot }
 */
router.get('/bind', authenticate, requireModule('ai'), async (req, res, next) => {
  try {
    const prisma = require('../../config/prisma');
    const otp = crypto.randomInt(100000, 999999).toString();
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    // ChatBinding cần tenantId trong unique — model mới có thể chưa có trong
    // client cũ → bắt lỗi mềm, hướng dẫn generate.
    if (!prisma.chatBinding) throw { status: 503, message: 'ChatBinding chưa có trong Prisma client — chạy `npx prisma generate` + migrate hermes' };
    await prisma.chatBinding.upsert({
      where: { tenantId_userId_provider: { tenantId: req.user.tenantId, userId: req.user.id, provider: 'TELEGRAM' } },
      create: { tenantId: req.user.tenantId, userId: req.user.id, provider: 'TELEGRAM', externalUserId: `pending:${req.user.id}`, otpCode: otp, otpExpiresAt: expires, isActive: false },
      update: { otpCode: otp, otpExpiresAt: expires },
    });
    const bot = process.env.TELEGRAM_BOT_USERNAME ? `@${process.env.TELEGRAM_BOT_USERNAME}` : 'bot Telegram công ty';
    success(res, { otp, expiresAt: expires, guide: `Nhắn tin cho ${bot} với nội dung: /bind ${otp}` });
  } catch (e) { next(e); }
});

/**
 * @swagger
 * /api/chatops/telegram/webhook:
 *   post:
 *     summary: Webhook nhận update Telegram (public, verify secret)
 *     tags: [ChatOps]
 *     responses:
 *       200: { description: Đã nhận }
 */
router.post('/telegram/webhook', express.json({ limit: '100kb' }), async (req, res, next) => {
  try {
    if (!verifyWebhook(req)) throw { status: 401, message: 'Webhook secret không hợp lệ' };
    const update = req.body || {};
    const updateId = update.update_id != null ? String(update.update_id) : null;
    if (updateId && !markSeen(updateId)) return res.json({ success: true, data: { deduped: true } });

    const prisma = require('../../config/prisma');
    const tg = require('./telegram.service');

    // ── 1. Callback Duyệt/Từ chối ──
    if (update.callback_query) {
      const cb = update.callback_query;
      const fromId = String(cb.from?.id || '');
      const data = String(cb.data || '');
      const m = data.match(/^gate:([A-Za-z0-9-]+):(APPROVED|REJECTED)$/);
      if (!m) {
        await tg.answerCallback(cb.id, 'Nút không hợp lệ').catch(() => null);
        return res.json({ success: true });
      }
      const [, gateId, decision] = m;
      const binding = fromId && prisma.chatBinding
        ? await prisma.chatBinding.findFirst({ where: { provider: 'TELEGRAM', externalUserId: fromId, isActive: true } }).catch(() => null)
        : null;
      if (!binding) {
        await tg.answerCallback(cb.id, 'Bạn chưa buộc tài khoản — mở app lấy OTP rồi /bind', true).catch(() => null);
        return res.json({ success: true });
      }
      const out = await runWithTenant(binding.tenantId, () => decideGateAs(binding.userId, gateId, decision, 'Duyệt/Từ chối từ Telegram'));
      await tg.answerCallback(cb.id, decision === 'APPROVED' ? 'Đã duyệt ✅' : 'Đã từ chối').catch(() => null);
      if (cb.message?.chat?.id) {
        await tg.sendMessage(cb.message.chat.id, out.message).catch((e) => logger.warn(`[chatops] reply callback thất bại: ${e.message}`));
      }
      return res.json({ success: true, data: out });
    }

    // ── 2. Tin nhắn thường ──
    const msg = update.message || update.edited_message;
    if (!msg || !msg.text) return res.json({ success: true });
    const fromId = String(msg.from?.id || '');
    const chatId = String(msg.chat?.id || '');
    const text = String(msg.text || '').trim();

    // /bind OTP (chưa cần binding trước).
    if (text.startsWith('/bind')) {
      const otp = text.replace('/bind', '').trim();
      const row = prisma.chatBinding
        ? await prisma.chatBinding.findFirst({ where: { provider: 'TELEGRAM', otpCode: otp } }).catch(() => null)
        : null;
      if (!row || !row.otpExpiresAt || new Date(row.otpExpiresAt) < new Date()) {
        await tg.sendMessage(chatId, 'Mã OTP không đúng hoặc đã hết hạn. Mở app ERP → lấy mã mới.').catch(() => null);
        return res.json({ success: true });
      }
      await runWithTenant(row.tenantId, async () => {
        await prisma.chatBinding.update({ where: { id: row.id }, data: { externalUserId: fromId, chatId, otpCode: null, otpExpiresAt: null, isActive: true } });
      });
      await tg.sendMessage(chatId, '✅ Đã buộc tài khoản ERP. Từ giờ bạn giao việc ở đây, duyệt chi bằng nút Duyệt/Từ chối.').catch(() => null);
      return res.json({ success: true, data: { bound: true } });
    }

    if (!prisma.chatBinding) return res.json({ success: true });
    const binding = await prisma.chatBinding.findFirst({ where: { provider: 'TELEGRAM', externalUserId: fromId, isActive: true } }).catch(() => null);
    if (!binding) {
      await tg.sendMessage(chatId, 'Bạn chưa buộc tài khoản. Mở app ERP → ChatOps → lấy OTP rồi nhắn `/bind <mã>`.').catch(() => null);
      return res.json({ success: true });
    }
    // Idempotency theo update_id ở tầng DB (khởi động lại không mất).
    if (updateId) {
      if (binding.lastUpdateId === updateId) return res.json({ success: true, data: { deduped: true } });
      await prisma.chatBinding.update({ where: { id: binding.id }, data: { lastUpdateId: updateId, chatId } }).catch(() => null);
    }

    const out = await runWithTenant(binding.tenantId, async () => {
      const u = await prisma.user.findUnique({ where: { id: binding.userId }, select: { id: true, role: true, tenantId: true, isActive: true } });
      if (!u || !u.isActive) throw { status: 403, message: 'Tài khoản ERP đã bị vô hiệu' };
      const { processMessage } = require('./orchestrator.service');
      return processMessage({ text, user: u, chatId, updateId });
    });
    const reply = require('./telegram.service').formatCitedReply(out.reply, out.citations || []);
    await tg.sendMessage(chatId, reply).catch((e) => logger.warn(`[chatops] reply thất bại: ${e.message}`));
    return res.json({ success: true });
  } catch (e) { next(e); }
});

/**
 * Decide gate dùng chung cho Telegram callback (không qua middleware authorize —
 * quyền kiểm tra thủ công theo binding + role để đúng userId người bấm).
 */
const decideGateAs = async (userId, gateId, decision, note) => {
  const prisma = require('../../config/prisma');
  const { buildDecisionData } = require('../ai/agent.humangate');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
  if (!user || !['ADMIN', 'MANAGER'].includes(user.role)) {
    throw { status: 403, message: 'Chỉ ADMIN/MANAGER được duyệt' };
  }
  const gate = await prisma.agentHumanGate.findFirst({ where: { id: gateId }, include: { session: { select: { userId: true, triggerSource: true } } } });
  if (!gate) throw { status: 404, message: 'Gate không tồn tại' };
  if (gate.status !== 'PENDING') throw { status: 409, message: `Gate đã ${gate.status}` };
  if (new Date(gate.expiresAt) < new Date()) throw { status: 400, message: 'Gate đã hết hạn' };
  if (decision === 'REJECTED' && !String(note || '').trim() && gate.actionType !== 'DATA_REQUEST') {
    throw { status: 400, message: 'Từ chối cần nhập lý do' };
  }
  // HERMES Phase 5 — cấm self-approval với spend gate (PO_PROPOSAL).
  const { PO_PROPOSAL } = require('../ai/agent.humangate');
  if (decision === 'APPROVED' && gate.actionType === PO_PROPOSAL && gate.session?.userId === userId) {
    throw { status: 409, message: 'Không được tự duyệt đề xuất do chính mình tạo (cần người thứ hai)' };
  }
  const claimed = await prisma.agentHumanGate.updateMany({
    where: { id: gateId, status: 'PENDING' },
    data: buildDecisionData({ decision, note, userId }),
  });
  if (claimed.count !== 1) throw { status: 409, message: 'Gate đã được xử lý bởi người khác' };

  let po = null;
  if (decision === 'APPROVED' && gate.actionType === PO_PROPOSAL) {
    try {
      const { executeGate } = require('../ai/agent.gate.exec');
      const r = await executeGate(gateId, userId, {});
      po = r.po;
    } catch (e) {
      logger.error(`[chatops] executeGate sau duyệt Telegram thất bại gate=${gateId}: ${e.message}`);
    }
  }
  // Audit bắt buộc (Phase 5) — lỗi audit không làm hỏng response nhưng phải log.
  try {
    await prisma.auditLog.create({
      data: {
        userId, action: decision === 'APPROVED' ? 'APPROVE_HUMAN_GATE' : 'REJECT_HUMAN_GATE',
        entity: 'AgentHumanGate', entityId: gateId,
        afterJson: { decision, note: note || null },
        agentSessionId: gate.sessionId,
        meta: { channel: 'TELEGRAM' },
      },
    });
  } catch (e) { logger.error(`[chatops] MẤT audit decide gate ${gateId}: ${e.message}`); }

  const message = decision === 'APPROVED'
    ? (po ? `Đã phê duyệt — tạo PO ${po.poCode}` : 'Đã phê duyệt ✅')
    : 'Đã từ chối (đã ghi lý do)';
  return { gateId, decision, po: po ? { id: po.id, poCode: po.poCode } : null, message };
};

/**
 * @swagger
 * /api/chatops/agents:
 *   get:
 *     summary: Danh sách 6 agent phòng ban + tool whitelist
 *     tags: [ChatOps]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Danh sách agent }
 */
router.get('/agents', authenticate, requireModule('ai'), async (req, res, next) => {
  try {
    const { listAgents } = require('./dept');
    success(res, listAgents());
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.decideGateAs = decideGateAs;
