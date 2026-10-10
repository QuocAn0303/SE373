/**
 * tests/chatops-foundation.test.js — Phase 0 (HERMES)
 * Policy mode, tenant isolation, LlmUsageLog ghi đủ provider/model/tokens.
 */
const fs = require('fs');
const path = require('path');

describe('chatops foundation (Phase 0)', () => {
  test('schema có 4 model Hermes + User.departmentId + ReportSchedule.channel', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
    for (const m of ['model ChatBinding', 'model AgentMemory', 'model AgentSkill', 'model DeptBudget']) {
      expect(src).toMatch(m);
    }
    expect(src).toMatch(/departmentId String\?/);
    expect(src).toMatch(/channel\s+String/);
  });

  test('TENANT_SCOPED_MODELS chứa 4 model mới', () => {
    const { TENANT_SCOPED_MODELS } = require('../src/config/prisma').__internals;
    for (const m of ['ChatBinding', 'AgentMemory', 'AgentSkill', 'DeptBudget']) {
      expect(TENANT_SCOPED_MODELS.has(m)).toBe(true);
    }
  });

  test('static guard: notification type/severity đúng enum (smoke-chatops từng bắt AI_ACTION/SUCCESS)', () => {
    // Quét thuần Node (không phụ thuộc rg/shell): type AI_ACTION và severity SUCCESS
    // không tồn tại trong enum NotificationType/NotificationSeverity.
    const roots = ['src/modules/chatops', 'src/modules/ai', 'src/modules/agent-skills', 'src/modules/dept-budget', 'src/middleware'];
    const bad = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.name.endsWith('.js')) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (/type:\s*['"]AI_ACTION['"]/.test(src)) bad.push(`${full}: AI_ACTION`);
        if (/severity:\s*['"]SUCCESS['"]/.test(src)) bad.push(`${full}: SUCCESS`);
      }
    };
    roots.forEach((r) => walk(path.join(__dirname, '..', r)));
    expect(bad).toEqual([]);
  });

  test('llm config hỗ trợ openai-compatible + reasoning tách content', async () => {
    const old = { ...process.env };
    process.env.LLM_PROVIDER = 'openai-compatible';
    process.env.LLM_BASE_URL = 'https://llm.uit.edu.vn/gemma/v1';
    process.env.LLM_MODEL = 'gemma-4-26b';
    process.env.LLM_REASONING_BASE_URL = 'https://llm.uit.edu.vn/qwen/v1';
    process.env.LLM_REASONING_MODEL = 'qwen3.8-27b';
    jest.resetModules();
    const llm = require('../src/config/llm');
    expect(llm.config().provider).toBe('openai-compatible');
    expect(llm.reasoningConfig()).toMatchObject({ model: 'qwen3.8-27b' });
    expect(await llm.listModels()).toContain('gemma-4-26b');
    Object.assign(process.env, old);
    jest.resetModules();
  });
});
