/**
 * jobs/cron.js — Tác vụ định kỳ (node-cron) cho toàn hệ thống
 * 
 * Tổng quan:
 * - Chạy các tác vụ nền theo lịch: hủy đơn pending, nhắc nợ, lương, đóng kỳ, khuyến mãi, CRM, khấu hao TSCĐ, lot expiry
 * - Chỉ chạy trên PM2 instance 0 (xem app.js) để tránh trùng lặp trong cluster mode
 * - Mỗi tác vụ có try/catch riêng, không làm ảnh hưởng lẫn nhau
 * 
 * Lịch chạy:
 * - Mỗi 5 phút: Quét phiên hỗ trợ hết hạn (support sessions)
 * - Mỗi 5 phút: Quét human-gate AI agent PENDING quá hạn → EXPIRED (instance 0)
 * - Mỗi giờ: Đơn PENDING quá 24h → tự động hủy
 * - 09:00 hàng ngày: Nhắc công nợ quá hạn
 * - 09:00 ngày 25: Nhắc tính lương
 * - 09:00 ngày 28: Nhắc đóng kỳ kế toán
 * - 00:00 hàng ngày: Làm hết hạn khuyến mãi, điểm loyalty, subscription
 * - 01:00 ngày 1: Sinh chi phí định kỳ (recurring expenses)
 * - 08:00 hàng ngày: Nhắc nhiệm vụ CRM sắp tới hạn
 * - Mỗi phút: Xử lý CRM campaigns đã đặt lịch
 * - 01:00 ngày 28: Chạy khấu hao TSCĐ tháng
 * - 07:00 hàng ngày: Cảnh báo lô hàng sắp hết hạn
 * 
 * Hàm:
 * - startCrons(): Khởi động tất cả cron jobs
 * - (Các cron handler inline trong cron.schedule)
 */

const cron = require("node-cron");
const debtService = require("../modules/debt/debt.service");
const notif = require("../modules/notifications/notification.service");
const promotionService = require("../modules/promotions/promotion.service");
const expenseAuto = require("../modules/accounting/expense-auto.service");
const loyaltyService = require("../modules/loyalty/loyalty.service");
const crmTasksService = require("../modules/crm/tasks.service");
const crmCampaignsService = require("../modules/crm/campaigns.service");
const fixedAssetsService = require("../modules/fixed-assets/fixed-assets.service");
const lotService = require("../modules/production/lot.service");
const automation = require("../modules/automation/automation.service");
const bankRecoService = require("../modules/bank-reco/bank-reco.service");
const periodCloseService = require("../modules/accounting/period-close.service");
const subscriptionService = require("../modules/subscriptions/subscription.service");
const currencyService = require("../modules/currency/currency.service");
const { sweepExpiredHumanGates } = require("../modules/ai/agent.humangate");
const prisma = require("../config/prisma");
const { runWithTenant } = require("../config/tenantContext");
const logger = require("../utils/logger");

// Quét các phiên hỗ trợ hết hạn mỗi 5 phút
cron.schedule("*/5 * * * *", async () => {
  try {
    const now = new Date();

    // Tìm và cập nhật tất cả các phiên ACTIVE nhưng đã quá thời gian expiresAt
    const result = await prisma.supportAccessSession.updateMany({
      where: {
        status: "ACTIVE",
        expiresAt: {
          lt: now,
        },
      },
      data: {
        status: "EXPIRED",
      },
    });

    if (result.count > 0) {
      logger.info(
        `[Cron Support Session] Đã tự động chuyển đổi trạng thái sang EXPIRED cho ${result.count} phiên hỗ trợ hết hạn.`,
      );
    }
  } catch (error) {
    logger.error(
      "[Cron Support Session Error] Lỗi khi quét phiên hỗ trợ hết hạn:",
      error,
    );
  }
});

// Quét human-gate (AI agent) PENDING đã quá hạn → EXPIRED, mỗi 5 phút.
// Nếu không có job này thì status EXPIRED trong enum HumanGateStatus không bao giờ
// được set: GET /human-gates trả về danh sách PENDING "ma", và POST /human-gates/:id/decide
// từ chối bằng 400 "Gate has expired" trong khi gate vẫn hiển thị là PENDING trên UI.
// updateMany chạy ngoài tenant context → Prisma extension không inject tenantId → quét mọi tenant.
if (!process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === "0") {
  cron.schedule("*/5 * * * *", async () => {
    try {
      await sweepExpiredHumanGates();
    } catch (error) {
      logger.error(`[Cron Human-Gate Error] Lỗi khi quét human-gate quá hạn: ${error?.message || error}`);
    }
  });
  logger.info("[Cron Human-Gate] Đã đăng ký quét human-gate PENDING quá hạn → EXPIRED (mỗi 5 phút)");
}

// Cron: Subscription renewal reminder — 7 days before endDate
const renewalReminder = async () => {
  try {
    const sevenDaysFromNow = new Date(Date.now() + 7 * 86400000);
    const expiringSubs = await prisma.tenantSubscription.findMany({
      where: {
        endDate: { lte: sevenDaysFromNow, gte: new Date() },
        status: "ACTIVE",
      },
      include: { tenant: { select: { id: true, name: true } } },
    });
    for (const sub of expiringSubs) {
      // Chạy trong tenant context → Prisma extension auto-inject tenantId
      // vào notification.create (nếu không, row có tenantId null sẽ không
      // bao giờ hiện trong listForUser vì query đọc bị tenant-scoped).
      await runWithTenant(sub.tenantId, async () => {
        const adminUsers = await prisma.user.findMany({
          where: { tenantId: sub.tenantId, role: { in: ["ADMIN", "SUPER_ADMIN"] }, isActive: true },
          select: { id: true },
        });
        for (const user of adminUsers) {
          await prisma.notification.create({
            data: {
              userId: user.id,
              title: `Gói dịch vụ sắp hết hạn`,
              body: `Gói của ${sub.tenant.name} sẽ hết hạn vào ${sub.endDate.toLocaleDateString("vi-VN")}. Vui lòng gia hạn để tiếp tục sử dụng dịch vụ.`,
              type: "SUBSCRIPTION",
              severity: "WARNING",
              link: "/subscription",
            },
          });
        }
      });
    }
    if (expiringSubs.length > 0) {
      logger.info(`[cron] Renewal reminder: ${expiringSubs.length} subscriptions expiring soon`);
    }
  } catch (err) {
    logger.error("[cron] Renewal reminder error:", err.message);
  }
};

const startCrons = () => {
  cron.schedule("0 * * * *", async () => {
    try {
      await notif.cronPendingOrders();
    } catch (e) {
      logger.error("[cron] pending orders", e.message);
    }
  });

  cron.schedule("0 9 * * *", async () => {
    try {
      await notif.cronDebtOverdue(debtService);
    } catch (e) {
      logger.error("[cron] debt overdue", e.message);
    }
  });

  cron.schedule("0 9 25 * *", async () => {
    try {
      await notif.cronPayrollDue();
    } catch (e) {
      logger.error("[cron] payroll due", e.message);
    }
  });

  cron.schedule("0 9 28 * *", async () => {
    try {
      await notif.cronPeriodClosing();
    } catch (e) {
      logger.error("[cron] period closing", e.message);
    }
  });

  cron.schedule("0 0 * * *", async () => {
    try {
      const n = await promotionService.expirePromotions();
      if (n) logger.info(`[cron] expired ${n} promotions`);
    } catch (e) {
      logger.error("[cron] promotion expire", e.message);
    }
    try {
      const expiredPts = await loyaltyService.expirePoints();
      if (expiredPts)
        logger.info(`[cron] expired ${expiredPts} loyalty batches`);
    } catch (e) {
      logger.error("[cron] loyalty expire", e.message);
    }
    try {
      const expired = await subscriptionService.checkExpiredSubscriptions();
      if (expired) logger.info(`[cron] expired ${expired} subscriptions`);
    } catch (e) {
      logger.error("[cron] subscription expiry", e.message);
    }
  });

  cron.schedule("0 1 1 * *", async () => {
    try {
      const created = await expenseAuto.generateRecurring();
      if (created.length)
        logger.info(`[cron] recurring expenses: ${created.length}`);
    } catch (e) {
      logger.error("[cron] recurring expenses", e.message);
    }
  });

  // CRM: nhắc nhiệm vụ sắp tới hạn / quá hạn — 8h sáng mỗi ngày
  cron.schedule("0 8 * * *", async () => {
    try {
      const n = await crmTasksService.cronRemindUpcoming();
      if (n) logger.info(`[cron] CRM task reminders sent: ${n}`);
    } catch (e) {
      logger.error("[cron] crm task reminder", e.message);
    }
  });

  // Tự động cập nhật tỷ giá từ API mỗi ngày lúc 08:30
  cron.schedule("30 8 * * *", async () => {
    try {
      const n = await currencyService.fetchRatesFromAPI();
      logger.info(`[cron] exchange rates: updated ${n} currencies`);
    } catch (e) {
      logger.error("[cron] exchange rates", e.message);
    }
  });

  // CRM: xử lý campaigns đã đặt lịch — mỗi phút
  cron.schedule("* * * * *", async () => {
    try {
      const n = await crmCampaignsService.cronProcessScheduled();
      if (n) logger.info(`[cron] CRM campaigns processed: ${n}`);
    } catch (e) {
      logger.error("[cron] crm campaign scheduler", e.message);
    }
  });

  // Khấu hao TSCD: ngày 28 mỗi tháng lúc 01:00
  cron.schedule("0 1 28 * *", async () => {
    const now = new Date();
    try {
      const result = await fixedAssetsService.runMonthlyDepreciation(
        now.getFullYear(),
        now.getMonth() + 1,
      );
      logger.info(
        `[cron] depreciation ${result.period}: ${result.processed} assets processed`,
      );
    } catch (e) {
      logger.error("[cron] depreciation", e.message);
    }
  });

  // Lot expiry alert: 7h mỗi ngày — thông báo lô hàng hết hạn trong 30 ngày
  cron.schedule("0 7 * * *", async () => {
    try {
      const lots = await lotService.getExpiringLots(30);
      if (lots.length) {
        logger.info(`[cron] ${lots.length} lô hàng sắp hết hạn trong 30 ngày`);
        // Per-tenant: notification cần tenantId để hiển thị trong UI
        // + emitToRole scoped đúng tenant
        const byTenant = {};
        for (const lot of lots) {
          if (!lot.tenantId) continue;
          (byTenant[lot.tenantId] ||= []).push(lot);
        }
        for (const [tenantId, tenantLots] of Object.entries(byTenant)) {
          await runWithTenant(tenantId, async () => {
            await notif.notifyRoles(["ADMIN", "MANAGER"], {
              type: "LOT_EXPIRY",
              severity: "WARNING",
              title: "Lô hàng sắp hết hạn",
              message: `${tenantLots.length} lô hàng sắp hết hạn trong 30 ngày`,
              link: "/lot-tracking",
              meta: { count: tenantLots.length, period: 30 },
            });
          });
        }
      }
    } catch (e) {
      logger.error("[cron] lot expiry check", e.message);
    }
  });

  // Auto-Payroll: ngay 25 hang thang luc 6h sang
  cron.schedule("0 6 25 * *", async () => {
    try {
      await automation.autoPayroll();
    } catch (e) {
      logger.error("[cron] auto-payroll", e.message);
    }
  });

  // Debt Auto-Collection: 9h sang moi ngay
  // 3 cap: sap han (3 ngay), qua han 7 ngay, qua han 30 ngay
  cron.schedule("0 9 * * *", async () => {
    try {
      await automation.debtAutoCollection();
    } catch (e) {
      logger.error("[cron] debt-auto-collection", e.message);
    }
  });

  // Bank Reco Auto-Match: 10h sang moi ngay
  cron.schedule("0 10 * * *", async () => {
    try {
      await bankRecoService.autoMatchAll();
    } catch (e) {
      logger.error("[cron] bank-reco auto-match", e.message);
    }
  });

  // AI Proactive: Morning Briefing 7h sang moi ngay
  cron.schedule("0 7 * * *", async () => {
    try {
      await automation.morningBriefing();
    } catch (e) {
      logger.error("[cron] morning-briefing", e.message);
    }
  });

  // Subscription renewal reminder: 8h sang moi ngay
  cron.schedule("0 8 * * *", renewalReminder);

  // AI Proactive: Anomaly Detection 8h sang moi ngay
  cron.schedule("0 8 * * *", async () => {
    try {
      await automation.anomalyDetection();
    } catch (e) {
      logger.error("[cron] anomaly-detection", e.message);
    }
  });

  // Accounting: Phan bo chi phi tra truoc hang thang (ngay 1 luc 02:00)
  cron.schedule("0 2 1 * *", async () => {
    try {
      const now = new Date();
      const systemUser = await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true } });
      if (systemUser) {
        const n = await periodCloseService.runMonthlyAllocation(
          now.getFullYear(), now.getMonth() + 1, systemUser.id
        );
        if (n.length) logger.info(`[cron] prepaid-allocation: ${n.length} items`);
      }
    } catch (e) {
      logger.error("[cron] prepaid-allocation", e.message);
    }
  });

  // Accounting: Khau hao TSCD hang thang (ngay 1 luc 03:00)
  cron.schedule("0 3 1 * *", async () => {
    try {
      const now = new Date();
      const systemUser = await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true } });
      if (systemUser) {
        const n = await periodCloseService.runMonthlyDepreciation(
          now.getFullYear(), now.getMonth() + 1, systemUser.id
        );
        if (n.length) logger.info(`[cron] monthly-depreciation: ${n.length} assets`);
      }
    } catch (e) {
      logger.error("[cron] monthly-depreciation", e.message);
    }
  });

  // Weekly P&L report: 8h sang thu 2
  cron.schedule("0 8 * * 1", async () => {
    try {
      await automation.weeklyPnLEmail();
    } catch (e) {
      logger.error("[cron] weekly-pnl", e.message);
    }
  });

  // Auto-close dormant customers: ngay 1 hang thang luc 04:00
  cron.schedule("0 4 1 * *", async () => {
    try {
      await automation.autoCloseDormantCustomers();
    } catch (e) {
      logger.error("[cron] auto-close-dormant", e.message);
    }
  });

  // Auto-archive: ngay 1 hang thang luc 05:00
  cron.schedule("0 5 1 * *", async () => {
    try {
      await automation.autoArchiveData();
    } catch (e) {
      logger.error("[cron] auto-archive", e.message);
    }
  });

  // Webhook retry: moi 5 phut
  cron.schedule("*/5 * * * *", async () => {
    try {
      const webhookSvc = require("../modules/integrations/webhook.service");
      await webhookSvc.retryFailed();
    } catch (e) {
      logger.error("[cron] webhook retry", e.message);
    }
  });

  // CRM: CLV forecast + Churn win-back automation — hang dem 01:00 (Mục 3.3, 4)
  cron.schedule("0 1 * * *", async () => {
    try {
      const churnAutomation = require("../modules/customers/churn-automation.service");
      const res = await churnAutomation.runAllTenants();
      logger.info(`[cron] churn-automation: ${JSON.stringify(res)}`);
    } catch (e) {
      logger.error("[cron] churn-automation", e.message);
    }
  });

  // CRM: RFM recalculation hàng đêm 01:30 (Mục 3.2)
  cron.schedule("30 1 * * *", async () => {
    try {
      const rfmService = require("../modules/customers/rfm.service");
      const res = await rfmService.runAllTenants();
      logger.info(`[cron] rfm-recalc: ${JSON.stringify(res)}`);
    } catch (e) {
      logger.error("[cron] rfm-recalc", e.message);
    }
  });

  // SRM: Vendor Scorecard (OTIF/Defect/Grade) — ngay 1 hang thang luc 06:00 (Mục 6.4)
  cron.schedule("0 6 1 * *", async () => {
    try {
      const vendorScorecard = require("./vendor-scorecard.job");
      const res = await vendorScorecard.runAll();
      logger.info(`[cron] vendor-scorecard: ${res.length} vendors`);
    } catch (e) {
      logger.error("[cron] vendor-scorecard", e.message);
    }
  });

  // Cron: Daily DB backup at 02:00 (only on instance 0)
  if (!process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === "0") {
    cron.schedule("0 2 * * *", async () => {
      try {
        const backupService = require("../modules/admin/backup.service");
        const adminUser = await prisma.user.findFirst({
          where: { role: "SUPER_OMEGA_ULTRA_ADMIN" },
          select: { id: true },
        });
        if (adminUser) await backupService.create(adminUser.id);
      } catch (err) {
        // `logger.error(msg, err.message)` khiến winston coi chuỗi là object và
        // in ra object {"0":"s","1":"p",...} — phải nội suy vào chuỗi một.
        logger.error(`[cron] Daily backup error: ${err && err.message ? err.message : String(err)}`);
      }
    });
  }

  // HERMES Phase 6 — executor lịch báo cáo NL (mỗi 5 phút, instance 0).
  // Render số liệu từ DB (không cho LLM bịa số) rồi gửi Telegram/email.
  if (!process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === "0") {
    cron.schedule("*/5 * * * *", async () => {
      try {
        const nl = require("../modules/chatops/nl-schedule.service");
        const res = await nl.runDueSchedules();
        if (res.length) logger.info(`[cron] nl-schedule: ${res.filter((r) => r.ok).length}/${res.length} ok`);
      } catch (e) {
        logger.error(`[cron] nl-schedule error: ${e && e.message ? e.message : String(e)}`);
      }
    });
  }

  logger.info(
    "[cron] scheduled: human-gate-expiry every 5min, orders hourly, debt 09:00, payroll 25th, period 28th, promo daily, recurring 1st, CRM tasks 08:00, CRM campaigns every minute, depreciation 28th 01:00, lot expiry 07:00, exchange rates 08:30, auto-payroll 25th 06:00, debt-collection 09:00, bank-reco-auto-match 10:00, morning-briefing 07:00, anomaly-detection 08:00, renewal-reminder 08:00, prepaid-allocation 1st 02:00, monthly-depreciation 1st 03:00, weekly-pnl Mon 08:00, auto-close-dormant 1st 04:00, auto-archive 1st 05:00, daily-backup 02:00, webhook-retry every 5min, churn-automation daily 01:00, vendor-scorecard 1st 06:00, nl-schedule every 5min",
  );
};

module.exports = { startCrons };
