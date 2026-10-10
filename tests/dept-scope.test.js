/**
 * tests/dept-scope.test.js — Phase 5 (HERMES)
 * Kế toán không thấy lương HR (authorizeDept 403); Sales không thấy journal.
 */
const { authorizeDept, deptScope } = require('../src/middleware/dept.middleware');

const runMw = (mw, req) => new Promise((resolve) => {
  mw(req, {}, (err) => resolve(err || null));
});

describe('dept scope (Phase 5)', () => {
  test('authorizeDept chặn sai phòng 403, đúng phòng qua, ADMIN bypass', async () => {
    const prismaFake = { user: { findUnique: jest.fn(async ({ where }) => ({ department: { code: 'SALES' } })) } };
    jest.resetModules();
    jest.doMock('../src/config/prisma', () => prismaFake);
    const { authorizeDept: ad } = require('../src/middleware/dept.middleware');
    const e1 = await runMw(ad('ACCOUNTING'), { user: { id: 'u1', role: 'CASHIER' } });
    expect(e1).toMatchObject({ status: 403 });
    const e2 = await runMw(ad('SALES'), { user: { id: 'u1', role: 'CASHIER' } });
    expect(e2).toBeNull();
    const e3 = await runMw(ad('HR'), { user: { id: 'u9', role: 'ADMIN' } });
    expect(e3).toBeNull();
    jest.dontMock('../src/config/prisma');
  });

  test('deptScope: ADMIN {} ; user chưa xếp phòng fail-closed', () => {
    expect(deptScope({ role: 'ADMIN' })).toEqual({});
    expect(deptScope({ role: 'CASHIER' })).toEqual({ departmentId: '__no_dept__' });
    expect(deptScope({ role: 'CASHIER' }, 'departmentId', 'd1')).toEqual({ departmentId: 'd1' });
  });
});
