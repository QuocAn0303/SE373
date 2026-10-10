/**
 * modules/chatops/telegram.service.js — Telegram Bot API adapter (HERMES Phase 1)
 *
 * - Gửi tin/Markdown + inline keyboard Duyệt/Từ chối cho human-gate.
 * - Không thêm dep mới: dùng global fetch của Node 18+.
 * - Mọi hàm gửi đều fire-and-throw (lỗi ném ra để caller log, không nuốt).
 * - Bot token + webhook secret qua env (không commit).
 */
const logger = require('../../utils/logger');

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';
const API_BASE = () => `https://api.telegram.org/bot${BOT_TOKEN()}`;
const MAX_TEXT = 4000;

const isConfigured = () => Boolean(BOT_TOKEN());

const clip = (s, max = MAX_TEXT) => {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
};

const callApi = async (method, body) => {
  if (!isConfigured()) throw new Error('Chưa cấu hình TELEGRAM_BOT_TOKEN');
  const res = await fetch(`${API_BASE()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(`Telegram ${method} HTTP ${res.status}: ${(json.description || '').slice(0, 200)}`);
  }
  return json.result;
};

/**
 * Escape ký tự Markdown của Telegram (parse_mode legacy 'Markdown').
 *
 * VÌ SAO PHẢI: reply của agent chứa dữ liệu DB (tên sản phẩm, tên khách, fact
 * memory, actionSummary). Một ký tự `_ * [ ` trần trong dữ liệu làm Telegram
 * trả 400 và TIN NHẮN BỊ BỎ — gate duyệt tiền mà người dùng không thấy.
 * Escape trước rồi mới bọc phần định dạng của ta bằng backtick/code.
 */
const escapeMd = (s) => String(s ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/([_*[\]()])/g, '\\$1');

/** Gửi tin nhắn text (Markdown). */
const sendMessage = async (chatId, text, extra = {}) =>
  callApi('sendMessage', {
    chat_id: chatId,
    text: clip(text),
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...extra,
  });

/** Inline keyboard Duyệt/Từ chối cho 1 gate. callback_data ≤64 bytes của Telegram. */
const gateKeyboard = (gateId) => ({
  reply_markup: {
    inline_keyboard: [[
      { text: '✅ Duyệt', callback_data: `gate:${gateId}:APPROVED` },
      { text: '❌ Từ chối', callback_data: `gate:${gateId}:REJECTED` },
    ]],
  },
});

/** Tin gate: tóm tắt + nút duyệt. Dùng khi tạo PO/chi/nhắc nợ qua agent. */
const sendGateCard = async (chatId, gate) => {
  const amount = gate?.actionPayload?.totalEstimate ?? gate?.actionPayload?.remaining ?? '';
  const lines = [
    '🔔 *Yêu cầu phê duyệt*',
    `• Loại: \`${escapeMd(gate.actionType)}\``,
    `• Nội dung: ${escapeMd(gate.actionSummary)}`,
    amount !== '' ? `• Số tiền ước tính: *${Number(amount).toLocaleString('vi-VN')}đ*` : null,
    `• Hết hạn: ${escapeMd(new Date(gate.expiresAt).toLocaleString('vi-VN'))}`,
    '',
    '_Bấm nút bên dưới để duyệt/từ chối. Từ chối cần nhập lý do (nhắn /decide)._',
  ].filter(Boolean);
  return sendMessage(chatId, lines.join('\n'), gateKeyboard(gate.id));
};

/** Trả lời callback query (tắt spinner + hiện toast). */
const answerCallback = async (callbackQueryId, text = '', showAlert = false) =>
  callApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text: String(text).slice(0, 200), show_alert: showAlert });

/** Chuyển reply của agent + citation sang khối trích dẫn Telegram (Phase 2). */
const formatCitedReply = (text, citations = []) => {
  let out = clip(text, 3000);
  if (citations.length) {
    out += '\n\n📚 *Nguồn:*';
    citations.slice(0, 5).forEach((c, i) => {
      out += `\n${i + 1}. *${escapeMd(c.docTitle)}* — ${escapeMd(c.section || '')} (độ khớp ${Math.round((c.similarity || 0) * 100)}%)`
        + `\n> ${escapeMd(String(c.quote || '').slice(0, 200))}`;
    });
  }
  return out;
};

module.exports = {
  isConfigured,
  sendMessage,
  sendGateCard,
  gateKeyboard,
  answerCallback,
  formatCitedReply,
  escapeMd,
  clip,
};
