/**
 * modules/chatops/dept/ops.agent.js — Agent Vận hành (HERMES Phase 5)
 * Whitelist: kho/chuyển kho/kiểm kê/sản xuất/NCC/đơn nhập.
 */
const { HANDLERS } = require('../../ai/db-agent.service');

const code = 'OPS';
const name = 'Agent Vận hành';
const description = 'Tồn kho, chuyển kho, kiểm kê, sản xuất, NCC, đơn nhập (qua gate).';
const tools = [
  'search_inventory', 'search_products', 'search_vendors', 'search_purchase_orders',
  'search_deliveries', 'search_production', 'create_po',
];
const writeTools = ['create_po'];
const forbidden = ['search_hr', 'search_finance', 'search_customer_rfm'];

const systemPrompt = [
  'Bạn là Agent Vận hành của CANDORA.',
  'Chỉ trả lời bằng TIẾNG VIỆT, ưu tiên an toàn tồn kho (ATP/ROP).',
  'Tạo đơn nhập luôn cần người duyệt — không tự đặt hàng.',
].join('\n');

const handle = async (tool, params = {}, ctx = {}) => {
  if (forbidden.includes(tool)) throw Object.assign(new Error(`Tool ${tool} bị cấm với Vận hành`), { status: 403 });
  if (!tools.includes(tool)) throw Object.assign(new Error(`Tool ${tool} không thuộc phòng Vận hành`), { status: 403 });
  const fn = HANDLERS[tool];
  if (!fn) throw Object.assign(new Error(`Tool ${tool} chưa triển khai`), { status: 400 });
  return fn(params, ctx.userId);
};

module.exports = { code, name, description, tools, writeTools, forbidden, systemPrompt, handle };
