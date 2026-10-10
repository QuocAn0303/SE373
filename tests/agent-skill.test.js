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

  test('vòng đời propose → submit → sandbox → approve', async () => {
    const svc = require('../src/modules/agent-skills/agent-skill.service');
    const s = await svc.propose({ code: 'debt_summary_8am', name: 'Tổng hợp nợ 8h', departmentScope: 'CSKH' });
    expect(s.status).toBe('DRAFT');
    expect((await svc.callableSkills({})).map((x) => x.id)).not.toContain(s.id); // DRAFT không gọi được
    await svc.submitForApproval({ id: s.id });
    const rep = await svc.runSandbox({ id: s.id });
    expect(rep.ok).toBe(true);
    const approved = await svc.approve({ id: s.id, userId: 'u-admin' });
    expect(approved.status).toBe('APPROVED');
    expect((await svc.callableSkills({ departmentCode: 'CSKH' })).map((x) => x.id)).toContain(s.id);
  });

  test('skill chạm tiền bị sandbox chặn + version bump khi propose lại', async () => {
    const svc = require('../src/modules/agent-skills/agent-skill.service');
    const s = await svc.propose({ code: 'auto_po', name: 'Tự đặt PO', handlerRef: 'create_po' });
    await svc.submitForApproval({ id: s.id });
    const rep = await svc.runSandbox({ id: s.id });
    expect(rep.reason).toBe('SKIP_SPEND');
    const s2 = await svc.propose({ code: 'auto_po', name: 'Tự đặt PO v2' });
    expect(s2.version).toBe(2);
  });

  test('DISABLE thu hồi ngay', async () => {
    const svc = require('../src/modules/agent-skills/agent-skill.service');
    const s = await svc.propose({ code: 'x', name: 'X' });
    await svc.submitForApproval({ id: s.id });
    await svc.runSandbox({ id: s.id });
    await svc.approve({ id: s.id, userId: 'u' });
    await svc.disable({ id: s.id, userId: 'u' });
    expect((await svc.callableSkills({})).map((x) => x.id)).not.toContain(s.id);
  });
});
