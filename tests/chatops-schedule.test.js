/**
 * tests/chatops-schedule.test.js — Phase 6 (HERMES)
 * Parse "gửi P&L 8h sáng T2" → cron/template; nextRunAfter; eval từ chối khi thiếu nhãn.
 */
jest.mock('../src/config/llm-policy', () => ({ callTask: jest.fn(async () => ({ ok: false })) }));

const { parseScheduleChat, nextRunAfter } = require('../src/modules/chatops/nl-schedule.service');
const { prf1, evaluate } = require('../src/modules/ai/agent-eval.service');

describe('nl-schedule + eval (Phase 6)', () => {
  test('parse "gửi P&L 8h sáng T2 cho #ketoan"', () => {
    const p = parseScheduleChat('gửi P&L 8h sáng T2 cho #ketoan qua telegram');
    expect(p.cron).toBe('0 8 * * 1');
    expect(p.template).toBe('weekly_pnl');
    expect(p.telegramChatId).toBe('ketoan');
    expect(p.channel).toBe('TELEGRAM');
  });

  test('parse mặc định 8h hằng ngày khi thiếu giờ', () => {
    const p = parseScheduleChat('gửi doanh thu hằng ngày');
    expect(p.cron).toBe('0 8 * * *');
    expect(p.template).toBe('revenue_daily');
  });

  test('nextRunAfter tôn trọng cron (T2 8h sau CN)', () => {
    const sunday = new Date(2026, 9, 11, 12, 0, 0); // CN 11/10/2026
    const next = nextRunAfter('0 8 * * 1', sunday);
    expect(next.getDay()).toBe(1);
    expect(next.getHours()).toBe(8);
    expect(next > sunday).toBe(true);
  });

  test('prf1 hoàn hảo = 1.0', () => {
    const pairs = [{ predicted: 'SALES', label: 'SALES' }, { predicted: 'HR', label: 'HR' }];
    const m = prf1(pairs);
    expect(m.accuracy).toBe(1);
    expect(m.macroF1).toBeCloseTo(1);
  });

  test('evaluate từ chối publish khi thiếu nhãn tay', async () => {
    const r = await evaluate({});
    expect(r.refused).toBe(true);
  });
});
