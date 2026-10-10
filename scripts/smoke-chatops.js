/**
 * scripts/smoke-chatops.js — Smoke ChatOps trên DB thật (tự dọn dẹp, KHÔNG cần server)
 *
 * Luồng: seed tối thiểu (tenant tạm + user + dept) → orchestrator.processMessage
 * (read) → write tool sinh gate PENDING → decideGateAs APPROVED bị chặn self-approve
 * (409) → MANAGER khác duyệt OK → dọn dẹp.
 *
 * Dùng: node scripts/smoke-chatops.js [--keep để giữ dữ liệu]
 */
require('dotenv').config();
const { runWithTenant } = require('../src/config/tenantContext');

const KEEP = process.argv.includes('--keep');

(async () => {
  const prisma = require('../src/config/prisma');
  const tag = `smoke-${Date.now()}`;
  const assert = (cond, msg) => {
    console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
    if (!cond) { process.exitCode = 1; throw new Error(`ASSERT FAILED: ${msg}`); }
  };

  const tenant = await prisma.tenant.create({ data: { name: `SMOKE ${tag}`, slug: `smoke-chatops-${tag}` } });
  const ids = { tenant: tenant.id, users: [], dept: null, gates: [], sessions: [] };
  try {
    await runWithTenant(tenant.id, async () => {
      const dept = await prisma.department.create({ data: { name: 'Kinh doanh', code: 'SALES' } });
      ids.dept = dept.id;
      const mkUser = (email, role) => prisma.user.create({
        data: { email: `${tag}-${email}`, password: 'x', fullName: email, role, tenantId: tenant.id, departmentId: dept.id, isActive: true },
      });
      const maker = await mkUser('maker@local', 'MANAGER');
      const approver = await mkUser('approver@local', 'ADMIN');
      ids.users = [maker.id, approver.id];

      const { routeDept, extractTool } = require('../src/modules/chatops/orchestrator.service');
      assert(routeDept('tồn kho SKU X?') === 'SALES' || routeDept('tồn kho SKU X?') === 'OPS', 'routeDept tồn kho → Sales/Ops');
      assert(extractTool('tạo PO nhập thêm')?.tool === 'create_po', 'extractTool tạo PO');

      const { processMessage } = require('../src/modules/chatops/orchestrator.service');
      const read = await processMessage({ text: 'tồn kho còn hàng không?', user: { id: maker.id, role: 'MANAGER', tenantId: tenant.id } });
      assert(read.sessionId, 'read sinh session');
      ids.sessions.push(read.sessionId);

      const write = await processMessage({ text: 'tạo PO nhập thêm 10 cái', user: { id: maker.id, role: 'MANAGER', tenantId: tenant.id } });
      assert(write.gateId, 'write sinh gate PENDING');
      ids.gates.push(write.gateId);
      ids.sessions.push(write.sessionId);

      const { decideGateAs } = require('../src/modules/chatops/telegram.routes');
      let selfBlocked = false;
      try {
        await decideGateAs(maker.id, write.gateId, 'APPROVED', 'tự duyệt');
      } catch (e) {
        selfBlocked = e.status === 409;
      }
      assert(selfBlocked, 'self-approve PO bị chặn 409');

      const done = await decideGateAs(approver.id, write.gateId, 'REJECTED', 'hết ngân sách');
      assert(done.decision === 'REJECTED', 'người thứ hai từ chối OK kèm note');
    });
    console.log('✓ smoke-chatops xanh');
  } finally {
    if (!KEEP) {
      await runWithTenant(tenant.id, async () => {
        for (const g of ids.gates) await prisma.agentHumanGate.deleteMany({ where: { id: g } }).catch(() => null);
        for (const s of ids.sessions) {
          await prisma.agentStep.deleteMany({ where: { sessionId: s } }).catch(() => null);
          await prisma.agentSession.deleteMany({ where: { id: s } }).catch(() => null);
        }
        for (const u of ids.users) {
          await prisma.chatBinding.deleteMany({ where: { userId: u } }).catch(() => null);
          await prisma.employee.deleteMany({ where: { userId: u } }).catch(() => null);
          await prisma.user.deleteMany({ where: { id: u } }).catch(() => null);
        }
        if (ids.dept) await prisma.department.deleteMany({ where: { id: ids.dept } }).catch(() => null);
      });
      await prisma.tenant.deleteMany({ where: { id: tenant.id } }).catch(() => null);
      console.log('(đã dọn dẹp)');
    } else console.log(`(--keep: tenant=${tenant.id})`);
    await prisma.$disconnect().catch(() => null);
  }
})().catch((e) => { console.error('smoke-chatops FAILED:', e.message); process.exit(1); });
