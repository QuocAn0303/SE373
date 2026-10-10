/**
 * tests/agent-skill.test.js — Phase 4 (HERMES)
 * propose → approve → version bump; DRAFT không gọi được; DISABLE thu hồi ngay.
 */
const skillStore = () => {
  const rows = [];
  return {
    rows,
    prisma: {
      agentSkill: {
        create: jest.fn(async ({ data }) => { const r = { id: `s${rows.length + 1}`, ...data }; rows.push(r); return r; }),
        findFirst: jest.fn(async ({ where, orderBy }) => {
          let list = rows;
          if (where?.code) list = list.filter((r) => r.code === where.code);
          if (where?.id) list = list.filter((r) => r.id === where.id);
          if (orderBy?.version === 'desc') list = [...list].sort((a, b) => b.version - a.version);
          return list[0] || null;
        }),
        findMany: jest.fn(async ({ where }) => rows.filter((r) => !where?.status || r.status === where.status)),
        update: jest.fn(async ({ where, data }) => {
          const r = rows.find((x) => x.id === where.id);
          Object.assign(r, data);
          return r;
        }),
      },
      // Sandbox gọi THẬT handler đọc (`cskh` → search_customers). Nên mock phải
      // đủ bảng mà handler chạm tới, nếu không handler ném lỗi và báo SANDBOX_ERROR.
      customer: {
        findMany: jest.fn(async () => [{ id: 'c1', name: 'KH A', phone: '0900000000', totalSpent: 1000000, totalDebt: 0 }]),
        count: jest.fn(async () => 1),
      },
      $transaction: jest.fn(async (fn) => fn({ $queryRawUnsafe: jest.fn(async () => []) })),
    },
  };
};

describe('agent skill registry (Phase 4)', () => {
  let store;
  beforeEach(() => {
    store = skillStore();
    jest.resetModules();
    jest.doMock('../src/config/prisma', () => store.prisma);
  });
  afterEach(() => { jest.dontMock('../src/config/prisma'); });

  test('vòng đời propose → submit → sandbox → approve (có handler thật)', async () => {
    const svc = require('../src/modules/agent-skills/agent-skill.service');
    // Sandbox PHẢI thực thi handler (xem review: trước đây chỉ chạy SELECT 1 rồi
    // luôn báo ok). Handler 'cskh' có tool đọc search_customers.
    const s = await svc.propose({ code: 'debt_summary_8am', name: 'Tổng hợp nợ 8h', departmentScope: 'CSKH', handlerRef: 'cskh' });
    expect(s.status).toBe('DRAFT');
    expect((await svc.callableSkills({})).map((x) => x.id)).not.toContain(s.id); // DRAFT không gọi được
    await svc.submitForApproval({ id: s.id });
    const rep = await svc.runSandbox({ id: s.id });
    expect(rep.ok).toBe(true);
    expect(rep.tool).toBe('search_customers');
    const approved = await svc.approve({ id: s.id, userId: 'u-admin' });
    expect(approved.status).toBe('APPROVED');
    expect((await svc.callableSkills({ departmentCode: 'CSKH' })).map((x) => x.id)).toContain(s.id);
  });

  test('skill KHÔNG có handler ⇒ sandbox fail và approve bị chặn (409)', async () => {
    const svc = require('../src/modules/agent-skills/agent-skill.service');
    const s = await svc.propose({ code: 'no_handler', name: 'Không có handler' });
    await svc.submitForApproval({ id: s.id });
    const rep = await svc.runSandbox({ id: s.id });
    expect(rep.ok).toBe(false);
    expect(rep.reason).toBe('NO_HANDLER');
    // Trước đây approve chỉ kiểm `!testReport` ⇒ sandbox fail vẫn qua duyệt.
    await expect(svc.approve({ id: s.id, userId: 'u' })).rejects.toMatchObject({ status: 409 });
  });

  test('handlerRef không hợp lệ (path traversal) ⇒ HANDLER_INVALID, không duyệt', async () => {
    const svc = require('../src/modules/agent-skills/agent-skill.service');
    const s = await svc.propose({ code: 'evil', name: 'Evil', handlerRef: '../../prisma/seed' });
    await svc.submitForApproval({ id: s.id });
    const rep = await svc.runSandbox({ id: s.id });
    expect(rep.ok).toBe(false);
    expect(rep.reason).toBe('HANDLER_INVALID');
    await expect(svc.approve({ id: s.id, userId: 'u' })).rejects.toMatchObject({ status: 409 });
  });

  test('skill chạm tiền bị sandbox chặn + version bump khi propose lại', async () => {
    const svc = require('../src/modules/agent-skills/agent-skill.service');
    const s = await svc.propose({ code: 'auto_po', name: 'Tự đặt PO', handlerRef: 'create_po' });
    await svc.submitForApproval({ id: s.id });
    const rep = await svc.runSandbox({ id: s.id });
    expect(rep.reason).toBe('SKIP_SPEND');
    // SKIP_SPEND được phép duyệt nhưng vẫn phải qua gate từng lần (nguyên tắc §0).
    const approved = await svc.approve({ id: s.id, userId: 'u' });
    expect(approved.status).toBe('APPROVED');
    const s2 = await svc.propose({ code: 'auto_po', name: 'Tự đặt PO v2' });
    expect(s2.version).toBe(2);
  });

  test('DISABLE thu hồi ngay', async () => {
    const svc = require('../src/modules/agent-skills/agent-skill.service');
    const s = await svc.propose({ code: 'x', name: 'X', handlerRef: 'cskh' });
    await svc.submitForApproval({ id: s.id });
    await svc.runSandbox({ id: s.id });
    await svc.approve({ id: s.id, userId: 'u' });
    await svc.disable({ id: s.id, userId: 'u' });
    expect((await svc.callableSkills({})).map((x) => x.id)).not.toContain(s.id);
  });
});
