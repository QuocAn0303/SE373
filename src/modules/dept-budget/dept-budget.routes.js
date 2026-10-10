/**
 * modules/dept-budget/dept-budget.routes.js — API ngân sách phòng ban (HERMES Phase 5)
 */
const express = require('express');
const { authenticate, authorize } = require('../../middleware/auth.middleware');
const { requireModule } = require('../../middleware/plan.middleware');
const { deptScope, getUserDeptCode } = require('../../middleware/dept.middleware');
const { success, paginated } = require('../../utils/response');

const router = express.Router();
router.use(authenticate, requireModule('ai'));

/**
 * @swagger
 * /api/dept-budgets:
 *   get:
 *     summary: Liệt kê envelope ngân sách theo tháng
 *     description: >
 *       Quản lý thấy mọi phòng; người khác chỉ thấy envelope của phòng mình
 *       (deptScope — fail-closed khi chưa xếp phòng thì không thấy gì).
 *     tags: [DeptBudget]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Danh sách envelope }
 */
router.get('/', async (req, res, next) => {
  try {
    const prisma = require('../../config/prisma');
    if (!prisma.deptBudget) throw { status: 503, message: 'DeptBudget chưa có trong Prisma client' };
    const { month, year, page = 1, limit = 20 } = req.query;
    const where = {};
    if (month) where.month = Number(month);
    if (year) where.year = Number(year);
    // deptScope LÀ thứ khiến authorizeDept không còn là dead code: không có nó,
    // mọi user đọc được hạn mức chi của mọi phòng khác trong tenant.
    const deptCode = await getUserDeptCode(prisma, req.user);
    const dept = deptCode
      ? await prisma.department.findFirst({ where: { code: deptCode }, select: { id: true } }).catch(() => null)
      : null;
    Object.assign(where, deptScope(req.user, 'departmentId', dept?.id || null));
    const [data, total] = await Promise.all([
      prisma.deptBudget.findMany({ where, include: { department: { select: { id: true, code: true, name: true } } }, orderBy: { updatedAt: 'desc' }, skip: (Number(page) - 1) * Number(limit), take: Number(limit) }),
      prisma.deptBudget.count({ where }),
    ]);
    paginated(res, data, { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) });
  } catch (e) { next(e); }
});

/**
 * @swagger
 * /api/dept-budgets/check:
 *   post:
 *     summary: Kiểm tra 1 khoản chi có trong envelope không (approver chain)
 *     tags: [DeptBudget]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Kết quả kiểm tra }
 */
router.post('/check', async (req, res, next) => {
  try {
    const svc = require('./dept-budget.service');
    success(res, await svc.checkSpend(req.body || {}));
  } catch (e) { next(e); }
});

/**
 * @swagger
 * /api/dept-budgets:
 *   post:
 *     summary: Đặt/điều chỉnh envelope tháng (MANAGER/ADMIN)
 *     tags: [DeptBudget]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Envelope đã lưu }
 */
router.post('/', authorize('ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const prisma = require('../../config/prisma');
    if (!prisma.deptBudget) throw { status: 503, message: 'DeptBudget chưa có trong Prisma client' };
    const { departmentId, month, year, limit } = req.body || {};
    if (!departmentId || !month || !year || limit == null) throw { status: 400, message: 'departmentId, month, year, limit là bắt buộc' };
    const { getTenantId } = require('../../config/tenantContext');
    const row = await prisma.deptBudget.upsert({
      where: { tenantId_departmentId_month_year: { tenantId: getTenantId(), departmentId, month: Number(month), year: Number(year) } },
      create: { tenantId: getTenantId(), departmentId, month: Number(month), year: Number(year), limit: Number(limit), spent: 0 },
      update: { limit: Number(limit) },
    });
    success(res, row, 'Đã lưu envelope');
  } catch (e) { next(e); }
});

module.exports = router;
