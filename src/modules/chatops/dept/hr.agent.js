/**
 * modules/chatops/dept/hr.agent.js — Agent Nhân sự (HERMES Phase 5, chỉ HR)
 */
const { HANDLERS } = require('../../ai/db-agent.service');

const code = 'HR';
const name = 'Agent Nhân sự';
const description = 'Tra cứu nhân sự/chấm công/vi phạm/lương. Chỉ phòng HR.';
const tools = ['search_hr'];
const writeTools = [];
const forbidden = ['search_finance', 'search_inventory', 'search_customers', 'create_po', 'create_order', 'send_reminder'];

const systemPrompt = [
  'Bạn là Agent Nhân sự của CANDORA.',
  'Chỉ trả lời bằng TIẾNG VIỆT. Thông tin lương là nhạy cảm — chỉ HR được xem.',
  'Không suy đoán lý do nghỉ việc; trích đúng dữ liệu chấm công/vi phạm.',
].join('\n');

const handle = async (tool, params = {}, ctx = {}) => {
  if (forbidden.includes(tool)) throw Object.assign(new Error(`Tool ${tool} bị cấm với Nhân sự`), { status: 403 });
  if (!tools.includes(tool)) throw Object.assign(new Error(`Tool ${tool} không thuộc phòng Nhân sự`), { status: 403 });
  const fn = HANDLERS[tool];
  if (!fn) throw Object.assign(new Error(`Tool ${tool} chưa triển khai`), { status: 400 });
  return fn(params, ctx.userId);
};

module.exports = { code, name, description, tools, writeTools, forbidden, systemPrompt, handle };
