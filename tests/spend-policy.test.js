/**
 * tests/spend-policy.test.js — Phase 5 (HERMES)
 * Vượt envelope chặn/escalate; checkSpend trả approver chain đúng ngưỡng 5tr/50tr;
 * addSpent dùng increment (chống mất tiền khi hai lần duyệt chạy song song).
 */
const budgetStore = (limit, spent) => {
  const calls = { updates: [] };
  const prisma = {
    deptBudget: {
      // upsert là đường duy nhất `envelope()` dùng (chống race findFirst→create).
      upsert: jest.fn(async () => ({ id: 'b1', limit, spent })),
      findFirst: jest.fn(async () => ({ id: 'b1', limit, spent })),
      create: jest.fn(async ({ data }) => ({ id: 'b1', ...data })),
      update: jest.fn(async (args) => {
        calls.updates.push(args);
        return { id: 'b1', limit, spent: spent + Number(args?.data?.spent?.increment || 0) };
      }),
    },
  };
  return { prisma, calls };
};

describe('spend policy (Phase 5)', () => {
  beforeEach(() => jest.resetModules());
  afterEach(() => { jest.dontMock('../src/config/prisma'); });

  test('<5tr trong envelope → MANAGER; 5–50tr → MANAGER; >50tr → ADMIN', async () => {
    jest.doMock('../src/config/prisma', () => budgetStore(50000000, 1000000).prisma);
    const svc = require('../src/modules/dept-budget/dept-budget.service');
    expect((await svc.checkSpend({ departmentId: 'd1', amount: 3000000 })).approver).toBe('MANAGER');
    expect((await svc.checkSpend({ departmentId: 'd1', amount: 20000000 })).approver).toBe('MANAGER');
    expect((await svc.checkSpend({ departmentId: 'd1', amount: 80000000 })).approver).toBe('ADMIN');
  });

  test('vượt envelope → auto-escalate ADMIN + overEnvelope=true + remaining đúng', async () => {
    jest.doMock('../src/config/prisma', () => budgetStore(50000000, 49000000).prisma);
    const svc = require('../src/modules/dept-budget/dept-budget.service');
    const r = await svc.checkSpend({ departmentId: 'd1', amount: 5000000 });
    expect(r.overEnvelope).toBe(true);
    expect(r.approver).toBe('ADMIN');
    expect(r.remaining).toBe(1000000);
    // `allowed` không phải cổng chặn — mọi khoản đều qua gate; nó nói "cần duyệt".
    expect(r.needsApproval).toBe(true);
  });

  test('addSpent dùng increment (không read-modify-write mất tiền khi duyệt song song)', async () => {
    const { prisma, calls } = budgetStore(50000000, 0);
    jest.doMock('../src/config/prisma', () => prisma);
    const svc = require('../src/modules/dept-budget/dept-budget.service');
    await svc.addSpent({ departmentId: 'd1', amount: 3000000 });
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].data.spent).toEqual({ increment: 3000000 });
  });
});