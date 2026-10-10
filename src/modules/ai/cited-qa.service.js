/**
 * modules/ai/cited-qa.service.js — Hỏi đáp quy trình có trích dẫn (HERMES Phase 2)
 *
 * - Nguồn duy nhất: InternalDocument trong tenant, tôn trọng visibility phòng ban
 *   (InternalDocumentDepartment: tài liệu phòng nào chỉ user thuộc phòng đó thấy;
 *   sendToAll=true thì mọi phòng thấy).
 * - Citation thật {docId, docTitle, section, quote, similarity}; system prompt bắt
 *   LLM chỉ dùng nguồn được đưa (model bịa sự kiện cụ thể — xem plan §5).
 * - Thiếu nguồn → "không tìm thấy trong tài liệu" + gợi ý người phụ trách.
 */
const logger = require('../../utils/logger');

const strip = (s) => String(s || '').toLowerCase();
const tokens = (s) => strip(s).split(/[^a-z0-9à-ỹđ]+/i).filter((w) => w.length > 1);

/** Điểm khớp keyword giữa câu hỏi và đoạn văn (0..1). */
const similarity = (question, passage) => {
  const q = new Set(tokens(question));
  if (!q.size) return 0;
  const p = new Set(tokens(passage));
  let hit = 0;
  for (const w of q) if (p.has(w)) hit += 1;
  return hit / q.size;
};

/** Phòng ban của user (code). */
const userDeptCode = async (prisma, user) => {
  if (user?.deptCode) return user.deptCode;
  try {
    const full = await prisma.user.findUnique({
      where: { id: user.id },
      select: { department: { select: { code: true } }, employee: { select: { department: { select: { code: true } } } } },
    }).catch(() => null);
    return full?.department?.code || full?.employee?.department?.code || null;
  } catch { return null; }
};

/** Tài liệu user được thấy (visibility phòng ban). */
const visibleDocuments = async (prisma, user) => {
  const docs = await prisma.internalDocument.findMany({
    include: { departments: { include: { department: { select: { id: true, code: true, name: true } } } } },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  });
  const deptCode = await userDeptCode(prisma, user);
  let deptId = null;
  if (deptCode) {
    const d = await prisma.department.findFirst({ where: { code: deptCode }, select: { id: true } }).catch(() => null);
    deptId = d?.id || null;
  }
  // ADMIN thấy tất cả (quản trị tài liệu); phòng khác chỉ thấy sendToAll hoặc
  // tài liệu gắn đúng phòng mình.
  if (['ADMIN', 'SUPER_ADMIN', 'SUPER_OMEGA_ULTRA_ADMIN', 'MANAGER'].includes(user?.role)) return docs;
  return docs.filter((doc) => {
    if (doc.sendToAll) return true;
    if (!doc.departments || !doc.departments.length) return true; // không gắn phòng = chung
    return deptId && doc.departments.some((link) => link.departmentId === deptId);
  });
};

const splitSections = (doc) => {
  // Tách theo "ĐIỀU N." để có section + quote kiểm chứng được.
  const body = `${doc.title}\n${doc.description || ''}`;
  const parts = body.split(/(ĐIỀU\s+\d+\.?)/i);
  if (parts.length <= 1) return [{ section: doc.title, quote: body.slice(0, 500) }];
  const out = [];
  for (let i = 1; i < parts.length; i += 2) {
    const section = `${parts[i] || ''} ${(parts[i + 1] || '').slice(0, 60)}`.trim();
    const quote = `${parts[i] || ''}${parts[i + 1] || ''}`.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (quote) out.push({ section: section.slice(0, 120), quote });
  }
  return out.length ? out : [{ section: doc.title, quote: body.slice(0, 500) }];
};

/**
 * Trả lời có trích dẫn. Không bao giờ bịa: thiếu nguồn → từ chối + gợi ý.
 * @returns {{answer, citations, visibleCount}}
 */
const answerWithCitations = async (question, user, opts = {}) => {
  const prisma = require('../../config/prisma');
  const docs = await visibleDocuments(prisma, user);
  const scored = [];
  for (const doc of docs) {
    for (const sec of splitSections(doc)) {
      const sim = similarity(question, `${doc.title} ${sec.quote}`);
      if (sim > 0) scored.push({ doc, ...sec, similarity: sim });
    }
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  const top = scored.slice(0, 3);

  if (!top.length || top[0].similarity < 0.15) {
    return {
      answer: 'Mình không tìm thấy nội dung này trong tài liệu nội bộ. Bạn hỏi quản lý trực tiếp hoặc bổ sung tài liệu rồi hỏi lại nhé.',
      citations: [],
      visibleCount: docs.length,
    };
  }

  // LLM chỉ diễn đạt lại nguồn (không bịa sự kiện): có LLM thì paraphrase,
  // không thì ghép quote. Số liệu/quy định lấy nguyên văn từ quote.
  let answer = top.map((c, i) => `${i + 1}. ${c.quote} _(theo "${c.doc.title}" — ${c.section})_`).join('\n');
  try {
    const policy = require('../../config/llm-policy');
    const r = await policy.callTask('CITED_QA', {
      system: [
        'Bạn tóm tắt quy trình nội bộ bằng TIẾNG VIỆT.',
        'CHỈ dùng nguồn được đưa — không thêm sự kiện/quy định ngoài nguồn.',
        'Thiếu nguồn thì trả đúng câu: không tìm thấy trong tài liệu.',
      ].join('\n'),
      prompt: `Câu hỏi: ${question}\nNguồn:\n${top.map((c) => `- [${c.doc.title} | ${c.section}] ${c.quote}`).join('\n')}\nTóm tắt ngắn gọn, giữ nguyên ngưỡng/tên người duyệt.`,
      maxOutputTokens: 1024,
    });
    if (r && r.ok === true && r.text) answer = r.text;
  } catch (e) {
    logger.warn(`[cited-qa] paraphrase bỏ qua: ${e.message}`);
  }

  return {
    answer,
    citations: top.map((c) => ({
      docId: c.doc.id, docTitle: c.doc.title, section: c.section, quote: c.quote,
      similarity: Math.round(c.similarity * 100) / 100,
    })),
    visibleCount: docs.length,
  };
};

module.exports = { answerWithCitations, visibleDocuments, similarity, splitSections, userDeptCode };
