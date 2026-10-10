/**
 * scripts/check-hermes.js — Kiểm tra triển khai HERMES agent ops (không cần DB sống cho phần 1-3)
 *
 * 1. schema.prisma có 4 model mới + User.departmentId + ReportSchedule.channel
 * 2. TENANT_SCOPED_MODELS chứa 4 model mới
 * 3. Mọi module chatops/skills/budget load được (require thật)
 * 4. (DB sống, tùy chọn) bảng/cột tồn tại — thiếu thì báo chạy migrate hermes
 *
 * Dùng: node scripts/check-hermes.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); fail += 1; };

(async () => {
  const ROOT = path.join(__dirname, '..');
  const schema = fs.readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8');

  console.log('=== 1. schema.prisma ===');
  for (const m of ['model ChatBinding', 'model AgentMemory', 'model AgentSkill', 'model DeptBudget', 'departmentId String?', 'channel        String']) {
    if (schema.includes(m)) ok(`có "${m}"`);
    else bad(`thiếu "${m}"`);
  }

  console.log('=== 2. tenant scoping ===');
  const { TENANT_SCOPED_MODELS } = require('../src/config/prisma').__internals;
  for (const m of ['ChatBinding', 'AgentMemory', 'AgentSkill', 'DeptBudget']) {
    if (TENANT_SCOPED_MODELS.has(m)) ok(`${m} đã scope`);
    else bad(`${m} CHƯA scope`);
  }

  console.log('=== 3. module load ===');
  const mods = [
    '../src/modules/chatops/telegram.service',
    '../src/modules/chatops/orchestrator.service',
    '../src/modules/chatops/telegram.routes',
    '../src/modules/chatops/memory.service',
    '../src/modules/chatops/memory.routes',
    '../src/modules/chatops/nl-schedule.service',
    '../src/modules/chatops/nl-schedule.routes',
    '../src/modules/chatops/dept',
    '../src/modules/agent-skills/agent-skill.service',
    '../src/modules/agent-skills/agent-skill.routes',
    '../src/modules/dept-budget/dept-budget.service',
    '../src/modules/dept-budget/dept-budget.routes',
    '../src/middleware/dept.middleware',
    '../src/modules/ai/cited-qa.service',
    '../src/modules/ai/internal-doc-ingest.service',
    '../src/modules/ai/agent-eval.service',
  ];
  for (const m of mods) {
    try {
      const mod = require(m);
      const empty = mod && typeof mod === 'object' && Object.keys(mod).length === 0;
      if (empty) bad(`${m} export rỗng`);
      else ok(m.replace('../src/', ''));
    } catch (e) { bad(`${m} → ${e.message.split('\n')[0]}`); }
  }

  console.log('=== 4. DB (tùy chọn) ===');
  try {
    const prisma = require('../src/config/prisma');
    const tables = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('chat_bindings','agent_memories','agent_skills','dept_budgets')`,
    );
    const have = new Set(tables.map((t) => t.tablename));
    for (const t of ['chat_bindings', 'agent_memories', 'agent_skills', 'dept_budgets']) {
      if (have.has(t)) ok(`bảng ${t}`);
      else bad(`thiếu bảng ${t} — chạy: npx prisma migrate deploy`);
    }
    await prisma.$disconnect().catch(() => null);
  } catch (e) {
    console.log(`  … bỏ qua DB: ${e.message.split('\n')[0]}`);
  }

  console.log(fail ? `\n${fail} mục HỎNG` : '\n✓ HERMES check xanh');
  process.exit(fail ? 1 : 0);
})();
