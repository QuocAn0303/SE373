/**
 * middleware/dept.middleware.js — Phân quyền theo phòng ban (HERMES Phase 5)
 *
 * - authorizeDept(...deptCodes): user phải thuộc 1 trong các phòng (qua
 *   User.departmentId hoặc Employee.departmentId). ADMIN/SUPER_* bypass.
 * - Mở rộng pattern crm/scope.js (ownerScopeForTeam) ra PO/expense/report/inventory
 *   theo phòng ban: deptScope(user, field) trả mảnh where.
 */
const logger = require('../utils/logger');

const BYPASS_ROLES = new Set(['SUPER_OMEGA_ULTRA_ADMIN', 'SUPER_ADMIN', 'ADMIN']);

/** Lấy dept code của user (User.department → Employee.department). */
const getUserDeptCode = async (prisma, user) => {
  if (!user) return null;
  if (user.deptCode) return user.deptCode;
  try {
    const full = await prisma.user.findUnique({
      where: { id: user.id },
      select: { department: { select: { code: true } }, employee: { select: { department: { select: { code: true } } } } },
    });
    return full?.department?.code || full?.employee?.department?.code || null;
  } catch (e) {
    logger.warn(`[dept] lấy phòng user thất bại: ${e.message}`);
    return null;
  }
};

const authorizeDept = (...deptCodes) => {
  const allowed = new Set(deptCodes.map((d) => String(d).toUpperCase()));
  return async (req, res, next) => {
    try {
      if (!req.user) return next({ status: 401, message: 'Chưa xác thực' });
      if (BYPASS_ROLES.has(req.user.role)) return next();
      const prisma = require('../config/prisma');
      const code = await getUserDeptCode(prisma, req.user);
      if (!code || !allowed.has(String(code).toUpperCase())) {
        return next({ status: 403, message: `Chỉ phòng ${[...allowed].join('/')} được thực hiện` });
      }
      req.deptCode = code;
      next();
    } catch (e) { next(e); }
  };
};

/**
 * Mảnh where giới hạn theo phòng ban (giống ownerScopeForTeam của crm/scope.js).
 * @param {object} user req.user (đã gắn deptCode bởi authorizeDept hoặc null)
 * @param {string} field tên field departmentId trên model
 * @param {string|null} deptId id phòng của user (resolve trước khi gọi)
 */
const deptScope = (user, field = 'departmentId', deptId = null) => {
  if (!user) return { [field]: '__no_user__' };
  if (BYPASS_ROLES.has(user.role)) return {};
  if (user.role === 'MANAGER' && !deptId) return {}; // MANAGER chưa xếp phòng: giữ hành vi cũ
  return { [field]: deptId || '__no_dept__' };
};

module.exports = { authorizeDept, deptScope, getUserDeptCode, BYPASS_ROLES };
