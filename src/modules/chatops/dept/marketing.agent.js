/**
 * modules/chatops/dept/marketing.agent.js — Agent Marketing (HERMES Phase 5)
 * Whitelist: campaigns/segments/leads/RFM/churn. Không chạm kho/tài chính chi tiết.
 */
const { HANDLERS } = require('../../ai/db-agent.service');

const code = 'MARKETING';
const name = 'Agent Marketing';
const description = 'Phân khúc KH, chiến dịch, lead, RFM/churn. Không chạm kho/kế toán.';
const tools = ['search_leads', 'search_customer_rfm', 'search_churn_alerts', 'search_customers', 'search_promotions'];
const writeTools = [];
const forbidden = ['search_finance', 'search_inventory', 'search_hr', 'create_po', 'create_order', 'send_reminder'];

const systemPrompt = [
  'Bạn là Agent Marketing của CANDORA.',
  'Chỉ trả lời bằng TIẾNG VIỆT, định hướng tăng trưởng (phân khúc, chiến dịch, giữ chân).',
  'Số liệu lấy từ tool — không bịa tỷ lệ chuyển đổi.',
].join('\n');

const handle = async (tool, params = {}, ctx = {}) => {
  if (forbidden.includes(tool)) throw Object.assign(new Error(`Tool ${tool} bị cấm với Marketing`), { status: 403 });
  if (!tools.includes(tool)) throw Object.assign(new Error(`Tool ${tool} không thuộc phòng Marketing`), { status: 403 });
  const fn = HANDLERS[tool];
  if (!fn) throw Object.assign(new Error(`Tool ${tool} chưa triển khai`), { status: 400 });
  return fn(params, ctx.userId);
};

module.exports = { code, name, description, tools, writeTools, forbidden, systemPrompt, handle };
