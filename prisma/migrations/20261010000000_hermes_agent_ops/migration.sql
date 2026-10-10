-- HERMES agent ops (2026-10-10) — Phase 0..6: ChatOps Telegram + memory + skill + dept budget
--
-- ADDITIVE, idempotent từng phần (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- Không xoá bảng/cột. Enum tạo trước khi dùng (giống chuẩn PRM 20261008130000).

-- ── 1. Enum ──────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AgentMemoryStatus') THEN
        CREATE TYPE "AgentMemoryStatus" AS ENUM ('PENDING', 'ACTIVE', 'RETIRED');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AgentMemoryScope') THEN
        CREATE TYPE "AgentMemoryScope" AS ENUM ('COMPANY', 'DEPT');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AgentSkillStatus') THEN
        CREATE TYPE "AgentSkillStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'DISABLED');
    END IF;
END $$;

-- ── 2. Department.code (định danh phòng ban ổn định cho routing agent) ────
ALTER TABLE "departments" ADD COLUMN IF NOT EXISTS "code" TEXT;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'departments_tenantId_code_key'
    ) THEN
        ALTER TABLE "departments" ADD CONSTRAINT "departments_tenantId_code_key" UNIQUE ("tenantId", "code");
    END IF;
END $$;

-- ── 3. users.departmentId (binding trực tiếp, song song employees.departmentId)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "departmentId" TEXT;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_departmentId_fkey') THEN
        ALTER TABLE "users" ADD CONSTRAINT "users_departmentId_fkey"
            FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS "users_departmentId_idx" ON "users"("departmentId");

-- ── 4. chat_bindings (Phase 1 — Telegram OTP binding + idempotency update_id)
CREATE TABLE IF NOT EXISTS "chat_bindings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'TELEGRAM',
    "externalUserId" TEXT NOT NULL,
    "chatId" TEXT,
    "otpCode" TEXT,
    "otpExpiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUpdateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_bindings_userId_fkey') THEN
        ALTER TABLE "chat_bindings" ADD CONSTRAINT "chat_bindings_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_bindings_provider_externalUserId_key') THEN
        ALTER TABLE "chat_bindings" ADD CONSTRAINT "chat_bindings_provider_externalUserId_key" UNIQUE ("provider", "externalUserId");
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_bindings_tenantId_userId_provider_key') THEN
        ALTER TABLE "chat_bindings" ADD CONSTRAINT "chat_bindings_tenantId_userId_provider_key" UNIQUE ("tenantId", "userId", "provider");
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS "chat_bindings_tenantId_idx" ON "chat_bindings"("tenantId");
CREATE INDEX IF NOT EXISTS "chat_bindings_otpCode_idx" ON "chat_bindings"("otpCode");

-- ── 5. agent_memories (Phase 3)
CREATE TABLE IF NOT EXISTS "agent_memories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT,
    "scope" "AgentMemoryScope" NOT NULL DEFAULT 'COMPANY',
    "departmentId" TEXT,
    "key" TEXT NOT NULL,
    "fact" TEXT NOT NULL,
    "sourceSessionId" TEXT,
    "status" "AgentMemoryStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_memories_departmentId_fkey') THEN
        ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_departmentId_fkey"
            FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS "agent_memories_tenant_status_scope_idx" ON "agent_memories"("tenantId", "status", "scope");
CREATE INDEX IF NOT EXISTS "agent_memories_tenant_dept_status_idx" ON "agent_memories"("tenantId", "departmentId", "status");

-- ── 6. agent_skills (Phase 4)
CREATE TABLE IF NOT EXISTS "agent_skills" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "departmentScope" TEXT,
    "departmentId" TEXT,
    "handlerRef" TEXT,
    "status" "AgentSkillStatus" NOT NULL DEFAULT 'DRAFT',
    "testReport" JSONB,
    "examples" JSONB,
    "createdById" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_skills_departmentId_fkey') THEN
        ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_departmentId_fkey"
            FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_skills_tenantId_code_version_key') THEN
        ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_tenantId_code_version_key" UNIQUE ("tenantId", "code", "version");
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS "agent_skills_tenant_status_idx" ON "agent_skills"("tenantId", "status");

-- ── 7. dept_budgets (Phase 5)
CREATE TABLE IF NOT EXISTS "dept_budgets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT,
    "departmentId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "limit" DECIMAL(15,2) NOT NULL,
    "spent" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dept_budgets_departmentId_fkey') THEN
        ALTER TABLE "dept_budgets" ADD CONSTRAINT "dept_budgets_departmentId_fkey"
            FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dept_budgets_tenantId_departmentId_month_year_key') THEN
        ALTER TABLE "dept_budgets" ADD CONSTRAINT "dept_budgets_tenantId_departmentId_month_year_key"
            UNIQUE ("tenantId", "departmentId", "month", "year");
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS "dept_budgets_tenant_month_year_idx" ON "dept_budgets"("tenantId", "month", "year");

-- ── 8. report_schedules: NL-schedule (Phase 6)
ALTER TABLE "report_schedules" ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'EMAIL';
ALTER TABLE "report_schedules" ADD COLUMN IF NOT EXISTS "telegramChatId" TEXT;
ALTER TABLE "report_schedules" ADD COLUMN IF NOT EXISTS "template" TEXT;
ALTER TABLE "report_schedules" ADD COLUMN IF NOT EXISTS "nlQuery" TEXT;
ALTER TABLE "report_schedules" ADD COLUMN IF NOT EXISTS "createdById" TEXT;
CREATE INDEX IF NOT EXISTS "report_schedules_active_next_idx" ON "report_schedules"("isActive", "nextRunAt");
