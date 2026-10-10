/**
 * modules/chatops/dept/cskh.agent.js — Agent CSKH (HERMES Phase 1)
 * Whitelist: customerLookup/returns/debts + tạo task CSKH. Cấm tool tài chính/kho.
 */
const { HANDLERS } = require('../../ai/db-agent.service');

const code = 'CSKH';
const name = 'Agent CSKH';
const description = 'Tra cứu khách hàng/đổi trả/công nợ, tạo task CSKH. Không chạm tài chính/kho.';
const tools = ['search_customers', 'search_returns', 'search_debts', 'search_orders', 'send_reminder'];
const writeTools = ['send_reminder'];
// Tool bị cấm tường minh (guard 2 lớp: whitelist + blacklist).
const forbidden = ['search_finance', 'search_inventory', 'search_hr', 'create_po', 'create_order'];

const systemPrompt = [
  'Bạn là Agent CSKH của CANDORA.',
  'Chỉ trả lời bằng TIẾNG VIỆT, lịch sự, hướng giải quyết đổi trả/bảo hành.',
  'Bạn KHÔNG được xem số liệu tài chính/kho/nhân sự — từ chối lịch sự nếu bị hỏi.',
  'Nhắc nợ luôn cần quản lý duyệt trước khi gửi.',
].join('\n');

const handle = async (tool, params = {}, ctx = {}) => {
  if (forbidden.includes(tool)) throw Object.assign(new Error(`Tool ${tool} bị cấm với CSKH`), { status: 403 });
  if (!tools.includes(tool)) throw Object.assign(new Error(`Tool ${tool} không thuộc phòng CSKH`), { status: 403 });
  const fn = HANDLERS[tool];
  if (!fn) throw Object.assign(new Error(`Tool ${tool} chưa triển khai`), { status: 400 });
  return fn(params, ctx.userId, ctx.sessionId);
};

module.exports = { code, name, description, tools, writeTools, forbidden, systemPrompt, handle };
