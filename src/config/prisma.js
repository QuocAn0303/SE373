/**
 * config/prisma.js — Prisma Client + Multi-tenant auto-scoping
 *
 * - Prisma extension ($extends) auto-inject tenantId vào mọi query
 * - tenantId lấy từ AsyncLocalStorage (tenantContext.js) → set bởi tenant.middleware
 * - SUPER_OMEGA_ULTRA_ADMIN: bypass scoping (xem tất cả tenant)
 * - Model không có tenantId column → KHÔNG bị scope (tránh crash)
 *
 * Cơ chế:
 *   findMany/findFirst/findUnique/count → where: { ...where, tenantId }
 *   create/createMany → data: { ...data, tenantId }
 *   update/updateMany/delete/deleteMany → where: { ...where, tenantId }
 *   upsert → where + create
 */
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
const { getTenantId, isBypassTenant } = require("./tenantContext");
const logger = require("../utils/logger");

const url = new URL(process.env.DATABASE_URL);
const pool = new Pool({
  host: url.hostname,
  port: parseInt(url.port || "5432"),
  database: url.pathname.slice(1).split("?")[0],
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  max: Number(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

const adapter = new PrismaPg(pool);
const basePrisma = new PrismaClient({ adapter });

const TENANT_SCOPED_MODELS = new Set([
  "Product", "Category", "Customer", "Order", "OrderItem", "OrderItemModifier",
  "Inventory", "InventoryTransaction", "Warehouse", "Vendor",
  "BankAccount", "BankTransaction", "BankStatement", "BankStatementLine",
  "Expense", "ExpenseCategory", "Debt", "DebtPayment",
  "Promotion", "PromotionUsage", "Invoice", "Payment",
  "CompanySettings", "TaxRate",
  "Employee", "Shift", "Payroll", "Violation", "OvertimeRequest", "TimeEntry",
  "JournalEntry", "JournalLine", "FiscalPeriod",
  "FixedAsset", "FixedAssetCategory", "DepreciationSchedule",
  "PettyCashTransaction", "PrepaidExpense", "RecurringExpenseLog",
  "JournalPostingError",
  "Area", "DinerTable", "TableSession", "Reservation",
  "KdsStation", "KdsTicket",
  "ModifierGroup", "ModifierOption", "ProductVariant", "Combo", "ComboItem",
  "Recipe", "RecipeIngredient", "WasteLog",
  "StampCard", "StampCardTemplate",
  "Printer", "ReturnLineItem",
  "Department", "InternalDocument",
  "FoodDeliveryOrder", "QrOrderSession",
  "BillSplit", "BillSplitItem",
  "Delivery", "DeliveryEvent",
  "PurchaseOrder", "PurchaseItem",
  "StockTransfer", "StockTransferItem",
  "CycleCount", "CycleCountItem",
  "SerialNumber", "InventoryLot", "LotTransaction",
  "ElectronicInvoice",
  "LoyaltyTransaction", "StoreCreditTransaction",
  "CustomerNote", "CustomerTag", "CustomerTagOnCustomer", "CustomerTask", "CustomerSegment",
  "CampaignRecipient", "CampaignTracking", "CustomerCampaign",
  "MarketplaceListing", "MarketplaceSyncLog", "MarketplaceShop",
  "Notification",
  "OrderReturn",
  "QualityCheck", "QualityCheckItem",
  "WorkCenter", "Routing", "RoutingOperation", "WorkOrder", "WorkOrderItem",
  "Bom", "BomItem",
  "Project", "ProjectInvoice", "ProjectMember", "ProjectTask",
  "AiForecast", "AiRecommendation",
  "ReportSchedule", "SavedReport",
  "PortalSession", "PortalOtp",
  "IntegrationConfig",
  "WebhookEndpoint",
  "Workflow", "WorkflowApproval", "WorkflowRun", "WorkflowStep",
  "User", "AgentSession", "SupportAccessSession", "TenantSubscription", "SubscriptionInvoice",
  "AuditLog", "AgentStep", "AgentHumanGate", "AgentFeedback", "BackupCode", "WebhookDelivery",
  "RefreshToken",
  // CRM/SRM upgrade (2026-09): churn win-back + 3-way matching + GRN
  "ChurnAlert", "GoodsReceiptNote", "GoodsReceiptItem", "PurchaseInvoiceRecord",
  // PRM (2026-10): quản trị đối tác đầu ra. KHÁC `Vendor` — đó là nhà cung cấp
  // đầu vào phía SRM. Hai bảng này có `tenantId` nên bắt buộc phải khai báo ở
  // đây, nếu không `tests/tenant-scoped-models.contract.test.js` chặn.
  "Partner", "PartnerReferral",
  // HERMES agent ops (2026-10): ChatOps + memory + skill + dept budget.
  // Tất cả có tenantId → bắt buộc khai báo, nếu không fail-fast lúc boot.
  "ChatBinding", "AgentMemory", "AgentSkill", "DeptBudget",
  // CRM Sales Pipeline (2026-09): Lead / Deal / Organization / Contact
  "CrmPipelineStage", "CrmLead", "CrmOrganization", "CrmContact",
  "CrmDeal", "CrmDealItem", "CrmCommunication",
  // CRM audit C5: AiDocument là model DUY NHẤT có cột `tenantId` mà chưa khai báo ở
  // đây (đã đối chiếu toàn bộ schema). Model hiện `@@ignore` nên extension chưa có tác
  // dụng gì — nhưng đăng ký sẵn để khi ai gỡ `@@ignore` thì đã được scope, không phải
  // phát hiện lúc rò dữ liệu. `AiEmbedding` không có `tenantId` nên không cần.
  // `tests/tenant-scoped-models.contract.test.js` chặn tái phát.
  "AiDocument",
  // T13 (2026-10-03): sổ ghi token LLM. CÓ `tenantId` nên bắt buộc phải khai báo ở
  // đây — đây là lý do model này chưa thể tồn tại mà không có bước scope. Ghi vào
  // bảng này KHÔNG phải quyết định nghiệp vụ: không đường mã nào đọc nó để tính
  // ROP/đặt hàng (01-llm-role.md §1). `tenantId = NULL` vẫn ghi được (lần gọi ngoài
  // tenant context) — cần để phân biệt "lỗi" với "không thuộc tenant nào".
  "LlmUsageLog",
]);

const READ_OPS = new Set([
  "findMany", "findFirst", "findFirstOrThrow",
  "findUnique", "findUniqueOrThrow", "count", "aggregate", "groupBy",
]);
const WHERE_OPS = new Set([
  "update", "updateMany", "delete", "deleteMany", "upsert",
]);
const DATA_OPS = new Set([
  "create", "createMany", "createManyAndReturn", "upsert",
]);

/**
 * Metadata model của Prisma client: `model -> danh sách field`.
 *
 * Nguồn: `_runtimeDataModel` (`models.<Model>.fields` là MẢNG field, mỗi field có
 * `name`, `kind` (`"scalar"` | `"object"` | ...), `type`, `relationName`).
 * Có fallback về `dmmf` cho client đời khác.
 *
 * Không đọc được ⇒ ném lỗi. Lý do: im lặng quay về "không tiêm tenantId cho
 * nested write" đúng là tạo ra `tenantId = NULL` — tức mất cách ly tenant ở
 * chính cách ghi. Kiểm tra phải fail-fast lúc khởi động, không phải lúc ghi.
 */
const readModelMetadata = () => {
  const models =
    basePrisma._runtimeDataModel?.models ||
    basePrisma.dmmf?.datamodel?.models ||
    null;
  if (!models) {
    throw new Error(
      "[prisma] KHÔNG đọc được metadata model của Prisma client → không thể đảm bảo " +
        "tenantId cho ghi lồng. Backend bị từ chối khởi động (fail-fast) để không ghi " +
        "dữ liệu tenantId = NULL. Kiểm tra phiên bản Prisma client.",
    );
  }

  const entries =
    models instanceof Map ? Array.from(models.entries()) : Object.entries(models);

  /** @type {Map<string, Array<object>>} */
  const modelFields = new Map();
  /** @type {Map<string, Map<string, string>>} model -> (tên field quan hệ -> model con) */
  const relations = new Map();

  for (const [modelName, model] of entries) {
    const raw = model?.fields;
    const fieldList = Array.isArray(raw) ? raw : Object.values(raw || {});
    modelFields.set(modelName, fieldList);

    const rel = new Map();
    for (const field of fieldList) {
      // Quan hệ 1-1 và 1-n đều cần: `Order.items` là list nhưng vẫn phải scope.
      if (field && field.kind === "object" && field.relationName && field.type) {
        rel.set(field.name, field.type);
      }
    }
    relations.set(modelName, rel);
  }

  return { modelFields, relations };
};

const { modelFields: MODEL_FIELDS, relations: RELATION_FIELD_TO_MODEL } = readModelMetadata();

/**
 * Kiểm tra fail-fast lúc khởi động (D1).
 *
 * Gom MỌI vấn đề rồi ném một lần, để lần chạy đầu tiên đã biết hết lỗi thay vì
 * phải vá dần từng lỗi một.
 */
const assertTenantScopingReady = () => {
  const problems = [];
  const models = new Set(MODEL_FIELDS.keys());
  // Hàm này được gọi cả lúc nạp module lẫn trong test ⇒ phải xoá kết quả lần
  // trước, nếu không danh sách sẽ tích luỹ và log sai.
  unverifiableScopedModels.length = 0;

  for (const model of TENANT_SCOPED_MODELS) {
    if (!models.has(model)) {
      // Model không có trong client (ví dụ `@@ignore`): Prisma không sinh thao
      // tác nào cho nó nên extension không thể chạm tới. KHÔNG phải lỗi metadata,
      // nhưng phải hiện tên ra chứ không được giấu — nếu sau này bỏ `@@ignore`
      // thì phải khai báo lại. Việc quét/vá dữ liệu của bảng này do
      // `scripts/tenant-null.js` đọc thẳng `information_schema` đảm nhiệm.
      unverifiableScopedModels.push(model);
      continue;
    }
    const hasTenantColumn = MODEL_FIELDS.get(model).some((f) => f.name === "tenantId");
    if (!hasTenantColumn) {
      problems.push(`${model}: khai báo trong TENANT_SCOPED_MODELS nhưng không có field "tenantId"`);
    }
    for (const [fieldName, childModel] of RELATION_FIELD_TO_MODEL.get(model) || []) {
      if (!models.has(childModel)) {
        problems.push(`${model}.${fieldName}: quan hệ trỏ tới model không tồn tại "${childModel}"`);
      }
    }
  }

  // Chiều ngược: model nào CÓ cột tenantId mà chưa khai báo scoped thì sẽ tiêm
  // ở tầng trên nhưng không bao giờ được lọc khi đọc ⇒ cùng một lớp lỗi NULL.
  for (const [model, fields] of MODEL_FIELDS) {
    if (fields.some((f) => f.name === "tenantId") && !TENANT_SCOPED_MODELS.has(model)) {
      problems.push(`${model}: có field "tenantId" nhưng CHƯA khai báo trong TENANT_SCOPED_MODELS`);
    }
  }

  if (problems.length) {
    throw new Error(
      "[prisma] Kiểm tra cách ly tenant THẤT BẠI — backend bị từ chối khởi động (fail-fast):\n  - "
        + problems.join("\n  - "),
    );
  }

  if (unverifiableScopedModels.length) {
    logger.warn(
      `[prisma] ${unverifiableScopedModels.length} model trong TENANT_SCOPED_MODELS không có trong Prisma client ` +
        `(thường do \`@@ignore\`) nên extension không áp dụng được: ${unverifiableScopedModels.join(", ")}. ` +
        "Bảng tương ứng phải được quét/vá bằng scripts/tenant-null.js.",
    );
  }
};

/** Model khai báo scoped nhưng không có trong client (xem `assertTenantScopingReady`). */
const unverifiableScopedModels = [];

// Chạy NGAY khi module nạp: backend không được khởi động với cấu hình scoping hỏng.
assertTenantScopingReady();

/**
 * Tiêm `tenantId` đệ quy vào payload ghi lồng nhau.
 *
 * VÌ SAO CẦN: extension chỉ gắn `tenantId` vào `data` cấp ngoài cùng. Với
 * `order.create({ data: { items: { create: [...] } } })` thì các dòng
 * `OrderItem` sinh ra có `tenantId = NULL`, trong khi mọi truy vấn đọc lại
 * đều lọc `tenantId` ⇒ dữ liệu vừa ghi xong biến mất khỏi phạm vi tenant
 * (đã quan sát 84/242 `order_items` bị NULL trên DB thật).
 *
 * Cấu trúc Prisma: `data.<tên quan hệ>.<write-op>`. `key` ở đây là TÊN QUAN HỆ,
 * còn `value` là object/array mô tả thao tác ghi bên trong.
 *
  * Bản sửa dùng metadata runtime để chỉ tiêm vào con thực sự thuộc
 * `TENANT_SCOPED_MODELS`, và **từ chối ghi** khi không xác định được model cha
 * (D1) — im lặng bỏ qua ở đây chính là cách sinh ra `tenantId = NULL`.
 *
 * @param {string} parentModel model đang ghi ở cấp hiện tại
 * @param {object} node       payload của cấp đó
 * @param {string} tenantId
 * @returns {object} payload đã sửa (trả về object mới, không mutate input)
 * @throws {Error} khi `parentModel` không có trong metadata
 */
const withNestedTenant = (parentModel, node, tenantId) => {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    return node.map((item) => withNestedTenant(parentModel, item, tenantId));
  }

  const relationFields = RELATION_FIELD_TO_MODEL.get(parentModel);
  if (!relationFields) {
    throw new Error(
      `[prisma] Không xác định được metadata của model "${parentModel}" → KHÔNG ghi lồng ` +
        "(sẽ sinh tenantId = NULL, tức mất cách ly tenant). " +
        "Kiểm tra model này còn trong schema/client, hoặc thêm nó vào xử lý riêng.",
    );
  }

  const out = { ...node };

  for (const [key, value] of Object.entries(out)) {
    const childModel = relationFields.get(key);
    if (!childModel || !TENANT_SCOPED_MODELS.has(childModel)) continue;
    if (!value || typeof value !== "object") continue;

    if (Array.isArray(value)) {
      // `{ items: [ ... ] }` không phải dạng write hợp lệ, bỏ qua.
      continue;
    }

    const next = { ...value };

    // Gắn `tenantId` vào MỘT dòng con rồi recurse tiếp xuống quan hệ của dòng
    // đó (ví dụ `OrderItem.modifiers`), vì nếu chỉ gắn mà không recurse thì
    // tầng sau lại rơi vào `tenantId = NULL`.
    const stampRow = (row) => {
      if (!row || typeof row !== "object") return row;
      const withTenant = row.tenantId ? row : { ...row, tenantId };
      return withNestedTenant(childModel, withTenant, tenantId);
    };

    if (next.create && typeof next.create === "object") {
      // `{ create: [row, ...] }` (quan hệ 1-n) hoặc `{ create: {...} }` (quan hệ 1-1):
      // trong cả hai trường hợp, mỗi phần tử/object đó LÀ một dòng của model con.
      next.create = Array.isArray(next.create)
        ? next.create.map(stampRow)
        : stampRow(next.create);
    }

    for (const bulkKey of ["createMany", "createManyAndReturn"]) {
      if (Array.isArray(next[bulkKey])) {
        next[bulkKey] = next[bulkKey].map(
          (d) => (d && typeof d === "object" && !d.tenantId ? { ...d, tenantId } : d),
        );
      }
    }

    // `connectOrCreate` và `upsert` đều có nhánh `create` sinh dòng mới ⇒ phải
    // gắn `tenantId` vào đó, và `upsert.create` còn có thể chứa tiếp ghi lồng.
    const stampCreateBranch = (entry) => {
      if (!entry || typeof entry !== "object" || !entry.create || typeof entry.create !== "object") {
        return entry;
      }
      const e2 = { ...entry };
      e2.create = Array.isArray(e2.create) ? e2.create.map(stampRow) : stampRow(e2.create);
      if (e2.update && typeof e2.update === "object") {
        e2.update = withNestedTenant(childModel, e2.update, tenantId);
      }
      return e2;
    };

    if (Array.isArray(next.connectOrCreate)) {
      next.connectOrCreate = next.connectOrCreate.map(stampCreateBranch);
    }
    if (next.upsert && typeof next.upsert === "object") {
      next.upsert = stampCreateBranch(next.upsert);
    }
    // `update` / `updateMany` lồng: `data` là payload của dòng con nên xử lý
    // tiếp các ghi lồng bên trong nó.
    for (const nestedOp of ["update", "updateMany"]) {
      const spec = next[nestedOp];
      if (spec && typeof spec === "object" && spec.data && typeof spec.data === "object") {
        next[nestedOp] = { ...spec, data: withNestedTenant(childModel, spec.data, tenantId) };
      }
    }

    out[key] = next;
  }
  return out;
};

const prisma = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const tenantId = getTenantId();
        const bypass = isBypassTenant();

        if (!tenantId || bypass || !TENANT_SCOPED_MODELS.has(model)) {
          return query(args);
        }

        if (!args) args = {};

        if (READ_OPS.has(operation)) {
          args.where = { ...args.where, tenantId };
        } else if (WHERE_OPS.has(operation)) {
          if (args.where) args.where = { ...args.where, tenantId };
          if (operation === "upsert") {
            if (args.create && !args.create.tenantId) {
              args.create = { ...args.create, tenantId };
            }
            if (args.create) args.create = withNestedTenant(model, args.create, tenantId);
            // Nhánh `update` của upsert cũng có thể chứa `create` lồng, ví dụ
            // `order.upsert({ update: { items: { create: [...] } } })`.
            if (args.update && typeof args.update === "object") {
              args.update = withNestedTenant(model, args.update, tenantId);
            }
          } else if ((operation === "update" || operation === "updateMany") && args.data) {
            // `update` cũng nhận nested write (`data: { items: { create: [...] } }`)
            // và trước đây không hề được xử lý ⇒ sinh con `tenantId = NULL`.
            // Không gắn `tenantId` vào `data` cấp ngoài: đó là dữ liệu đang sửa,
            // `where` đã khoanh vùng tenant rồi.
            args.data = withNestedTenant(model, args.data, tenantId);
          }
        } else if (DATA_OPS.has(operation)) {
          if (operation === "create" && args.data) {
            if (!args.data.tenantId) args.data = { ...args.data, tenantId };
            // Dữ liệu con ghi bằng nested write cũng phải mang tenantId.
            args.data = withNestedTenant(model, args.data, tenantId);
          } else if (operation === "createMany" || operation === "createManyAndReturn") {
            if (Array.isArray(args.data)) {
              args.data = args.data.map((d) => (d.tenantId ? d : { ...d, tenantId }));
            }
          } else if (operation === "upsert") {
            if (args.where) args.where = { ...args.where, tenantId };
            if (args.create && !args.create.tenantId) {
              args.create = { ...args.create, tenantId };
            }
            if (args.create) args.create = withNestedTenant(model, args.create, tenantId);
          }
        }

        return query(args);
      },
    },
  },
});

module.exports = prisma;

// Nội bộ, phục vụ test — không dùng ở nơi khác.
module.exports.__internals = {
  withNestedTenant,
  assertTenantScopingReady,
  RELATION_FIELD_TO_MODEL,
  MODEL_FIELDS,
  TENANT_SCOPED_MODELS,
  getUnverifiableScopedModels: () => [...unverifiableScopedModels],
};
