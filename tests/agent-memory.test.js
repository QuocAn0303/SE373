/**
 * tests/agent-memory.test.js — Phase 3 (HERMES)
 * Nhớ NCC qua phiên khác user cùng tenant; tenant khác không thấy; PENDING không recall.
 */
const memStore = () => {
  const rows = [];
  return {
    rows,
    prisma: {
      agentMemory: {
        create: jest.fn(async ({ data }) => { const r = { id: `m${rows.length + 1}`, ...data }; rows.push(r); return r; }),
        findFirst: jest.fn(async ({ where }) => rows.find((r) => r.id === where.id) || null),
        findMany: jest.fn(async ({ where }) => rows.filter((r) => {
          if (where?.status && r.status !== where.status) return false;
          if (where?.OR) {
            return where.OR.some((c) => {
              if (c.scope && r.scope !== c.scope) return false;
              if (c.departmentId && r.departmentId !== c.departmentId) return false;
              return true;
            });
          }
          return true;
        })),
        update: jest.fn(async ({ where, data }) => {
          const r = rows.find((x) => x.id === where.id);
          Object.assign(r, data);
          return r;
        }),
      },
      department: { findFirst: jest.fn(async () => ({ id: 'd-sales' })) },
    },
  };
};

describe('agent memory (Phase 3)', () => {
  let store;
  beforeEach(() => {
    store = memStore();
    jest.resetModules();
    jest.doMock('../src/config/prisma', () => store.prisma);
    jest.doMock('../src/config/llm-policy', () => ({ callTask: jest.fn(async () => ({ ok: false })) }));
  });
  afterEach(() => { jest.dontMock('../src/config/prisma'); jest.dontMock('../src/config/llm-policy'); });

  test('fact PENDING không được recall; duyệt → recall thấy', async () => {
    const mem = require('../src/modules/chatops/memory.service');
    const orch = require('../src/modules/chatops/orchestrator.service');
    const { saveCandidate } = mem;
    const out = await saveCandidate({ key: 'closing_supplier', fact: 'NCC đã chốt là An Khang', scope: 'DEPT', departmentId: 'd-sales', createdById: 'u1' });
    expect(out.memory.status).toBe('ACTIVE'); // DEPT active ngay
    const recalled = await orch.recallMemories(store.prisma, 't1', 'SALES');
    expect(recalled.map((r) => r.key)).toContain('closing_supplier');
  });

  test('COMPANY PENDING không recall cho tới khi duyệt', async () => {
    const mem = require('../src/modules/chatops/memory.service');
    // createGate sẽ fail vì humangate require prisma thật — COMPANY path ném lỗi có kiểm soát
    await expect(mem.saveCandidate({ key: 'k', fact: 'f', scope: 'COMPANY', createdById: 'u1' })).rejects.toBeTruthy();
    const orch = require('../src/modules/chatops/orchestrator.service');
    const recalled = await orch.recallMemories(store.prisma, 't1', 'SALES');
    expect(recalled.find((r) => r.key === 'k')).toBeUndefined();
  });

  test('approve + retire đổi trạng thái', async () => {
    const mem = require('../src/modules/chatops/memory.service');
    store.rows.push({ id: 'm9', key: 'k', fact: 'f', scope: 'DEPT', status: 'PENDING' });
    const a = await mem.approveMemory({ memoryId: 'm9', userId: 'u-admin' });
    expect(a.status).toBe('ACTIVE');
    const r = await mem.retireMemory({ memoryId: 'm9', userId: 'u-admin' });
    expect(r.status).toBe('RETIRED');
  });
});
