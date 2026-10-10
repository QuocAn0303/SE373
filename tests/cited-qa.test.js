/**
 * tests/cited-qa.test.js — Phase 2 (HERMES)
 * Hỏi "chi trên 5tr duyệt ai?" → reply chứa quote đúng điều + doc id;
 * user phòng khác hỏi tài liệu hạn chế → từ chối.
 */
jest.mock('../src/config/llm-policy', () => ({ callTask: jest.fn(async () => ({ ok: false, reason: 'OFF' })) }));

const mockPrisma = {
  internalDocument: {
    findMany: jest.fn(async () => ([
      {
        id: 'doc-spend', title: 'Chính sách chi tiêu CANDORA',
        description: 'ĐIỀU 1. Chi dưới 5 triệu trong ngân sách phòng được tự duyệt. ĐIỀU 2. Chi 5–50 triệu cần MANAGER phòng duyệt.',
        sendToAll: false,
        departments: [{ departmentId: 'd-kt', department: { id: 'd-kt', code: 'ACCOUNTING' } }],
      },
      {
        id: 'doc-hr', title: 'Nội quy nhân sự CANDORA',
        description: 'ĐIỀU 1. Ba ca SÁNG/CHIỀU/TỐI.',
        sendToAll: false,
        departments: [{ departmentId: 'd-hr', department: { id: 'd-hr', code: 'HR' } }],
      },
    ])),
  },
  department: { findFirst: jest.fn(async ({ where }) => ({ id: where.code === 'ACCOUNTING' ? 'd-kt' : 'd-hr' })) },
  user: { findUnique: jest.fn(async () => null) },
};
jest.mock('../src/config/prisma', () => mockPrisma);

const { answerWithCitations, similarity } = require('../src/modules/ai/cited-qa.service');

describe('cited QA (Phase 2)', () => {
  test('hỏi chi trên 5tr → quote đúng điều + doc id', async () => {
    const out = await answerWithCitations(
      'chi trên 5 triệu thì ai duyệt?',
      { id: 'u1', role: 'ADMIN', deptCode: 'ACCOUNTING' },
    );
    expect(out.citations.length).toBeGreaterThan(0);
    expect(out.citations[0].docId).toBe('doc-spend');
    expect(out.answer).toMatch(/5 triệu|MANAGER/);
  });

  test('user HR hỏi tài liệu Kế toán → chỉ thấy tài liệu HR', async () => {
    const out = await answerWithCitations(
      'chi trên 5 triệu thì ai duyệt?',
      { id: 'u2', role: 'CASHIER', deptCode: 'HR' },
    );
    const ids = out.citations.map((c) => c.docId);
    expect(ids).not.toContain('doc-spend');
  });

  test('thiếu nguồn → từ chối + gợi ý', async () => {
    const out = await answerWithCitations('tàu vũ trụ giá bao nhiêu?', { id: 'u1', role: 'ADMIN' });
    expect(out.citations).toEqual([]);
    expect(out.answer).toMatch(/không tìm thấy/);
    expect(out.answer).toMatch(/tài liệu/);
  });

  test('similarity thuần: câu trùng từ cao điểm hơn', () => {
    expect(similarity('chi 5 triệu ai duyệt', 'Chi 5 triệu cần MANAGER duyệt')).toBeGreaterThan(
      similarity('chi 5 triệu ai duyệt', 'Ba ca sáng chiều tối'),
    );
  });
});
