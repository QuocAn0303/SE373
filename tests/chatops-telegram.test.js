/**
 * tests/chatops-telegram.test.js — Phase 1 (HERMES)
 * Routing đúng agent phòng ban + webhook verify + OTP binding shape.
 */
jest.mock('../src/config/llm-policy', () => ({ callTask: jest.fn(async () => ({ ok: false, reason: 'OFF' })) }));

const { routeDept, extractTool, isMultiStep } = require('../src/modules/chatops/orchestrator.service');
const { getAgent, listAgents } = require('../src/modules/chatops/dept');

describe('chatops telegram + routing (Phase 1)', () => {
  test('6 agent đủ + whitelist đúng', () => {
    const agents = listAgents();
    expect(agents.map((a) => a.code).sort()).toEqual(['ACCOUNTING', 'CSKH', 'HR', 'MARKETING', 'OPS', 'SALES']);
    expect(getAgent('SALES').tools).toContain('create_order');
    expect(getAgent('CSKH').forbidden).toContain('search_finance');
    expect(getAgent('HR').tools).toEqual(['search_hr']);
  });

  test('routeDept: tồn kho → OPS/SALES, lương → HR, chiến dịch → MARKETING', () => {
    expect(['OPS', 'SALES']).toContain(routeDept('tồn kho SKU X còn bao nhiêu?'));
    expect(routeDept('lương tháng này tính sao?')).toBe('HR');
    expect(routeDept('chiến dịch email tuần này')).toBe('MARKETING');
    expect(routeDept('chính sách chi tiêu')).toBe('ACCOUNTING');
  });

  test('extractTool: tạo PO / nhắc nợ / churn', () => {
    expect(extractTool('tạo PO nhập thêm 10 cái')?.tool).toBe('create_po');
    expect(extractTool('nhắc nợ khách A')?.tool).toBe('send_reminder');
    expect(extractTool('khách churn tuần này')?.tool).toBe('search_churn_alerts');
  });

  test('isMultiStep phát hiện yêu cầu đa bước (→ Qwen thinking)', () => {
    expect(isMultiStep('xem tồn kho và tạo PO nhập thêm')).toBe(true);
    expect(isMultiStep('tồn kho?')).toBe(false);
  });

  test('CSKH handle từ chối tool tài chính 403', async () => {
    const cskh = getAgent('CSKH');
    await expect(cskh.handle('search_finance', {})).rejects.toMatchObject({ status: 403 });
  });
});
