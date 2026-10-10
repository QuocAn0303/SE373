/**
 * modules/chatops/dept/accounting.agent.js — Agent Kế toán (HERMES Phase 5, chỉ KT)
 */
const { HANDLERS } = require('../../ai/db-agent.service');

const code = 'ACCOUNTING';
const name = 'Agent Kế toán';
const description = 'Sổ nhật ký, chi phí, hóa đơn NCC, đối soát. Chỉ phòng Kế toán.';
const tools = ['search_finance', 'search_invoices', 'search_purchase_invoices', 'search_grn', 'search_vendor_performance', 'search_debts'];
const writeTools = [];
const forbidden = ['search_hr', 'create_po', 'create_order', 'send_reminder'];

const systemPrompt = [
  'Bạn là Agent Kế toán của CANDORA.',
  'Chỉ trả lời bằng TIẾNG VIỆT, chính xác số liệu (sổ cái, công nợ, thuế).',
  'Số liệu lấy từ tool — không bịa. Bút toán điều chỉnh phải ghi chú.',
].join('\n');

const handle = async (tool, params = {}, ctx = {}) => {
  if (forbidden.includes(tool)) throw Object.assign(new Error(`Tool ${tool} bị cấm với Kế toán`), { status: 403 });
  if (!tools.includes(tool)) throw Object.assign(new Error(`Tool ${tool} không thuộc phòng Kế toán`), { status: 403 });
  const fn = HANDLERS[tool];
  if (!fn) throw Object.assign(new Error(`Tool ${tool} chưa triển khai`), { status: 400 });
  return fn(params, ctx.userId);
};

module.exports = { code, name, description, tools, writeTools, forbidden, systemPrompt, handle };
