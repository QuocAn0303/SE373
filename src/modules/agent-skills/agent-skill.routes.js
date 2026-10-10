/**
 * modules/agent-skills/agent-skill.routes.js — API skill registry (HERMES Phase 4)
 */
const express = require('express');
const { authenticate, authorize } = require('../../middleware/auth.middleware');
const { requireModule } = require('../../middleware/plan.middleware');
const { success, created, paginated } = require('../../utils/response');

const router = express.Router();
router.use(authenticate, requireModule('ai'));

/**
 * @swagger
 * /api/agent-skills:
 *   get:
 *     summary: Liệt kê skill (lọc theo status)
 *     tags: [AgentSkills]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Danh sách skill }
 */
router.get('/', async (req, res, next) => {
  try {
    const prisma = require('../../config/prisma');
    if (!prisma.agentSkill) throw { status: 503, message: 'AgentSkill chưa có trong Prisma client' };
    const { status, page = 1, limit = 20 } = req.query;
    const where = status ? { status } : {};
    const [data, total] = await Promise.all([
      prisma.agentSkill.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (Number(page) - 1) * Number(limit), take: Number(limit) }),
      prisma.agentSkill.count({ where }),
    ]);
    paginated(res, data, { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) });
  } catch (e) { next(e); }
});

/**
 * @swagger
 * /api/agent-skills/propose:
 *   post:
 *     summary: Agent đề xuất skill mới (DRAFT)
 *     tags: [AgentSkills]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Skill DRAFT }
 */
router.post('/propose', async (req, res, next) => {
  try {
    const svc = require('./agent-skill.service');
    const s = await svc.propose({ ...req.body, createdById: req.user.id });
    created(res, s, 'Đã ghi skill chờ gửi duyệt');
  } catch (e) { next(e); }
});

/**
 * @swagger
 * /api/agent-skills/{id}/submit:
 *   post:
 *     summary: Gửi skill DRAFT → PENDING chờ MANAGER duyệt
 *     tags: [AgentSkills]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Skill PENDING }
 */
router.post('/:id/submit', async (req, res, next) => {
  try {
    const svc = require('./agent-skill.service');
    success(res, await svc.submitForApproval({ id: req.params.id }), 'Đã gửi duyệt');
  } catch (e) { next(e); }
});

/**
 * @swagger
 * /api/agent-skills/{id}/sandbox:
 *   post:
 *     summary: Chạy thử skill trong sandbox (rollback, không đổi DB)
 *     tags: [AgentSkills]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Báo cáo sandbox }
 */
router.post('/:id/sandbox', authorize('ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const svc = require('./agent-skill.service');
    success(res, await svc.runSandbox({ id: req.params.id }), 'Đã chạy sandbox');
  } catch (e) { next(e); }
});

/**
 * @swagger
 * /api/agent-skills/{id}/approve:
 *   post:
 *     summary: Duyệt skill → APPROVED (cần sandbox trước)
 *     tags: [AgentSkills]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Skill APPROVED }
 */
router.post('/:id/approve', authorize('ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const svc = require('./agent-skill.service');
    success(res, await svc.approve({ id: req.params.id, userId: req.user.id }), 'Đã duyệt skill');
  } catch (e) { next(e); }
});

/**
 * @swagger
 * /api/agent-skills/{id}/disable:
 *   post:
 *     summary: Thu hồi skill ngay (DISABLED)
 *     tags: [AgentSkills]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Skill DISABLED }
 */
router.post('/:id/disable', authorize('ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const svc = require('./agent-skill.service');
    success(res, await svc.disable({ id: req.params.id, userId: req.user.id }), 'Đã thu hồi skill');
  } catch (e) { next(e); }
});

/**
 * @swagger
 * /api/agent-skills/callable/list:
 *   get:
 *     summary: Skill APPROVED được phép gọi theo phòng ban
 *     tags: [AgentSkills]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Danh sách skill gọi được }
 */
router.get('/callable/list', async (req, res, next) => {
  try {
    const svc = require('./agent-skill.service');
    success(res, await svc.callableSkills({ departmentCode: req.query.dept || null }));
  } catch (e) { next(e); }
});

module.exports = router;
