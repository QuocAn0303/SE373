/**
 * app.js — Entry point chính của Backend ERP
 * 
 * Tổng quan:
 * - Khởi tạo Express app với đầy đủ middleware: compression, helmet, cors, morgan, xss-clean, hpp, rate-limit
 * - Mount tất cả routes từ 40+ module nghiệp vụ dưới /api/*
 * - Khởi động HTTP server + Socket.IO (real-time) + cron jobs + CDC (Change Data Capture cho AI agent)
 * - Tự động thử port nếu bị chiếm (EADDRINUSE) → tăng dần, tối đa 10 lần thử
 * - Ghi VITE_API_URL vào frontend/.env để đồng bộ port giữa backend và frontend dev
 * - Sentry error tracking (nếu có SENTRY_DSN)
 * 
 * Luồng khởi động:
 *   1. Load .env → init Sentry
 *   2. Tạo Express app → gắn middleware toàn cục
 *   3. Mount tất cả routes
 *   4. 404 handler → error handler (cuối cùng)
 *   5. startServer(): tạo HTTP server → init Socket.IO → start cron/CDC → lắng nghe port
 *   6. Nếu EADDRINUSE → thử port tiếp theo
 */

require("dotenv").config();

const Sentry = require("@sentry/node");
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 0,
  });
}

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const hpp = require("hpp");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./config/swagger");
const fs = require("fs");
const path = require("path");

const compression = require("compression");
const errorHandler = require("./middleware/error.middleware");
const { authenticate, requireSuperOmega } = require("./middleware/auth.middleware");

// Routes
const authRoutes = require("./modules/auth/auth.routes");
const userRoutes = require("./modules/users/user.routes");
const productRoutes = require("./modules/products/product.routes");
const orderRoutes = require("./modules/orders/order.routes");
const returnRoutes = require("./modules/returns/return.routes");
const dashboardRoutes = require("./modules/dashboard/dashboard.routes");
const customerRoutes = require("./modules/customers/customer.routes");
const inventoryRoutes = require("./modules/inventory/inventory.routes");
const categoryRoutes = require("./modules/categories/category.routes");
const reportRoutes = require("./modules/reports/report.routes");
const auditRoutes = require("./modules/audit/audit.routes");
const hrRoutes = require("./modules/hr/hr.routes");
const analyticsRoutes = require("./modules/analytics/analytics.routes");
const aiRoutes = require("./modules/ai/ai.routes");
const posRoutes = require("./modules/pos/pos.routes");
const agentRoutes = require("./modules/ai/agent.routes");
const llmProxyRoutes = require("./modules/ai/agent.llm");
const dbAgentRoutes = require("./modules/ai/db-agent.routes");
const accountingRoutes = require("./modules/accounting/accounting.routes");
const debtRoutes = require("./modules/debt/debt.routes");
const notificationRoutes = require("./modules/notifications/notification.routes");
const purchaseOrderAliasRoutes = require("./modules/accounting/purchase-order.routes");
const grnRoutes = require("./modules/accounting/grn.routes");
const purchaseInvoiceRoutes = require("./modules/accounting/purchase-invoice.routes");
const churnRoutes = require("./modules/customers/churn.routes");
const webhookLeadRoutes = require("./modules/crm/webhook-lead.routes");
// PRM (2026-10): quản trị đối tác đầu ra. GOM ba nhóm dưới một tiền tố:
//   /api/partners          hồ sơ đối tác
//   /api/partner-referrals lượt giới thiệu
//   /api/partner-roi       báo cáo hiệu quả
// Tách khỏi `crm` vì đối tác là đối tượng khác khách hàng (khớp với `Vendor` ở
// phía nhà cung cấp). Xem `src/modules/partners/index.js`.
const partnerRoutes = require("./modules/partners");
const promotionRoutes = require("./modules/promotions/promotion.routes");
const invoiceRoutes = require("./modules/orders/invoice.routes");
const storeCreditRoutes = require("./modules/customers/store-credit.routes");
const serialNumberRoutes = require("./modules/inventory/serial-number.routes");
const loyaltyRoutes = require("./modules/loyalty/loyalty.routes");
const deliveryRoutes = require("./modules/delivery/delivery.routes");
const warehouseRoutes = require("./modules/warehouses/warehouse.routes");
const stockTransferRoutes = require("./modules/warehouses/stock-transfer.routes");
const importRoutes = require("./modules/import/import.routes");
const settingsRoutes = require("./modules/settings/settings.routes");
const adminRoutes = require("./modules/admin/admin.routes");
const backupRoutes = require("./modules/admin/backup.routes");
const subscriptionRoutes = require("./modules/subscriptions/subscription.routes");
const crmRoutes = require("./modules/crm");
const projectRoutes = require("./modules/projects");
const productionRoutes = require("./modules/production");
const einvoiceRoutes = require("./modules/einvoice/einvoice.routes");
const taxReportRoutes = require("./modules/tax-report/tax-report.routes");
const bankRecoRoutes = require("./modules/bank-reco/bank-reco.routes");
const bankAccountRoutes = require("./modules/integrations/bank-account.routes");
const vietqrRoutes = require("./modules/vietqr/vietqr.routes");
const fixedAssetsRoutes = require("./modules/fixed-assets/fixed-assets.routes");
const currencyRoutes = require("./modules/currency/currency.routes");
const marketplaceRoutes = require("./modules/marketplace/marketplace.routes");
const reportBuilderRoutes = require("./modules/report-builder/report-builder.routes");
const workflowRoutes = require("./modules/workflow/workflow.routes");
const portalRoutes = require("./modules/portal/portal.routes");
const integrationRoutes = require("./modules/integrations/integration.routes");
const webhookRoutes = require("./modules/integrations/webhook.routes");
const smartGuideRoutes = require("./modules/smart-guide/smart-guide.routes");
const replenishmentRoutes = require("./modules/replenishment/replenishment.routes");
const menuRoutes = require("./modules/menu/menu.routes");
const tableRoutes = require("./modules/tables/table.routes");
const kdsRoutes = require("./modules/kds/kds.routes");
const printerRoutes = require("./modules/printers/printer.routes");
const qrOrderingRoutes = require("./modules/qr-ordering/qr-ordering.routes");
const paymentGatewayRoutes = require("./modules/payment-gateway/payment-gateway.routes");
const foodDeliveryRoutes = require("./modules/food-delivery/food-delivery.routes");
const recipeRoutes = require("./modules/recipe/recipe.routes");
const stampCardRoutes = require("./modules/stamp-card/stamp-card.routes");
const aiForecastRoutes = require("./modules/ai-forecast/ai-forecast.routes");
const pettyCashRoutes = require("./modules/petty-cash/petty-cash.routes");
const searchRoutes = require("./modules/search/search.routes");
const pushRoutes = require("./modules/push/push.routes");
const bulkRoutes = require("./modules/bulk/bulk.routes");
const documentRoutes = require("./modules/documents/documents.routes");
const deliveryService = require("./modules/delivery/delivery.service");
const http = require("http");
const { initSocket } = require("./realtime/socket");
const { startCrons } = require("./jobs/cron");
const { startCDC } = require("./jobs/agent.cdc");

const app = express();

// Trust proxy — chỉ bật khi chạy SAU reverse proxy (TRUST_PROXY=true)
// Mặc định tắt: tránh spoof X-Forwarded-For làm bypass rate limit khi deploy trực tiếp
if (process.env.TRUST_PROXY === "true") {
  app.set('trust proxy', 1);
}

const corsOrigin =
  process.env.CORS_ORIGIN || process.env.CLIENT_URL || "http://localhost:5173";

// ==================== Middleware ====================
app.use(compression());
app.use(helmet());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(hpp());

const rateLimit = require('express-rate-limit')

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  // CRM audit L24: `/api/crm/track/*` dùng limiter riêng (`trackingLimiter`).
  // Phải `skip` ở đây — nếu không, apiLimiter chạy trước và chặn ở 100/phút dù
  // trackingLimiter có hạn mức cao hơn, khiến trackingLimiter chết không.
  skip: (req) => req.path === '/crm/track' || req.path.startsWith('/crm/track/'),
  message: { success: false, message: 'Quá nhiều request, vui lòng thử lại sau' }
})

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Quá nhiều lần đăng nhập, vui lòng thử lại sau 1 phút' }
})

// CRM audit L24 — limiter riêng cho endpoint tracking.
// `apiLimiter` tính theo IP với `max: 100/phút`. Pixel mở mail + link click của
// CHIẾN DỊCH LỚN đều đến từ cùng IP của mail client / gateway doanh nghiệp, nên
// 100 request là hạn mức rất thấp: chiến dịch gửi 50k mail sẽ làm hàng loạt
// người nhận mất số liệu OPEN/CLICK (mất bằng chứng marketing). Ngược lại, đây là
// endpoint public không cần đăng nhập nên hạn mức vẫn phải cao hơn API thường —
// chặn brute-force token mà không giết số liệu.
const trackingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.TRACKING_RATE_LIMIT) || 2000,
  standardHeaders: true,
  legacyHeaders: false,
  // Endpoint trả ảnh/HTML, không phải JSON → đừng gắn JSON vào response.
  message: { success: false, message: 'Quá nhiều request, vui lòng thử lại sau' }
})

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

// M7: parse cookies (không cần cookie-parser — chỉ dùng cho refresh token httpOnly)
app.use((req, res, next) => {
  req.cookies = req.cookies || {};
  const header = req.headers.cookie;
  if (header) {
    header.split(';').forEach((pair) => {
      const idx = pair.indexOf('=');
      if (idx > -1) {
        const name = pair.slice(0, idx).trim();
        if (name && !(name in req.cookies)) {
          try {
            req.cookies[name] = decodeURIComponent(pair.slice(idx + 1).trim());
          } catch {
            req.cookies[name] = pair.slice(idx + 1).trim();
          }
        }
      }
    });
  }
  next();
});
app.use(
  "/api/webhooks/delivery",
  express.raw({ type: "application/json" }),
);
app.use(
  "/api/subscriptions/webhook",
  express.raw({ type: "application/json" }),
);
app.use(
  "/api/vietqr/webhook/payos",
  express.raw({ type: "application/json" }),
);
app.use(
  "/api/vietqr/webhook/casso",
  express.raw({ type: "application/json" }),
);
app.use(
  "/api/payment-gateway/webhooks",
  express.raw({ type: "application/json" }),
);
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(require('./middleware/sanitize.middleware')());

app.post("/api/webhooks/delivery/:provider", async (req, res) => {
  try {
    const rawBody =
      req.body instanceof Buffer ? req.body.toString("utf8") : JSON.stringify(req.body);
    const payload = JSON.parse(rawBody);
    const signature = req.headers["x-ghtk-signature"] || req.headers["x-signature"];
    const result = await deliveryService.handleWebhook(
      req.params.provider,
      payload,
      signature,
      rawBody,
      req.headers,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      message: err.message || "Webhook error",
    });
  }
});

if (process.env.NODE_ENV !== "production") {
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}

// ==================== Routes ====================
app.use('/api', apiLimiter)
app.use('/api/auth/login', loginLimiter)
// `apiLimiter` đã `skip` prefix này (xem khai báo), nên chỉ còn trackingLimiter.
app.use('/api/crm/track', trackingLimiter)

app.get("/", (req, res) => {
  res.json({ message: "Aduu - Hệ thống hoạch định nguồn lực doanh nghiệp", version: "2.0.0" });
});

// Health check endpoints
// L7: /api/health public chỉ trả status tối thiểu — /api/health/full chi tiết
// hạ tầng (DB/Redis/Ollama/memory) chỉ dành cho SUPER_OMEGA_ULTRA_ADMIN
app.get("/api/health", async (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.get("/api/health/full", authenticate, requireSuperOmega, async (req, res) => {
  const health = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || "development",
    version: "2.0.0",
    checks: {},
  };

  // Check database
  try {
    const prisma = require("./config/prisma");
    await prisma.$queryRawUnsafe("SELECT 1");
    health.checks.database = { status: "ok" };
  } catch (e) {
    health.checks.database = { status: "error" };
    health.status = "degraded";
  }

  // Check Redis
  try {
    const { redis } = require("./config/redis");
    if (redis && redis.status === "ready") {
      await redis.ping();
      health.checks.redis = { status: "ok" };
    } else {
      health.checks.redis = { status: "not_configured" };
    }
  } catch (e) {
    health.checks.redis = { status: "error" };
    health.status = "degraded";
  }

  // Check Ollama
  try {
    const { checkOllamaHealth } = require("./modules/ai/ai.service");
    health.checks.ollama = await checkOllamaHealth();
    if (health.checks.ollama.status !== "ok") {
      health.status = "degraded";
    }
  } catch (e) {
    health.checks.ollama = { status: "error" };
    health.status = "degraded";
  }

  // Memory usage
  const mem = process.memoryUsage();
  health.checks.memory = {
    rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
    heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
  };

  const statusCode = health.status === "ok" ? 200 : 503;
  res.status(statusCode).json(health);
});

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/returns", returnRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/churn-alerts", churnRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/hr", hrRoutes);
app.use("/api/analytics", analyticsRoutes);
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Qua nhieu request AI, vui long thu lai sau' },
});
app.use("/api/ai/chat", aiLimiter);
app.use("/api/ai/sync", aiLimiter);
app.use("/api/ai", aiRoutes);
app.use("/api/pos", posRoutes);
app.use("/api/agent", agentRoutes);
app.use("/api/llm", llmProxyRoutes);
app.use("/api/db-agent", dbAgentRoutes);
app.use("/api/accounting", accountingRoutes);
app.use("/api/debts", debtRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/purchase-orders", purchaseOrderAliasRoutes);
app.use("/api/grn", grnRoutes);
app.use("/api/purchase-invoices", purchaseInvoiceRoutes);
app.use("/api/promotions", promotionRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/store-credits", storeCreditRoutes);
app.use("/api/serial-numbers", serialNumberRoutes);
app.use("/api/loyalty", loyaltyRoutes);
app.use("/api/deliveries", deliveryRoutes);
app.use("/api/warehouses", warehouseRoutes);
app.use("/api/stock-transfers", stockTransferRoutes);
app.use("/api/import", importRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin", backupRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/crm", crmRoutes);
// PRM: đặt SAU `/api/crm` và dùng đường dẫn không chồng lẫn, để thêm ba prefix
// /api/partners, /api/partner-referrals, /api/partner-roi (gom trong index.js).
app.use("/api/partners", partnerRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/production", productionRoutes);
app.use("/api/einvoice", einvoiceRoutes);
app.use("/api/tax-reports", taxReportRoutes);
app.use("/api/bank-reco", bankRecoRoutes);
app.use("/api/bank-accounts", bankAccountRoutes);
app.use("/api/vietqr", vietqrRoutes);
app.use("/api/fixed-assets", fixedAssetsRoutes);
app.use("/api/currencies", currencyRoutes);
app.use("/api/marketplace", marketplaceRoutes);
app.use("/api/report-builder", reportBuilderRoutes);
app.use("/api/workflows", workflowRoutes);
app.use("/api/portal", portalRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/webhook", webhookLeadRoutes);
app.use("/api/smart-guide", smartGuideRoutes);
app.use("/api/replenishment", replenishmentRoutes);
app.use("/api/menu", menuRoutes);
app.use("/api/tables", tableRoutes);
app.use("/api/kds", kdsRoutes);
app.use("/api/printers", printerRoutes);
app.use("/api/qr-ordering", qrOrderingRoutes);
app.use("/api/payment-gateway", paymentGatewayRoutes);
app.use("/api/food-delivery", foodDeliveryRoutes);
app.use("/api/recipes", recipeRoutes);
app.use("/api/stamp-cards", stampCardRoutes);
// Alias: frontend + Swagger đang gọi dạng số ít (/api/recipe, /api/stamp-card) → thiếu alias
// thì Recipes.jsx / StampCards.jsx gặp 404 dù route đã mount.
app.use("/api/recipe", recipeRoutes);
app.use("/api/stamp-card", stampCardRoutes);
app.use("/api/ai-forecast", aiForecastRoutes);
app.use("/api/petty-cash", pettyCashRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/bulk", bulkRoutes);
app.use("/api/documents", documentRoutes);
// HERMES agent ops (2026-10): ChatOps Telegram + memory + NL-schedule + skill + dept budget
app.use("/api/chatops", require("./modules/chatops/telegram.routes"));
app.use("/api/chatops/memory", require("./modules/chatops/memory.routes"));
app.use("/api/chatops/schedules", require("./modules/chatops/nl-schedule.routes"));
app.use("/api/agent-skills", require("./modules/agent-skills/agent-skill.routes"));
app.use("/api/dept-budgets", require("./modules/dept-budget/dept-budget.routes"));

// Sentry error handler (phải trước error middleware)
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} không tồn tại`,
  });
});

// Error handler (phải đặt cuối cùng)
app.use(errorHandler);

// ==================== Start Server ====================
// Khởi động server có xử lý lỗi EADDRINUSE: nếu cổng bị chiếm sẽ thử cổng tiếp theo
const DEFAULT_PORT = Number(process.env.PORT) || 4000; // fallback

// Ghi `VITE_API_URL` vào frontend/.env để frontend dev server biết backend đang chạy ở cổng nào.
const updateFrontendEnv = (port) => {
  try {
    const frontendEnvPath = path.join(__dirname, "..", "frontend", ".env");
    const line = `VITE_API_URL=http://localhost:${port}/api`;

    let content = "";
    if (fs.existsSync(frontendEnvPath)) {
      content = fs.readFileSync(frontendEnvPath, "utf8");
      if (/^VITE_API_URL=.*$/m.test(content)) {
        content = content.replace(/^VITE_API_URL=.*$/m, line);
      } else {
        if (content.length && !content.endsWith("\n")) content += "\n";
        content += line + "\n";
      }
    } else {
      // tạo file nếu chưa có
      content = line + "\n";
    }

    fs.writeFileSync(frontendEnvPath, content, "utf8");
    console.log(`Updated frontend .env -> ${line}`);
  } catch (e) {
    console.warn("Unable to update frontend .env:", e.message);
  }
};

const startServer = async (port, retries = 10) => {
  const p = Number(port);
  const httpServer = http.createServer(app);
  await initSocket(httpServer);

  // Only run cron jobs on a single worker (PM2 instance 0) to avoid N× firing in cluster mode.
  // NODE_APP_INSTANCE is undefined when running outside PM2 (dev / single process).
  const instance = process.env.NODE_APP_INSTANCE;
  const shouldRunCrons = instance === undefined || instance === "0";

  app.locals.port = p;

  const server = httpServer.listen(p, () => {
    if (shouldRunCrons) {
      startCrons();
      startCDC().catch(e => console.error('[app] Failed to start CDC:', e.message));
    } else {
      console.log(`[cron] skipped on worker instance ${instance}`);
    }
    console.log(`\n Aduu ERP Server đang chạy tại: http://localhost:${p}`);
    console.log(` Environment: ${process.env.NODE_ENV || "development"}`);
    console.log("\n API Endpoints:");
    console.log(`  POST   /api/auth/login`);
    console.log(`  GET    /api/auth/me`);
    console.log(`  GET    /api/products`);
    console.log(`  POST   /api/orders`);
    console.log(`  GET    /api/dashboard/overview`);
    console.log(`  POST   /api/inventory/import`);
    console.log(`  GET    /api/inventory/transactions`);
    console.log(`  GET    /api/customers`);
    console.log(`  GET    /api/hr/employees`);
    console.log(`  POST   /api/hr/payrolls/generate`);
    console.log(`  GET    /api/analytics/sales-insights`);
    console.log(`  GET    /api-docs`);
    // Cảnh báo link tracking khi deploy production — CRM Phase 4.
    // Chỉ báo ở production: ở dev thì localhost là đúng, không phải lỗi.
    if (process.env.NODE_ENV === "production") {
      const trackingBase = String(
        process.env.TRACKING_BASE_URL || process.env.CLIENT_URL || "",
      ).trim();
      if (!trackingBase) {
        console.warn(
          "\n[CRM] CẢNH BÁO: chưa đặt TRACKING_BASE_URL / CLIENT_URL.\n" +
            "     Link từ chối nhận tin và link đo lượt mở trong email sẽ trỏ sai,\n" +
            "     khách bấm không được ⇒ vi phạm Nghị định 13/2023.\n" +
            "     Sửa: đặt TRACKING_BASE_URL=https://<domain> trong .env",
        );
      } else if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(trackingBase)) {
        console.warn(
          `\n[CRM] CẢNH BÁO: TRACKING_BASE_URL/CLIENT_URL đang trỏ về ${trackingBase}\n` +
            "     Môi trường production mà trỏ localhost ⇒ mọi link trong email gửi đi\n" +
            "     đều không mở được. Sửa .env rồi khởi động lại server.",
        );
      }
    }
    // Cập nhật frontend/.env để frontend dev biết API URL (chỉ cho môi trường dev)
    try {
      updateFrontendEnv(p);
    } catch (e) {
      // không block server nếu không thể ghi file
    }
  });

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.warn(`Port ${p} is already in use.`);
      if (retries > 0) {
        console.log(`Trying port ${p + 1}... (${retries - 1} retries left)`);
        startServer(p + 1, retries - 1);
      } else {
        console.error(
          "No available ports found. Please free the port or set PORT in .env.",
        );
        process.exit(1);
      }
    } else {
      console.error("Server error:", err);
      process.exit(1);
    }
  });
};

startServer(DEFAULT_PORT).catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

module.exports = app;
