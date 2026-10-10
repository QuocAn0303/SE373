/**
 * config/llm.js — Cấu hình + client LLM cloud (Gemini / OpenAI-compatible)
 *
 * Vì sao không dùng global fetch: trên mạng WiFi này DNS trả AAAA trước và máy KHÔNG có
 * IPv6 default route, nên fetch() của Node bị treo → request chết lặng. Ở đây dùng
 * https.request với `family: 4` để cưỡng chế IPv4, không phụ thuộc DNS/OS.
 *
 * Biến môi trường (xem .env / .env.example):
 *   LLM_PROVIDER     gemini | openai-compatible | local   (mặc định: gemini nếu có key)
 *   GEMINI_API_KEY   API key của Google AI Studio
 *   LLM_MODEL        model id, ví dụ gemini-3.8-flash
 *   LLM_BASE_URL     ghi đè endpoint (dùng cho gateway OpenAI-compatible)
 *   LLM_TIMEOUT_MS   timeout mỗi request (mặc định 60000)
 *
 * Hàm/Exports:
 *   - isConfigured(): có provider cloud dùng được không
 *   - describe(): thông tin provider (không lộ key)
 *   - generateText({ system, prompt, jsonMode, task }): trả về chuỗi trả lời
 *   - getLastUsage(): token của lần gọi gần nhất (đọc `usageMetadata`)
 *   - listModels(): danh sách model của provider (chẩn đoán)
 *   - parseJsonLoose(text): parse JSON bỏ qua code fence
 *
 * T13 (2026-10-03) — SỔ GHI TOKEN:
 *   `callModel` trước đây bỏ qua hoàn toàn `json.usageMetadata` ⇒ không biết tốn
 *   bao nhiêu token. Nay đọc `promptTokenCount / candidatesTokenCount /
 *   totalTokenCount`, giữ vào `lastUsage`, và ghi MỘT dòng `LlmUsageLog` cho mỗi
 *   lần gọi (kể cả lần thất bại). Đây là đường LLM DUY NHẤT của hệ thống: mọi vai
 *   trò LLM (khớp SKU, giải thích, soạn tin NCC) đều đi qua `generateText` nên
 *   không có đường nào gọi model mà không ghi token.
 */
const https = require("https");
const logger = require("../utils/logger");
const { getTenantId } = require("./tenantContext");

const DEFAULT_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

const config = () => {
  // HERMES Phase 0 — LLM UIT qua gateway OpenAI-compatible:
  //   LLM_PROVIDER=openai-compatible
  //   LLM_BASE_URL=https://llm.uit.edu.vn/gemma/v1 (+ LLM_API_KEY)
  //   LLM_MODEL=gemma-4-26b
  //   LLM_REASONING_BASE_URL=https://llm.uit.edu.vn/qwen/v1 (Qwen thinking)
  //   LLM_REASONING_MODEL=qwen3.8-27b
  // Ngoài mạng trường/VPN → fallback Gemini cloud free (LLM_PROVIDER=gemini).
  const key = process.env.LLM_API_KEY || process.env.GEMINI_API_KEY || "";
  const provider = (process.env.LLM_PROVIDER || (key ? "gemini" : "local")).toLowerCase();
  return {
    provider,
    apiKey: key,
    model: process.env.LLM_MODEL || "gemini-3.8-flash",
    baseUrl: (process.env.LLM_BASE_URL || DEFAULT_GEMINI_BASE).replace(/\/$/, ""),
    reasoningBaseUrl: (process.env.LLM_REASONING_BASE_URL || "").replace(/\/$/, ""),
    reasoningModel: process.env.LLM_REASONING_MODEL || "",
    reasoningKey: process.env.LLM_REASONING_API_KEY || key,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 60000,
  };
};

const isConfigured = () => {
  const c = config();
  return c.provider !== "local" && Boolean(c.apiKey || c.provider === "openai-compatible");
};

/** Cấu hình model suy luận (Qwen thinking). Null khi chưa cấu hình. */
const reasoningConfig = () => {
  const c = config();
  if (!c.reasoningBaseUrl || !c.reasoningModel) return null;
  return { baseUrl: c.reasoningBaseUrl, model: c.reasoningModel, apiKey: c.reasoningKey };
};

const describe = () => {
  const c = config();
  return { provider: c.provider, model: c.model, baseUrl: c.baseUrl, configured: isConfigured() };
};

/** POST JSON ép IPv4, có timeout. Không dùng fetch (xem giải thích đầu file). */
const requestJson = (url, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        family: 4, // bắt buộc: máy này không có IPv6 default route
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...headers },
        timeout: config().timeoutMs,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { /* giữ raw */ }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
          const apiMsg = json?.error?.message || raw.slice(0, 300);
          const err = new Error(`Gemini HTTP ${res.statusCode}: ${apiMsg}`);
          err.status = res.statusCode;
          // 503 = quá tải tạm thời (model đông người) → thử lại hoặc đổi model.
          // 429 = hết quota/rate-limit → cần chờ lâu hơn, không đổi model cũng vô ích.
          // 401/403 = key sai, 404 = model sai → không retry, fail ngay.
          err.retryable = res.statusCode === 503 || res.statusCode === 429 || res.statusCode === 500;
          if (res.statusCode === 429) {
            const ra = Number(res.headers?.["retry-after"]);
            err.rateLimited = true;
            err.retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 5000;
          }
          if (res.statusCode === 401 || res.statusCode === 403) err.hint = " (key không hợp lệ hoặc bị chặn)";
          if (res.statusCode === 404) err.hint = " (LLM_MODEL không tồn tại — chạy: npm run check:llm)";
          return reject(err);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Gemini timeout sau ${config().timeoutMs}ms`)));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

/** GET JSON ép IPv4 (dùng cho listModels). */
const getJson = (url) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      { hostname: target.hostname, path: `${target.pathname}${target.search}`, method: "GET", family: 4, timeout: config().timeoutMs },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { /* ignore */ }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
          return reject(new Error(`Gemini HTTP ${res.statusCode}: ${json?.error?.message || raw.slice(0, 300)}`));
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Gemini timeout")));
    req.on("error", reject);
    req.end();
  });

/**
 * Gọi Gemini generateContent. Trả về chuỗi text.
 * jsonMode: yêu cầu model trả về JSON hợp lệ (dùng cho tool-calling).
 *
 * Chịu được tình huống model chính bị quá tải (503 high demand):
 * retry 2 lần trên cùng model, rồi lùi dần qua LLM_FALLBACK_MODELS.
 * Lỗi key/model sai (401/403/404) thì fail ngay, không retry.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fallbackModels = () => {
  const raw = process.env.LLM_FALLBACK_MODELS;
  if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  // KHÔNG dùng gemini-2.5-flash: tài khoản mới bị 404 "no longer available to new users".
  return ["gemini-flash-latest", "gemini-3.7-flash", "gemini-3.5-flash"];
};

// Model đã biết chạy được trong phiên này → bỏ qua thử các model trước đó.
let activeModel = null;

// ── T13: sổ ghi token ──────────────────────────────────────────────────────
/** Token của lần gọi gần nhất. Đọc-sao để caller không sửa được giá trị đã ghi. */
let lastUsage = null;
const getLastUsage = () => (lastUsage ? { ...lastUsage } : null);
const resetLastUsage = () => {
  lastUsage = null;
};

/**
 * Chuẩn hoá `usageMetadata` của Gemini. Trả về số nguyên ≥ 0, thiếu thì 0 —
 * KHÔNG đoán: thiếu `usageMetadata` nghĩa là provider không báo, ghi 0 và để
 * `succeeded` nói thật chuyện gì đã xảy ra.
 */
const readUsage = (json) => {
  const u = json?.usageMetadata || {};
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.trunc(Number(v)) : 0);
  return {
    promptTokens: n(u.promptTokenCount),
    completionTokens: n(u.candidatesTokenCount),
    totalTokens: n(u.totalTokenCount) || n(u.promptTokenCount) + n(u.candidatesTokenCount),
  };
};

/**
 * Ghi 1 dòng `LlmUsageLog`.
 *
 * VÌ SAO KHÔNG NÉM LỖI: ghi token là SỔ ĐO, không phải luồng nghiệp vụ. Một lần gọi
 * LLM đã thành công thì không được đổi thành lỗi 500 chỉ vì bảng sổ ghi lỗi. Vì vậy
 * lỗi ở đây chỉ `logger.error` (không nuốt im lặng) — và chính vì thế mọi kiểm chứng
 * về `LlmUsageLog` đều là smoke trên DB thật (`smoke:llm-usage`), không phải unit test.
 *
 * `tenantId` lấy từ AsyncLocalStorage (`getTenantId`). Ngoài tenant context thì ghi
 * NULL — đúng như thiết kế bảng: phân biệt "lỗi" với "không thuộc tenant nào".
 */
const recordUsage = async ({ task, provider, model, mode, usage, latencyMs, succeeded, promptText, responseText }) => {
  try {
    if (process.env.LLM_USAGE_LOG === "0") return null;
    // Lazy require: `config/prisma` nặng và không cần cho các call site chỉ đọc text.
    const prisma = require("./prisma");
    return await prisma.llmUsageLog.create({
      data: {
        tenantId: getTenantId(),
        task: task || "OTHER",
        provider: provider || "unknown",
        model: model || "unknown",
        mode: mode || "live",
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        latencyMs: Math.max(0, Math.trunc(Number(latencyMs) || 0)),
        succeeded: succeeded === true,
        ...(promptText ? { promptText: String(promptText) } : {}),
        ...(responseText ? { responseText: String(responseText) } : {}),
      },
    });
  } catch (e) {
    logger.error(`[LLM] ghi LlmUsageLog THẤT BẠI (task=${task}, model=${model}): ${e.message}`);
    return null;
  }
};

/**
 * Gọi gateway OpenAI-compatible (llm.uit.edu.vn/gemma|qwen/v1).
 * Tách reasoning_content khỏi content ở tầng parse (Qwen bật thinking trả cả hai).
 * Trả về { text, reasoning, usage } — reasoning giữ lại để log/debug, KHÔNG
 * đưa vào reply cho user.
 */
const callOpenAICompatible = async ({ baseUrl, apiKey, model, system, prompt, jsonMode, temperature, maxOutputTokens }) => {
  const httpMod = String(baseUrl).startsWith('http://') ? require('http') : require('https');
  const target = new URL(`${baseUrl.replace(/\/$/, '')}/chat/completions`);
  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: prompt },
  ];
  const payload = JSON.stringify({
    model,
    messages,
    temperature,
    max_tokens: Math.max(maxOutputTokens || 2048, 2000),
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  });
  const json = await new Promise((resolve, reject) => {
    const req = httpMod.request(
      {
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        family: 4,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        timeout: config().timeoutMs,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(raw); } catch { /* giữ raw */ }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(j);
          const err = new Error(`OpenAI-compatible HTTP ${res.statusCode}: ${(j?.error?.message || raw).slice(0, 300)}`);
          err.status = res.statusCode;
          err.retryable = [429, 500, 502, 503].includes(res.statusCode);
          return reject(err);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`LLM timeout sau ${config().timeoutMs}ms`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
  const choice = json?.choices?.[0]?.message || {};
  const text = String(choice.content || '').trim();
  const reasoning = choice.reasoning_content || choice.reasoning || null;
  if (!text) throw Object.assign(new Error('LLM UIT không trả về nội dung'), { retryable: true });
  const u = json?.usage || {};
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.trunc(Number(v)) : 0);
  return { text, reasoning, usage: { promptTokens: n(u.prompt_tokens), completionTokens: n(u.completion_tokens), totalTokens: n(u.total_tokens) || n(u.prompt_tokens) + n(u.completion_tokens) } };
};

const callModel = async (model, { system, prompt, jsonMode, temperature, maxOutputTokens, reasoning = false }) => {
  const c = config();
  // HERMES: reasoning=true + có cấu hình Qwen riêng → đi đường Qwen thinking.
  if (reasoning && c.reasoningBaseUrl && c.reasoningModel) {
    return callOpenAICompatible({
      baseUrl: c.reasoningBaseUrl, apiKey: c.reasoningKey, model: c.reasoningModel,
      system, prompt, jsonMode, temperature, maxOutputTokens,
    });
  }
  if (c.provider === 'openai-compatible') {
    return callOpenAICompatible({
      baseUrl: c.baseUrl, apiKey: c.apiKey, model,
      system, prompt, jsonMode, temperature, maxOutputTokens,
    });
  }
  const url = `${c.baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(c.apiKey)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens, ...(jsonMode ? { responseMimeType: "application/json" } : {}) },
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };
  const json = await requestJson(url, body);
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  if (!text) {
    const reason = json?.candidates?.[0]?.finishReason || json?.promptFeedback?.blockReason || "khong ro";
    const err = new Error(`Gemini khong tra ve noi dung (finishReason=${reason})`);
    // Model dòng 3.x nghĩ bằng thinking token: budget nhỏ sẽ bị MAX_TOKENS và không còn text.
    // Đánh dấu cần thử lại với budget lớn hơn thay vì fail thẳng.
    err.retryable = reason === "MAX_TOKENS";
    err.needsMoreTokens = reason === "MAX_TOKENS";
    throw err;
  }
  // `usageMetadata` nằm cạnh `candidates`, không nằm trong candidate — đọc sai chỗ là
  // mất toàn bộ số liệu token (đúng lỗi mà T13 sửa).
  return { text, usage: readUsage(json) };
};

const generateText = async (opts = {}) => {
  const c = config();
  if (!isConfigured()) {
    throw new Error(`Chua cau hinh LLM cloud (LLM_PROVIDER=${c.provider}). Can GEMINI_API_KEY trong .env`);
  }
  const { system, prompt, jsonMode = false, temperature = 0.2, maxOutputTokens = 2048, reasoning = false } = opts;
  const task = opts.task || "OTHER";
  const startedAt = Date.now();
  // HERMES: đường UIT openai-compatible chỉ có 1 model chính (+ Qwen reasoning),
  // không có fallback chain Gemini. Gọi thẳng để LlmUsageLog.provider ghi đúng.
  if (c.provider === "openai-compatible") {
    const rc = reasoning ? reasoningConfig() : null;
    const useModel = reasoning && rc ? rc.model : (opts.model || c.model);
    try {
      const { text, usage } = reasoning && rc
        ? await callOpenAICompatible({ baseUrl: rc.baseUrl, apiKey: rc.apiKey, model: rc.model, system, prompt, jsonMode, temperature, maxOutputTokens })
        : await callModel(useModel, { system, prompt, jsonMode, temperature, maxOutputTokens });
      lastUsage = { task, provider: c.provider, model: useModel, ...usage, latencyMs: Date.now() - startedAt };
      await recordUsage({ task, provider: c.provider, model: useModel, mode: opts.mode || "live", usage, latencyMs: lastUsage.latencyMs, succeeded: true });
      return text;
    } catch (e) {
      await recordUsage({ task, provider: c.provider, model: useModel, mode: opts.mode || "live", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, latencyMs: Date.now() - startedAt, succeeded: false, responseText: String(e.message).slice(0, 500) });
      // Ràng buộc mạng UIT (chỉ trong mạng trường/VPN): lỗi mạng → caller
      // (orchestrator) tự fallback Gemini theo llm-policy, ở đây chỉ ném rõ.
      throw new Error(`${e.message} (LLM UIT — kiểm tra mạng trường/VPN + LLM_BASE_URL)`);
    }
  }

  const primary = activeModel || c.model;
  const chain = [primary, ...fallbackModels().filter((m) => m !== primary)];
  let lastErr = null;

  for (const model of chain) {
    let budget = maxOutputTokens;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { text, usage } = await callModel(model, { system, prompt, jsonMode, temperature, maxOutputTokens: budget });
        if (activeModel && activeModel !== model) {
          logger.warn(`[LLM] chuyen sang model ${model} (thay cho ${c.model})`);
        }
        activeModel = model;
        logger.debug(`[LLM] ${model} ok, ${text.length} ky tu`);
        lastUsage = { task, provider: c.provider, model, ...usage, latencyMs: Date.now() - startedAt };
        await recordUsage({ task, provider: c.provider, model, mode: opts.mode || "live", usage, latencyMs: lastUsage.latencyMs, succeeded: true });
        return text;
      } catch (e) {
        lastErr = e;
        // Đơn vị ghi là MỘT lần gọi logic (một `generateText`), không phải mỗi HTTP
        // attempt: retry cùng model không tạo dòng riêng, nếu không thì lần 503 rồi
        // thành công sẽ ra 2 dòng cho 1 quyết định. Lần gọi cuối cùng thất bại thì vẫn
        // ghi 1 dòng (token 0, latency thật) — không ghi thì "tiền đi không" không đo được.
        if (!e.retryable) {
          await recordUsage({ task, provider: c.provider, model, mode: opts.mode || "live", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, latencyMs: Date.now() - startedAt, succeeded: false, responseText: String(e.message).slice(0, 500) });
          throw new Error(`${e.message}${e.hint || ""}`);
        }
        if (e.needsMoreTokens) {
          budget = Math.max(budget * 4, 8192);
          logger.warn(`[LLM] ${model} het token budget → tang len ${budget}`);
          continue;
        }
        // 429 = rate-limit: chờ lâu hơn (hoặc đúng retry-after) rồi thử model kế tiếp.
        // 503 = quá tải: chờ ngắn rồi đổi model.
        const wait = e.rateLimited ? Math.min(e.retryAfterMs || 5000, 20000) : 1200;
        logger.warn(`[LLM] ${model} loi tam thoi (${e.status || "?"}), cho ${wait}ms roi thu tiep...`);
        await sleep(wait);
      }
    }
  }
  await recordUsage({ task, provider: c.provider, model: primary, mode: opts.mode || "live", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, latencyMs: Date.now() - startedAt, succeeded: false, responseText: String(lastErr?.message || "LLM that bai").slice(0, 500) });
  throw new Error(`${lastErr?.message || "LLM that bai"} (da thu: ${chain.join(", ")})`);
};

/** Bo code fence + parse JSON, chiu duoc model tra them text thua. */
const parseJsonLoose = (text) => {
  const cleaned = String(text).replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(cleaned); } catch { /* thu cat object dau-cuoi */ }
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(cleaned.slice(first, last + 1)); } catch { /* bo cuoc */ }
  }
  return null;
};

const listModels = async () => {
  const c = config();
  if (!isConfigured()) throw new Error("Chua cau hinh LLM cloud (thieu GEMINI_API_KEY / LLM_API_KEY)");
  if (c.provider === "openai-compatible") {
    // Gateway UIT không có endpoint /models chuẩn — trả về model đã cấu hình
    // để check:llm vẫn xanh khi gọi được.
    return [c.model, ...(c.reasoningModel ? [c.reasoningModel] : [])].filter(Boolean);
  }
  const json = await getJson(`${c.baseUrl}/models?key=${encodeURIComponent(c.apiKey)}&pageSize=100`);
  return (json.models || []).map((m) => m.name.replace(/^models\//, ""));
};

module.exports = { isConfigured, describe, reasoningConfig, generateText, listModels, parseJsonLoose, config, getLastUsage, resetLastUsage, readUsage };

