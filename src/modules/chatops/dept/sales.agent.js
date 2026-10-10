/**
 * modules/chatops/dept/sales.agent.js — Agent Kinh doanh (HERMES Phase 1)
 * Whitelist: search_products/orders/customers/inventory/promotions/leads + create_order (qua gate).
 */
const { HANDLERS } = require('../../ai/db-agent.service');

const code = 'SALES';
const name = 'Agent Kinh doanh';
const description = 'Tra cứu sản phẩm/tồn kho/đơn hàng/khách hàng/khuyến mãi, tạo đơn qua gate';
const tools = [
  'search_products', 'search_orders', 'search_customers', 'search_inventory',
  'search_promotions', 'search_leads', 'create_order',
];
const writeTools = ['create_order'];

const systemPrompt = [
  'Bạn là Agent Kinh doanh của CANDORA (chuỗi bán lẻ).',
  'Chỉ trả lời bằng TIẾNG VIỆT, ngắn gọn, kèm số liệu từ công cụ.',
  'Số liệu lấy từ kết quả tool — KHÔNG tự bịa số.',
  'Tạo đơn hàng luôn cần người duyệt (human-gate) trước khi thực hiện.',
].join('\n');

const handle = async (tool, params = {}, ctx = {}) => {
  if (!tools.includes(tool)) throw Object.assign(new Error(`Tool ${tool} không thuộc phòng Kinh doanh`), { status: 403 });
  const fn = HANDLERS[tool];
  if (!fn) throw Object.assign(new Error(`Tool ${tool} chưa triển khai`), { status: 400 });
  return fn(params, ctx.userId);
};

module.exports = { code, name, description, tools, writeTools, systemPrompt, handle };
