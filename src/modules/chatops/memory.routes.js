/**
 * modules/chatops/memory.routes.js — API bộ nhớ công ty (HERMES Phase 3)
 */
const express = require('express');
const { authenticate, authorize } = require('../../middleware/auth.middleware');
const { requireModule } = require('../../middleware/plan.middleware');
const { success, paginated, created } = require('../../utils/response');

const router = express.Router();
router.use(authenticate, requireModule('ai'));

/**
 * @swagger
 * /api/chatops/memory:
 *   get:
 *     summary: Liệt kê fact đã duyệt (ACTIVE) của tenant (company + phòng mình)
 *     tags: [ChatOps]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Danh sách fact }
 */
router.get('/', async (req, res, next) => {
  try {
    const prisma = require('../../config/prisma');
    if (!prisma.agentMemory) throw { status: 503, message: 'AgentMemory chưa có trong Prisma client' };
    const { status = 'ACTIVE', page = 1, limit = 20 } = req.query;
    const where = status ? { status } : {};

    // Không lọc phòng thì mọi user tenant đọc được cả fact DEPT của phòng khác —
    // trái với mục đích `scope DEPT`. Áp cùng quy tắc với cited-QA: quản lý thấy
    // hết, người khác chỉ thấy COMPANY + phòng mình.
    if (!['ADMIN', 'MANAGER', 'SUPER_ADMIN', 'SUPER_OMEGA_ULTRA_ADMIN'].includes(req.user.role)) {
      const deptCode = req.deptCode || (await require('../middleware/dept.middleware').getUserDeptCode(prisma, req.user));
      const dept = deptCode
        ? await prisma.department.findFirst({ where: { code: deptCode }, select: { id: true } }).catch(() => null)
        : null;
      where.OR = [{ scope: 'COMPANY' }, ...(dept ? [{ scope: 'DEPT', departmentId: dept.id }] : [])];
    }

    const [data, total] = await Promise.all([
      prisma.agentMemory.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (Number(page) - 1) * Number(limit), take: Number(limit) }),
      prisma.agentMemory.count({ where }),
    ]);
    paginated(res, data, { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) });
  } catch (e) { next(e); }
});

/**
 * @swagger
 * /api/chatops/memory/propose:
 *   post:
 *     summary: Đề xuất fact mới (COMPANY → PENDING + gate duyệt; DEPT → ACTIVE ngay)
 *     description: >
 *       scope=DEPT chỉ MANAGER/ADMIN, và MANAGER chỉ ghi được cho phòng của mình —
 *       nếu không, user phòng A ghi fact vào phòng B rồi fact đó lọt vào system
 *       prompt của phòng B.
 *     tags: [ChatOps]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Fact ứng viên }
 *       403: { description: Không có quyền ghi fact cấp phòng ban }
 */
router.post('/propose', async (req, res, next) => {
  try {
    const { key, fact, scope = 'COMPANY', departmentId = null, sessionId = null } = req.body || {};
    if (!key || !fact) throw { status: 400, message: 'key và fact là bắt buộc' };
    const { saveCandidate } = require('./memory.service');
    const out = await saveCandidate({
      key, fact, scope, departmentId, sessionId,
      createdById: req.user.id,
      user: { id: req.user.id, role: req.user.role, deptCode: req.deptCode || null },
    });
    created(res, out, scope === 'COMPANY' ? 'Đã ghi fact chờ duyệt' : 'Đã ghi fact phòng');
  } catch (e) { next(e); }
});

/**
 * @swagger
 * /api/chatops/memory/{id}/approve:
 *   post:
 *     summary: Duyệt fact PENDING → ACTIVE (MANAGER/ADMIN)
 *     tags: [ChatOps]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Fact đã duyệt }
 */
router.post('/:id/approve', authorize('ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const { approveMemory } = require('./memory.service');
    const mem = await approveMemory({ memoryId: req.params.id, userId: req.user.id });
    success(res, mem, 'Đã duyệt fact');
  } catch (e) { next(e); }
});

/**
 * @swagger
 * /api/chatops/memory/{id}/retire:
 *   post:
 *     summary: Thu hồi fact → RETIRED (MANAGER/ADMIN)
 *     tags: [ChatOps]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Fact đã thu hồi }
 */
router.post('/:id/retire', authorize('ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const { retireMemory } = require('./memory.service');
    const mem = await retireMemory({ memoryId: req.params.id, userId: req.user.id });
    success(res, mem, 'Đã thu hồi fact');
  } catch (e) { next(e); }
});

module.exports = router;
