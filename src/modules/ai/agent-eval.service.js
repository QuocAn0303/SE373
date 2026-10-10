/**
 * modules/ai/agent-eval.service.js — Eval vận hành agent (HERMES Phase 6)
 *
 * - Intent-routing P/R/F1 (so AgentSession.intent với nhãn tay), citation accuracy
 *   (cần nhãn tay), gate SLA (duyệt < Xh), tỷ lệ approve/reject, token/user.
 * - Theo chuẩn llm:eval — KHÔNG nhãn tay thì từ chối publish (refuse, không bịa số).
 */
const logger = require('../../utils/logger');

/** P/R/F1 cho intent-routing từ cặp (predicted, label). */
const prf1 = (pairs) => {
  const labels = new Set([...pairs.map((p) => p.predicted), ...pairs.map((p) => p.label)].filter(Boolean));
  const perLabel = {};
  for (const lb of labels) {
    const tp = pairs.filter((p) => p.predicted === lb && p.label === lb).length;
    const fp = pairs.filter((p) => p.predicted === lb && p.label !== lb).length;
    const fn = pairs.filter((p) => p.predicted !== lb && p.label === lb).length;
    const p = tp + fp ? tp / (tp + fp) : 0;
    const r = tp + fn ? tp / (tp + fn) : 0;
    perLabel[lb] = { precision: p, recall: r, f1: p + r ? (2 * p * r) / (p + r) : 0, support: tp + fn };
  }
  const n = pairs.length || 1;
  const macro = (k) => Object.values(perLabel).reduce((s, v) => s + v[k], 0) / Math.max(Object.keys(perLabel).length, 1);
  const acc = pairs.filter((p) => p.predicted === p.label).length / n;
  return { accuracy: acc, macroP: macro('precision'), macroR: macro('recall'), macroF1: macro('f1'), perLabel, n };
};

/**
 * Eval tổng hợp từ DB. labels: [{ sessionId, intent }] và citeLabels:
 * [{ question, citedDocId, correct: bool }] do người gán tay.
 * Thiếu labels → { refused: true } (không publish số khống).
 */
const evaluate = async ({ intentLabels = null, citeLabels = null, gateSlaHours = 4 } = {}) => {
  const prisma = require('../../config/prisma');
  if (!Array.isArray(intentLabels) || !intentLabels.length) {
    return { refused: true, reason: 'Thiếu nhãn intent gán tay — từ chối publish (chuẩn llm:eval)' };
  }
  const sessions = await prisma.agentSession.findMany({
    where: { id: { in: intentLabels.map((l) => l.sessionId) } },
    select: { id: true, intent: true },
  });
  const byId = new Map(sessions.map((s) => [s.id, s.intent]));
  const pairs = intentLabels
    .filter((l) => byId.has(l.sessionId))
    .map((l) => ({ predicted: byId.get(l.sessionId), label: l.intent }));
  const routing = prf1(pairs);

  let citation = { refused: true, reason: 'Thiếu nhãn citation gán tay' };
  if (Array.isArray(citeLabels) && citeLabels.length) {
    const ok = citeLabels.filter((c) => c.correct).length;
    citation = { accuracy: ok / citeLabels.length, n: citeLabels.length, refused: false };
  }

  const gates = await prisma.agentHumanGate.findMany({
    where: { decidedAt: { not: null } },
    select: { status: true, createdAt: true, decidedAt: true },
    take: 500,
    orderBy: { createdAt: 'desc' },
  }).catch(() => []);
  const approved = gates.filter((g) => g.status === 'APPROVED').length;
  const rejected = gates.filter((g) => g.status === 'REJECTED').length;
  const slaOk = gates.filter((g) => (new Date(g.decidedAt) - new Date(g.createdAt)) <= gateSlaHours * 3600000).length;
  const usage = await prisma.llmUsageLog.groupBy({
    by: ['task'], _sum: { totalTokens: true }, _count: { task: true },
  }).catch(() => []);

  return {
    refused: false,
    routing, citation,
    gates: {
      total: gates.length, approved, rejected,
      approveRate: gates.length ? approved / gates.length : 0,
      slaHitRate: gates.length ? slaOk / gates.length : 0,
      slaHours: gateSlaHours,
    },
    tokens: usage.map((u) => ({ task: u.task, calls: u._count.task, totalTokens: u._sum.totalTokens })),
    at: new Date().toISOString(),
  };
};

module.exports = { evaluate, prf1 };
