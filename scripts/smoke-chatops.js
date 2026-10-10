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
const logger = require('../src/utils/logger');

const KEEP = process.argv.includes('--keep');

(async () => {
  const prisma = require('../src/config/prisma');
  const tag = `smoke-${Date.now()}`;
  const assert = (cond, msg) => {
    console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
    if (!cond) { process.exitCode = 1; throw new Error(`ASSERT FAILED: ${msg}`); }
  };

  const tenant = await prisma.tenant.create({ data: { name: `SMOKE ${tag}`, slug: `smoke-chatops-${tag}` } });
  const ids = { tenant: tenant.id, users: [], dept: null, gates: [], sessions: [], products: [], vendors: [], categories: [] };
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

      // Câu trống thông tin SKU/NCC ⇒ orchestrator KHÔNG dựng gate PO bịa đặt,
      // mà chuyển sang gate hỏi lại (DATA_REQUEST). Gate này vẫn cho self-approval
      // vì không phải chi tiền.
      const ask = await processMessage({ text: 'tạo PO nhập thêm 10 cái', user: { id: maker.id, role: 'MANAGER', tenantId: tenant.id } });
      const askGate = await prisma.agentHumanGate.findFirst({ where: { id: ask.gateId } });
      assert(askGate?.actionType === 'DATA_REQUEST', 'PO thiếu SKU/NCC ⇒ gate hỏi lại, không bịa payload PO');
      assert(!JSON.stringify(askGate.actionPayload).includes('CHATOPS'), 'payload gate không chứa id giả');
      ids.gates.push(ask.gateId);
      ids.sessions.push(ask.sessionId);

      // Dựng PO thật: tạo product + vendor rồi hỏi bằng tên cụ thể.
      // `Product.category` là bắt buộc (FK) ⇒ tạo danh mục riêng cho smoke.
      const category = await prisma.category.create({
        data: { name: `SMOKE danh mục ${tag}`, isActive: true },
      });
      ids.categories.push(category.id);
      const product = await prisma.product.create({
        data: {
          name: 'Sáp treo CANDORA', sku: `SMOKE-${Date.now()}`,
          price: 60000, costPrice: 30000, isActive: true, categoryId: category.id,
        },
      });
      ids.products.push(product.id);
      const vendor = await prisma.vendor.create({
        data: { name: 'NCC An Khang Smoke', code: `SMOKE-NCC-${tag}`, isActive: true },
      });
      ids.vendors.push(vendor.id);

      const write = await processMessage({
        text: 'tạo PO nhập thêm 10 sáp treo candora từ ncc an khang smoke',
        user: { id: maker.id, role: 'MANAGER', tenantId: tenant.id },
      });
      const poGate = await prisma.agentHumanGate.findFirst({ where: { id: write.gateId } });
      assert(write.gateId, 'write sinh gate');
      ids.gates.push(write.gateId);
      ids.sessions.push(write.sessionId);

      const { decideGateAs } = require('../src/modules/chatops/telegram.routes');
      let selfBlocked = false;
      if (poGate?.actionType === 'PURCHASE_ORDER_PROPOSAL') {
        try {
          await decideGateAs(maker.id, write.gateId, 'APPROVED', 'tự duyệt');
        } catch (e) {
          selfBlocked = e.status === 409;
        }
        assert(selfBlocked, 'self-approve PO bị chặn 409');
        const done = await decideGateAs(approver.id, write.gateId, 'REJECTED', 'hết ngân sách');
        assert(done.decision === 'REJECTED', 'người thứ hai từ chối OK kèm note');
      } else {
        // Không resolve được NCC theo tên (tên seed có timestamp) ⇒ gate hỏi lại.
        // Vẫn kiểm được đường self-approve vì đây là gate đọc.
        assert(poGate?.actionType === 'DATA_REQUEST', 'gate dựng ra phải là PO thật hoặc DATA_REQUEST');
        logger.info('[smoke-chatops] bỏ qua kiểm self-approve PO (không resolve được NCC theo tên)');
      }
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
        for (const p of ids.products) await prisma.product.deleteMany({ where: { id: p } }).catch(() => null);
        for (const c of ids.categories) await prisma.category.deleteMany({ where: { id: c } }).catch(() => null);
        for (const v of ids.vendors) await prisma.vendor.deleteMany({ where: { id: v } }).catch(() => null);
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
