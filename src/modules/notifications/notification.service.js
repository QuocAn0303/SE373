/**
 * modules/notifications/notification.service.js — Hệ thống thông báo
 * 
 * Tổng quan:
 * - Tạo thông báo cho user cụ thể hoặc theo role
 * - Gửi thông báo realtime qua WebSocket
 * - Các thông báo tự động: PO chờ duyệt, tồn kho thấp, hết hàng, đơn pending lâu, công nợ quá hạn, nhắc lương, đóng kỳ
 * - Debounce để tránh trùng lặp thông báo
 * - CRUD thông báo cho user: danh sách, đếm chưa đọc, đánh dấu đã đọc
 * 
 * Hàm:
 * - getSocket(): Lấy WebSocket instance
 * - emitPayload(notification): Gửi thông báo realtime đến user/role
 * - createOne({type, severity, title, message, link, meta, userId, roleScope}): Tạo thông báo + emit
 * - notifyRoles(roles, params): Tạo thông báo cho nhiều role
 * - notifyPoSubmitted(po): Thông báo PO chờ duyệt đến MANAGER/ADMIN
 * - shouldDebounceLowStock(productId): Kiểm tra debounce tồn thấp (60 phút)
 * - notifyLowStock({productId, productName, qty, minStock}): Thông báo tồn kho thấp
 * - shouldDebounceOutOfStock(productId): Kiểm tra debounce hết hàng
 * - notifyOutOfStock({productId, productName}): Thông báo hết hàng
 * - checkAfterExport(productId): Kiểm tra tồn sau xuất, gọi notifyLowStock/OutOfStock nếu cần
 * - cronPendingOrders(): Kiểm tra đơn pending > 24h, thông báo MANAGER
 * - cronDebtOverdue(debtService): Đánh dấu công nợ quá hạn + thông báo
 * - cronPayrollDue(): Nhắc lương ngày 25
 * - cronPeriodClosing(): Nhắc đóng kỳ kế toán
 * - notifyExpensePending(expense): Thông báo chi phí chờ duyệt
 * - listForUser(user, {unreadOnly, page, limit}): Danh sách thông báo của user, phân trang
 * - unreadCount(user): Đếm thông báo chưa đọc
 * - markRead(id, user): Đánh dấu đã đọc một thông báo
 * - markAllRead(user): Đánh dấu tất cả đã đọc
 */
// src/modules/notifications/notification.service.js
const prisma = require("../../config/prisma");
const { randomUUID } = require("crypto");
const logger = require("../../utils/logger");
const { runWithTenant } = require("../../config/tenantContext");

const DEBOUNCE_MS = 60 * 60 * 1000;

const getSocket = () => {
  try {
    return require("../../realtime/socket");
  } catch {
    return null;
  }
};

const emitPayload = (notification) => {
  const sock = getSocket();
  if (!sock?.emitToUser && !sock?.emitToRole) return;
  const payload = { type: "notification", data: notification };
  if (notification.userId) sock.emitToUser?.(notification.userId, "notification", payload);
  // emitToRole BẮT BUỘC tenantId — row tạo ngoài tenant context (tenantId null)
  // không được broadcast cross-tenant nữa
  if (notification.roleScope) {
    if (!notification.tenantId) {
      logger.warn(`[notif] emitToRole skipped: notification ${notification.id} không có tenantId`);
      return;
    }
    sock.emitToRole?.(notification.roleScope, "notification", payload, notification.tenantId);
  }
};

// Gửi Web Push (PWA) — fire-and-forget, không chặn luồng tạo notification
const sendPush = (notification) => {
  try {
    const pushService = require("../push/push.service");
    const payload = {
      title: notification.title,
      message: notification.message || "",
      link: notification.link || "/",
      severity: notification.severity || "INFO",
    };
    // Role-scope push BẮT BUỘC tenantId — nếu không có (notification tạo ngoài
    // tenant context), sendToRole sẽ query user KHÔNG bị tenant-scoped → web push
    // lọt sang tenant khác
    if (notification.roleScope && !notification.tenantId) {
      logger.warn(`[push] sendToRole skipped: notification ${notification.id} không có tenantId`);
      return;
    }
    const run = notification.userId
      ? pushService.sendToUser(notification.userId, payload)
      : notification.roleScope
        ? pushService.sendToRole(notification.roleScope, payload, notification.tenantId)
        : Promise.resolve();
    run.catch((e) => logger.warn?.("[push] hook failed:", e.message));
  } catch (e) {
    // push module chưa mount hoặc lỗi — không ảnh hưởng notification chính
  }
};

const createOne = async ({
  type,
  severity = "INFO",
  title,
  message,
  link,
  meta,
  userId = null,
  roleScope = null,
  // HERMES Phase 1.2: gate notification (cột đã có từ trước nhưng chưa ai set).
  humanGateId = null,
  requiresAction = false,
}) => {
  const data = {
    id: randomUUID(),
    type,
    severity,
    title,
    message,
    link: link || null,
    userId,
    roleScope,
    humanGateId,
    requiresAction,
  };
  if (meta !== undefined && meta !== null) data.meta = meta;
  const row = await prisma.notification.create({ data });
  emitPayload(row);
  sendPush(row);
  return row;
};

const notifyRoles = async (roles, params) => {
  for (const r of roles) {
    await createOne({ ...params, roleScope: r });
  }
};

const notifyPoSubmitted = async (po) => {
  await notifyRoles(["MANAGER", "ADMIN"], {
    type: "PO_PENDING_APPROVAL",
    severity: "WARNING",
    title: "PO chờ duyệt",
    message: `PO ${po.poCode} cần duyệt (${po.vendor?.name || ""})`,
    link: `/purchase-orders/${po.id}`,
    meta: { poId: po.id },
  });
};

const shouldDebounceLowStock = async (productId) => {
  const since = new Date(Date.now() - DEBOUNCE_MS);
  const recent = await prisma.notification.findFirst({
    where: {
      type: "LOW_STOCK",
      createdAt: { gte: since },
      meta: { path: ["productId"], equals: productId },
    },
  });
  return !!recent;
};

const notifyLowStock = async ({ productId, productName, qty, minStock }) => {
  if (await shouldDebounceLowStock(productId)) return null;
  return notifyRoles(["WAREHOUSE", "MANAGER"], {
    type: "LOW_STOCK",
    severity: "WARNING",
    title: "Tồn kho thấp",
    message: `${productName}: còn ${qty} (min ${minStock})`,
    link: `/inventory`,
    meta: { productId, lastSentAt: new Date().toISOString() },
  });
};

const shouldDebounceOutOfStock = async (productId) => {
  const since = new Date(Date.now() - DEBOUNCE_MS);
  const recent = await prisma.notification.findFirst({
    where: {
      type: "OUT_OF_STOCK",
      createdAt: { gte: since },
      meta: { path: ["productId"], equals: productId },
    },
  });
  return !!recent;
};

const notifyOutOfStock = async ({ productId, productName }) => {
  if (await shouldDebounceOutOfStock(productId)) return null;
  return notifyRoles(["WAREHOUSE", "MANAGER", "ADMIN"], {
    type: "OUT_OF_STOCK",
    severity: "CRITICAL",
    title: "Hết hàng",
    message: `${productName} đã về 0`,
    link: `/inventory`,
    meta: { productId, lastSentAt: new Date().toISOString() },
  });
};

const checkAfterExport = async (productId) => {
  const { findInventory } = require("../../utils/warehouse.helper");
  const row = await findInventory(prisma, productId);
  if (!row) return;
  const inv = await prisma.inventory.findUnique({
    where: { id: row.id },
    include: { product: { select: { id: true, name: true, isActive: true } } },
  });
  if (!inv?.product?.isActive) return;
  const avail = inv.quantity - (inv.reserved || 0);
  if (avail <= 0) await notifyOutOfStock({ productId, productName: inv.product.name });
  else if (avail <= inv.minStock) await notifyLowStock({ productId, productName: inv.product.name, qty: avail, minStock: inv.minStock });
};

const cronPendingOrders = async () => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const stale = await prisma.order.findMany({
    where: { status: "PENDING", createdAt: { lt: since } },
    select: { id: true, orderCode: true, tenantId: true },
    take: 50,
  });
  // Chạy per-tenant: notification phải có tenantId mới hiển thị trong UI
  // + emitToRole scoped đúng tenant (chống cross-tenant leak)
  const byTenant = {};
  for (const o of stale) {
    if (!o.tenantId) continue;
    (byTenant[o.tenantId] ||= []).push(o);
  }
  for (const [tenantId, orders] of Object.entries(byTenant)) {
    await runWithTenant(tenantId, async () => {
      for (const o of orders) {
        const exists = await prisma.notification.findFirst({
          where: {
            type: "ORDER_PENDING_LONG",
            meta: { path: ["orderId"], equals: o.id },
            createdAt: { gte: since },
          },
        });
        if (exists) continue;
        await notifyRoles(["MANAGER"], {
          type: "ORDER_PENDING_LONG",
          severity: "WARNING",
          title: "Đơn PENDING quá lâu",
          message: `Đơn ${o.orderCode} đã chờ > 24h`,
          link: `/orders`,
          meta: { orderId: o.id },
        });
      }
    });
  }
};

const cronDebtOverdue = async (debtService) => {
  await debtService.markOverdueCron();
  const debts = await prisma.debt.findMany({
    where: { status: "OVERDUE" },
    select: { id: true, type: true, amount: true, paidAmount: true, tenantId: true },
    take: 200,
  });
  const byTenant = {};
  for (const d of debts) {
    if (!d.tenantId) continue;
    (byTenant[d.tenantId] ||= []).push(d);
  }
  for (const [tenantId, rows] of Object.entries(byTenant)) {
    await runWithTenant(tenantId, async () => {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      for (const d of rows) {
        const exists = await prisma.notification.findFirst({
          where: { type: "DEBT_OVERDUE", createdAt: { gte: weekAgo }, meta: { path: ["debtId"], equals: d.id } },
        });
        if (exists) continue;
        await notifyRoles(["MANAGER", "ADMIN"], {
          type: "DEBT_OVERDUE",
          severity: "CRITICAL",
          title: "Công nợ quá hạn",
          message: `Công nợ ${d.type} — số tiền còn ${Number(d.amount) - Number(d.paidAmount)}`,
          link: `/finance`,
          meta: { debtId: d.id },
        });
      }
    });
  }
};

const cronPayrollDue = async () => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  for (const { id: tenantId } of tenants) {
    await runWithTenant(tenantId, async () => {
      const exists = await prisma.notification.findFirst({
        where: { type: "PAYROLL_DUE", createdAt: { gte: startOfDay } },
      });
      if (exists) return;
      await notifyRoles(["ADMIN"], {
        type: "PAYROLL_DUE",
        severity: "INFO",
        title: "Nhắc lương",
        message: "Ngày 25: kiểm tra kỳ lương",
        link: `/hr`,
        meta: {},
      });
    });
  }
};

const cronPeriodClosing = async () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  for (const { id: tenantId } of tenants) {
    await runWithTenant(tenantId, async () => {
      const open = await prisma.fiscalPeriod.findFirst({
        where: { year: y, month: m, status: "OPEN" },
      });
      if (!open) return;
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const exists = await prisma.notification.findFirst({
        where: { type: "PERIOD_CLOSING_REMINDER", createdAt: { gte: startOfDay } },
      });
      if (exists) return;
      await notifyRoles(["ADMIN"], {
        type: "PERIOD_CLOSING_REMINDER",
        severity: "INFO",
        title: "Nhắc đóng kỳ kế toán",
        message: `Kỳ ${m}/${y} đang mở — chuẩn bị đóng sổ`,
        link: `/financial-reports`,
        meta: { year: y, month: m },
      });
    });
  }
};

const notifyExpensePending = async (expense) => {
  await notifyRoles(["MANAGER", "ADMIN"], {
    type: "EXPENSE_PENDING_APPROVAL",
    severity: "WARNING",
    title: "Chi phí chờ duyệt",
    message: `${expense.expenseCode}: ${expense.description}`,
    link: `/expenses`,
    meta: { expenseId: expense.id },
  });
};

const listForUser = async (user, { unreadOnly = false, page = 1, limit = 30 } = {}) => {
  const skip = (Number(page) - 1) * Number(limit);
  const where = {
    OR: [{ userId: user.id }, { userId: null, roleScope: user.role }],
  };
  if (unreadOnly === true || unreadOnly === "true") where.isRead = false;

  const [items, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: Number(limit),
    }),
    prisma.notification.count({ where }),
  ]);
  return {
    notifications: items,
    pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
  };
};

const unreadCount = async (user) => {
  const n = await prisma.notification.count({
    where: {
      isRead: false,
      OR: [{ userId: user.id }, { userId: null, roleScope: user.role }],
    },
  });
  return { count: n };
};

const markRead = async (id, user) => {
  const n = await prisma.notification.findUnique({ where: { id } });
  if (!n) throw { status: 404, message: "Không tìm thấy" };
  if (n.userId && n.userId !== user.id) throw { status: 403, message: "Không được phép" };
  if (!n.userId && n.roleScope && n.roleScope !== user.role && user.role !== "ADMIN") {
    throw { status: 403, message: "Không được phép" };
  }
  return prisma.notification.update({ where: { id }, data: { isRead: true } });
};

const markAllRead = async (user) => {
  await prisma.notification.updateMany({
    where: {
      isRead: false,
      OR: [{ userId: user.id }, { userId: null, roleScope: user.role }],
    },
    data: { isRead: true },
  });
  return { ok: true };
};

module.exports = {
  createOne,
  notifyRoles,
  notifyPoSubmitted,
  notifyLowStock,
  notifyOutOfStock,
  checkAfterExport,
  cronPendingOrders,
  cronDebtOverdue,
  cronPayrollDue,
  cronPeriodClosing,
  notifyExpensePending,
  listForUser,
  unreadCount,
  markRead,
  markAllRead,
};
