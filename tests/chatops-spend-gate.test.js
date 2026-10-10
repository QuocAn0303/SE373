/**
 * tests/chatops-spend-gate.test.js — Phase 1.2 + 5 (HERMES)
 * Đơn → gate PENDING → tự duyệt 409 → người thứ hai duyệt OK → double-decide 409.
 * Dùng Prisma fake có trạng thái (không mock mù như lỗi cũ).
 */
jest.mock('../src/config/llm-policy', () => ({ callTask: jest.fn(async () => ({ ok: false, reason: 'OFF' })) }));

const fakeStore = () => {
  const gates = new Map();
  let seq = 0;
  return {
    gates,
    prisma: {
      user: {
        findUnique: jest.fn(async ({ where }) => {
          if (String(where.id).includes('maker')) return { id: where.id, role: 'MANAGER', tenantId: 't1', isActive: true };
          if (String(where.id).includes('approver')) return { id: where.id, role: 'ADMIN', tenantId: 't1', isActive: true };
          return null;
        }),
      },
      department: { findFirst: jest.fn(async () => ({ id: 'd-sales' })) },
      agentSession: {
        create: jest.fn(async ({ data }) => ({ id: `sess-${++seq}`, ...data })),
        update: jest.fn(async () => ({})),
      },
      agentStep: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null) },
      agentHumanGate: {
        create: jest.fn(async ({ data }) => {
          const g = { id: `gate-${++seq}`, status: 'PENDING', expiresAt: new Date(Date.now() + 86400000), sessionId: data.sessionId, actionType: data.actionType, actionPayload: data.actionPayload, actionSummary: data.actionSummary, session: { userId: 'maker-1', triggerSource: 'TELEGRAM' } };
          gates.set(g.id, g);
          return g;
        }),
        findFirst: jest.fn(async ({ where }) => gates.get(where.id) || null),
        updateMany: jest.fn(async ({ where, data }) => {
          const g = gates.get(where.id);
          if (!g || (where.status && g.status !== where.status)) return { count: 0 };
          Object.assign(g, data);
          return { count: 1 };
        }),
      },
      auditLog: { create: jest.fn(async () => ({})) },
      notification: { create: jest.fn(async () => ({})) },
      inventory: { findMany: jest.fn(async () => []) },
      // Orchestrator resolve product/vendor THẬT trước khi dựng gate PO.
      // Không có 2 bản ghi này thì PO gate không dựng được (đúng chủ ý).
      product: {
        findFirst: jest.fn(async () => null),
      },
      vendor: {
        findFirst: jest.fn(async () => null),
      },
    },
  };
};

describe('spend gate qua chat (Phase 1.2/5)', () => {
  let store;
  beforeEach(() => {
    store = fakeStore();
    jest.resetModules();
    jest.doMock('../src/config/prisma', () => store.prisma);
    jest.doMock('../src/config/llm-policy', () => ({ callTask: jest.fn(async () => ({ ok: false, reason: 'OFF' })) }));
  });
  afterEach(() => { jest.dontMock('../src/config/prisma'); jest.dontMock('../src/config/llm-policy'); });

  test('write tool sinh gate PENDING, không thực hiện trực tiếp', async () => {
    const { processMessage } = require('../src/modules/chatops/orchestrator.service');
    const out = await processMessage({ text: 'tạo PO nhập thêm 10 cái', user: { id: 'maker-1', role: 'MANAGER', tenantId: 't1' }, chatId: 'c1' });
    expect(out.gateId).toBeTruthy();
    expect(out.reply).toMatch(/phê duyệt/);
    const g = store.gates.get(out.gateId);
    expect(g.status).toBe('PENDING');
    expect(g.actionSummary).toBeTruthy(); // hợp đồng humangate: actionSummary bắt buộc
  });

  test('PO không resolve được SKU/NCC thì KHÔNG dựng gate PO giả (chuyển sang hỏi lại)', async () => {
    // product.findFirst trả null ⇒ không có payload PO bịa đặt.
    const { processMessage } = require('../src/modules/chatops/orchestrator.service');
    const out = await processMessage({ text: 'tạo PO nhập thêm 10 cái', user: { id: 'maker-1', role: 'MANAGER', tenantId: 't1' } });
    const g = store.gates.get(out.gateId);
    expect(g.actionType).toBe('DATA_REQUEST');
    expect(g.actionPayload.tool).toBe('create_po_needs_clarification');
    // Quan trọng: không có payload PO với productId/vendorId bịa ('CHATOPS').
    expect(JSON.stringify(g.actionPayload)).not.toContain('CHATOPS');
  });

  test('PO có SKU + NCC thật thì mới dựng gate PO_PROPOSAL với id thật', async () => {
    store.prisma.product.findFirst.mockResolvedValueOnce({ id: 'p1', name: 'Sáp treo', sku: 'SAP-1', costPrice: 30000, price: 60000 });
    store.prisma.vendor.findFirst.mockResolvedValueOnce({ id: 'v1', name: 'NCC An Khang' });
    const { processMessage } = require('../src/modules/chatops/orchestrator.service');
    const out = await processMessage({ text: 'tạo PO nhập thêm 10 sáp treo từ NCC An Khang', user: { id: 'maker-1', role: 'MANAGER', tenantId: 't1' } });
    const g = store.gates.get(out.gateId);
    expect(g.actionType).toBe('PURCHASE_ORDER_PROPOSAL');
    // vendorId nằm ở gốc payload (xem buildPoProposalGate), không nằm trong items.
    expect(g.actionPayload.items[0].productId).toBe('p1');
    expect(g.actionPayload.vendorId).toBe('v1');
    expect(g.actionPayload.totalEstimate).toBeGreaterThan(0);
  });

  test('self-approve PO 409; người thứ hai từ chối OK; double-decide 409', async () => {
    // Self-approval CHỈ chặn với gate PO_PROPOSAL (chi tiền). Nên test này cần
    // SKU + NCC thật để orchestrator dựng đúng gate PO.
    store.prisma.product.findFirst.mockResolvedValue({ id: 'p1', name: 'Sáp treo', sku: 'SAP-1', costPrice: 30000, price: 60000 });
    store.prisma.vendor.findFirst.mockResolvedValue({ id: 'v1', name: 'NCC An Khang' });
    const { processMessage } = require('../src/modules/chatops/orchestrator.service');
    const { decideGateAs } = require('../src/modules/chatops/telegram.routes');
    const out = await processMessage({ text: 'tạo PO nhập thêm 10 sáp treo từ NCC An Khang', user: { id: 'maker-1', role: 'MANAGER', tenantId: 't1' } });
    expect(store.gates.get(out.gateId).actionType).toBe('PURCHASE_ORDER_PROPOSAL');
    await expect(decideGateAs('maker-1', out.gateId, 'APPROVED', 'tự duyệt')).rejects.toMatchObject({ status: 409 });
    const r = await decideGateAs('approver-1', out.gateId, 'REJECTED', 'hết ngân sách');
    expect(r.decision).toBe('REJECTED');
    await expect(decideGateAs('approver-1', out.gateId, 'APPROVED', 'x')).rejects.toMatchObject({ status: 409 });
    // decide ghi audit
    expect(store.prisma.auditLog.create).toHaveBeenCalled();
  });

  test('gate DATA_REQUEST (đọc) vẫn cho self-approval — không phải chi tiền', async () => {
    const { processMessage } = require('../src/modules/chatops/orchestrator.service');
    const { decideGateAs } = require('../src/modules/chatops/telegram.routes');
    const out = await processMessage({ text: 'tạo PO nhập thêm 10 cái', user: { id: 'maker-1', role: 'MANAGER', tenantId: 't1' } });
    expect(store.gates.get(out.gateId).actionType).toBe('DATA_REQUEST');
    const r = await decideGateAs('maker-1', out.gateId, 'REJECTED', 'cần SKU cụ thể');
    expect(r.decision).toBe('REJECTED');
  });
});
