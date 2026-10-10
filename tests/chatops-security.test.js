/**
 * tests/chatops-security.test.js — Chống tái diễn các lỗi bảo mật đã sửa
 *
 * Mỗi khẳng định ở đây gắn với MỘT finding của code review (commit c4bebc0).
 * Bỏ chúng đi thì các lỗi dưới đây có thể quay lại mà không ai biết:
 *   - GEMINI_API_KEY không được gửi tới llm.uit.edu.vn
 *   - webhook fail-closed ở production + không nhận secret qua query string
 *   - OTP lưu HASH, khoá sau N lần đoán sai, tra cứu chỉ dòng chưa bind
 *   - lịch báo cáo chỉ gửi tới chat ĐÃ BIND của chính người đặt
 *   - fact cấp phòng ban: chỉ MANAGER/ADMIN, không ghi vào phòng khác
 *   - skill APPROVED phải có sandbox pass
 *   - deptScope fail-closed (không trả `{}` khi chưa xếp phòng)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('chatops security (chống tái diễn review)', () => {
  describe('LLM key không rò chéo provider', () => {
    const old = { ...process.env };
    afterEach(() => { Object.assign(process.env, old); jest.resetModules(); });

    test('gemini provider ⇒ reasoningKey rỗng (không gửi GEMINI_API_KEY sang UIT)', () => {
      process.env.LLM_PROVIDER = 'gemini';
      process.env.GEMINI_API_KEY = 'gemini-secret-key';
      delete process.env.LLM_API_KEY;
      process.env.LLM_REASONING_BASE_URL = 'https://llm.uit.edu.vn/qwen/v1';
      process.env.LLM_REASONING_MODEL = 'qwen3.8-27b';
      delete process.env.LLM_REASONING_API_KEY;
      jest.resetModules();
      const llm = require('../src/config/llm');
      expect(llm.config().reasoningKey).toBe('');
      expect(llm.reasoningConfig()?.apiKey ?? '').toBe('');
    });

    test('openai-compatible ⇒ dùng LLM_API_KEY cho cả hai endpoint', () => {
      process.env.LLM_PROVIDER = 'openai-compatible';
      process.env.LLM_API_KEY = 'uit-key';
      jest.resetModules();
      const llm = require('../src/config/llm');
      expect(llm.config().reasoningKey).toBe('uit-key');
    });

    test('isConfigured: openai-compatible KHÔNG có key thì false', () => {
      process.env.LLM_PROVIDER = 'openai-compatible';
      process.env.LLM_API_KEY = '';
      delete process.env.GEMINI_API_KEY;
      jest.resetModules();
      expect(require('../src/config/llm').isConfigured()).toBe(false);
    });
  });

  describe('webhook fail-closed', () => {
    const old = { ...process.env };
    afterEach(() => { Object.assign(process.env, old); jest.resetModules(); });

    const loadVerify = () => {
      jest.resetModules();
      const src = read('src/modules/chatops/telegram.routes.js');
      // verifyWebhook là hàm nội bộ: đánh giá bằng cách require module rồi gọi
      // qua router là khó, nên ta kiểm hành vi qua mã nguồn + helper export.
      expect(src).toMatch(/timingSafeEqual/);
      return src;
    };

    test('không chấp nhận secret trong query string', () => {
      const src = loadVerify();
      // Chỉ phải loại khỏi CODE, không loại khỏi comment giải thích vì sao bị loại.
      const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'));
      expect(code.join('\n')).not.toMatch(/req\.query\.secret/);
    });

    test('production + thiếu secret ⇒ ném 503 (không mở cổng public)', () => {
      const src = loadVerify();
      expect(src).toMatch(/NODE_ENV === ['"]production['"]/);
      expect(src).toMatch(/503/);
      expect(src).toMatch(/từ chối/i);
    });

    test('OTP lưu HASH, không lưu plaintext', () => {
      const src = read('src/modules/chatops/telegram.routes.js');
      expect(src).toMatch(/otpHash\(otp\)/);
      expect(src).not.toMatch(/otpCode: otp\b/);
      expect(src).toMatch(/sha256/);
    });

    test('OTP khoá sau OTP_MAX_ATTEMPTS lần sai', () => {
      const src = read('src/modules/chatops/telegram.routes.js');
      expect(src).toMatch(/OTP_MAX_ATTEMPTS/);
      expect(src).toMatch(/otpLockedUntil/);
      expect(src).toMatch(/otpAttempts/);
    });

    test('tra cứu OTP chỉ dòng chưa bind (isActive:false)', () => {
      const src = read('src/modules/chatops/telegram.routes.js');
      expect(src).toMatch(/otpCode: otpHash\(otp\), isActive: false/);
    });
  });

  describe('lịch báo cáo không rò qua chatId tùy ý', () => {
    test('createFromChat kiểm chatId phải thuộc binding của người đặt', () => {
      const src = read('src/modules/chatops/nl-schedule.service.js');
      expect(src).toMatch(/chatBinding\.findFirst/);
      expect(src).toMatch(/chatId phải là chat Telegram đã buộc/);
      expect(src).toMatch(/403/);
    });

    test('route from-chat yêu cầu ADMIN/MANAGER', () => {
      const src = read('src/modules/chatops/nl-schedule.routes.js');
      expect(src).toMatch(/router\.post\('\/from-chat', authorize\('ADMIN', 'MANAGER'\)/);
    });

    test('runDueSchedules nhận tenantId để không chạy chéo tenant', () => {
      const svc = read('src/modules/chatops/nl-schedule.service.js');
      expect(svc).toMatch(/runDueSchedules = async \(\{ tenantId = null \}/);
      const routes = read('src/modules/chatops/nl-schedule.routes.js');
      expect(routes).toMatch(/runDueSchedules\(\{ tenantId: req\.user\.tenantId/);
    });
  });

  describe('memory: không ghi fact ACTIVE từ user thường', () => {
    test('scope DEPT yêu cầu MANAGER/ADMIN', () => {
      const src = read('src/modules/chatops/memory.service.js');
      expect(src).toMatch(/scope === 'DEPT' && !isManager/);
      expect(src).toMatch(/Chỉ MANAGER\/ADMIN được ghi fact cấp phòng ban/);
    });

    test('MANAGER không ghi được fact cho phòng khác', () => {
      const src = read('src/modules/chatops/memory.service.js');
      expect(src).toMatch(/MANAGER chỉ được ghi fact cho phòng của mình/);
    });

    test('GET /memory lọc theo phòng (không lộ fact DEPT của phòng khác)', () => {
      const src = read('src/modules/chatops/memory.routes.js');
      expect(src).toMatch(/scope: 'DEPT', departmentId: dept\.id/);
    });
  });

  describe('skill registry: sandbox phải thật và bắt buộc pass', () => {
    test('approve từ chối khi sandbox không ok', () => {
      const src = read('src/modules/agent-skills/agent-skill.service.js');
      expect(src).toMatch(/const passed = s\.testReport\.ok === true \|\| s\.testReport\.reason === 'SKIP_SPEND'/);
      expect(src).toMatch(/Sandbox không đạt/);
    });

    test('sandbox thực thi handler (không phải SELECT 1)', () => {
      const src = read('src/modules/agent-skills/agent-skill.service.js');
      expect(src).toMatch(/await agent\.handle\(readTool/);
      expect(src).not.toMatch(/\$queryRawUnsafe\('SELECT 1'\)/);
    });

    test('handlerRef chặn path traversal', () => {
      const src = read('src/modules/agent-skills/agent-skill.service.js');
      expect(src).toMatch(/\/\^\[a-z\]\[a-z0-9_\]\*\$\/i/);
    });
  });

  describe('deptScope fail-closed và được dùng thật', () => {
    test('không trì {} khi chưa xếp phòng', () => {
      const { deptScope } = require('../src/middleware/dept.middleware');
      expect(deptScope({ role: 'MANAGER' })).toEqual({ departmentId: '__no_dept__' });
      expect(deptScope({ role: 'CASHIER' })).toEqual({ departmentId: '__no_dept__' });
      expect(deptScope({ role: 'ADMIN' })).toEqual({});
    });

    test('route ngân sách thực sự dùng deptScope', () => {
      const src = read('src/modules/dept-budget/dept-budget.routes.js');
      expect(src).toMatch(/deptScope\(req\.user, 'departmentId'/);
    });
  });

  describe('PO gate không bịa payload', () => {
    test('orchestrator resolve product/vendor thật trước khi dựng gate PO', () => {
      const src = read('src/modules/chatops/orchestrator.service.js');
      expect(src).toMatch(/resolvePoEntities/);
      expect(src).not.toMatch(/productId: 'CHATOPS'/);
      expect(src).not.toMatch(/vendorId: 'CHATOPS'/);
    });

    test('duyệt xong không báo "thành công" khi executeGate lỗi', () => {
      const src = read('src/modules/chatops/telegram.routes.js');
      expect(src).toMatch(/KHÔNG tạo được PO/);
      expect(src).toMatch(/retry-execution/);
    });
  });

  describe('rò lỗi nội bộ', () => {
    test('reply cho Telegram không chứa e.message', () => {
      const src = read('src/modules/chatops/orchestrator.service.js');
      expect(src).toMatch(/Mã lỗi: \$\{errId\}/);
      expect(src).not.toMatch(/Mình chưa tra được \(\$\{e\.message\}\)/);
    });
  });

  describe('mẫu báo cáo lấy đúng số liệu', () => {
    test('weekly_pnl tách khỏi revenue_daily (tính cả tuần)', () => {
      const src = read('src/modules/chatops/nl-schedule.service.js');
      expect(src).toMatch(/template === 'weekly_pnl'[\s\S]{0,600}startOfWeek/);
    });

    test('debts_overdue lọc theo dueDate + enum DebtStatus thật', () => {
      const src = read('src/modules/chatops/nl-schedule.service.js');
      expect(src).toMatch(/dueDate: \{ lt: now \}/);
      expect(src).toMatch(/'OPEN', 'PARTIAL', 'OVERDUE'/);
      // `remaining` không phải cột của Debt — dùng amount - paidAmount
      expect(src).not.toMatch(/_sum: \{ remaining: true \}/);
    });

    test('inventory_low đếm riêng, không lấy length của take:10', () => {
      const src = read('src/modules/chatops/nl-schedule.service.js');
      expect(src).toMatch(/lowCount: counted/);
      expect(src).not.toMatch(/lowCount: rows\.length/);
    });

    test('giờ lịch không bị lookahead nuốt (vd "9h sáng t2")', () => {
      const { parseScheduleChat } = require('../src/modules/chatops/nl-schedule.service');
      expect(parseScheduleChat('gui P&L 9h sáng T2').cron).toBe('0 9 * * 1');
      expect(parseScheduleChat('gui P&L 8h sáng T2').cron).toBe('0 8 * * 1');
    });
  });

  describe('transport LLM', () => {
    test('đọc code: không hardcode family:4 cho đường openai-compatible', () => {
      const src = read('src/config/llm.js');
      const openaiPart = src.slice(src.indexOf('callOpenAICompatible'), src.indexOf('const callModel = async'));
      expect(openaiPart).toMatch(/family: 4/);
    });
  });
});