/**
 * modules/chatops/nl-schedule.routes.js — API đặt lịch báo cáo bằng chat (HERMES Phase 6)
 */
const express = require('express');
const { authenticate, authorize } = require('../../middleware/auth.middleware');
const { requireModule } = require('../../middleware/plan.middleware');
const { success, created } = require('../../utils/response');

const router = express.Router();
router.use(authenticate, requireModule('ai'));

/**
 * @swagger
 * /api/chatops/schedules/from-chat:
 *   post:
 *     summary: Đặt lịch báo cáo bằng câu chat ("gửi P&L 8h sáng T2 cho #ketoan")
 *     description: >
 *       Chỉ ADMIN/MANAGER được đặt lịch. `telegramChatId` chỉ được là chat đã
 *       BUỘC (ChatBinding) của chính người đặt — nếu không, bất kỳ user nào cũng
 *       ghim được doanh thu/công nợ của tenant vào chat Telegram bất kỳ.
 *     tags: [ChatOps]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Lịch đã tạo }
 *       403: { description: chatId không thuộc tài khoản của bạn }
 */
router.post('/from-chat', authorize('ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const svc = require('./nl-schedule.service');
    const s = await svc.createFromChat({ text: req.body?.text, user: req.user, reportId: req.body?.reportId || null });
    created(res, s, `Đã đặt lịch (${s.cron}, kênh ${s.channel})`);
  } catch (e) { next(e); }
});

/**
 * @swagger
 * /api/chatops/schedules/run-due:
 *   post:
 *     summary: Chạy tay các lịch đến hạn (MANAGER/ADMIN, dùng khi kiểm thử)
 *     tags: [ChatOps]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Kết quả chạy }
 */
router.post('/run-due', async (req, res, next) => {
  try {
    if (!['ADMIN', 'MANAGER'].includes(req.user.role)) throw { status: 403, message: 'Chỉ ADMIN/MANAGER' };
    const svc = require('./nl-schedule.service');
    // Giới hạn theo tenant của người gọi — không cho kích hoạt lịch tenant khác.
    success(res, await svc.runDueSchedules({ tenantId: req.user.tenantId || null }), 'Đã chạy lịch đến hạn');
  } catch (e) { next(e); }
});

module.exports = router;
