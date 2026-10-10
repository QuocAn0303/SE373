/**
 * tests/spend-policy.test.js — Phase 5 (HERMES)
 * Vượt envelope chặn/escalate; self-approve 409 (hợp đồng ở spend-gate);
 * checkSpend trả approver chain đúng ngưỡng 5tr/50tr.
 */
const budgetStore = (limit, spent) => ({
  deptBudget: {
    findFirst: jest.fn(async () => ({ id: 'b1', limit, spent })),
    create: jest.fn(async ({ data }) => ({ id: 'b1', ...data })),
    update: jest.fn(async ({ data }) => ({ id: 'b1', limit, spent: Number(spent) + Number(data.spent || 0) })),
  },
});

describe('spend policy (Phase 5)', () => {
  beforeEach(() => jest.resetModules());
  afterEach(() => jest.dontMock('../src/config/prisma'));

  test('<5tr trong envelope → MANAGER; 5–50tr → MANAGER; >50tr → ADMIN', async () => {
    jest.doMock('../src/config/prisma', () => budgetStore(50000000, 1000000));
    const svc = require('../src/modules/dept-budget/dept-budget.service');
    expect((await svc.checkSpend({ departmentId: 'd1', amount: 3000000 })).approver).toBe('MANAGER');
    expect((await svc.checkSpend({ departmentId: 'd1', amount: 20000000 })).approver).toBe('MANAGER');
    expect((await svc.checkSpend({ departmentId: 'd1', amount: 80000000 })).approver).toBe('ADMIN');
  });

  test('vượt envelope → auto-escalate ADMIN + overEnvelope=true', async () => {
    jest.doMock('../src/config/prisma', () => budgetStore(50000000, 49000000));
    const svc = require('../src/modules/dept-budget/dept-budget.service');
    const r = await svc.checkSpend({ departmentId: 'd1', amount: 5000000 });
    expect(r.overEnvelope).toBe(true);
    expect(r.approver).toBe('ADMIN');
  });
});
