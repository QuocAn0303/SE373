/**
 * modules/ai/internal-doc-ingest.service.js — Ingest InternalDocument → ai_documents (HERMES Phase 2)
 *
 * - Chunk ~500 token + overlap, entityType='internal_doc', metadata {docId, version, section}.
 * - Re-index khi tài liệu sửa (version bump = updatedAt): xoá chunk cũ của docId rồi ghi mới.
 * - Unique per-tenant: entityId = `${tenantId}:${docId}:${idx}` (sửa mitigation tạm:
 *   unique cũ chỉ (entityType, entityId) nên 2 tenant cùng docId đè nhau).
 * - Bảng ai_* @@ignore trong Prisma schema → mọi truy vấn qua $queryRawUnsafe /
 *   $executeRawUnsafe (đúng convention ai.service.js hiện tại).
 */
const logger = require('../../utils/logger');
const { getTenantId } = require('../../config/tenantContext');

const CHUNK_CHARS = 2000; // ≈500 token
const OVERLAP_CHARS = 200;

const chunkText = (text) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const out = [];
  let start = 0;
  let idx = 0;
  while (start < t.length) {
    const end = Math.min(start + CHUNK_CHARS, t.length);
    out.push({ idx: idx++, content: t.slice(start, end) });
    if (end >= t.length) break;
    start = end - OVERLAP_CHARS;
  }
  return out;
};

/** Đọc nội dung tài liệu: ưu tiên description (seed/metadata-only), fileUrl seed:// bỏ qua fetch. */
const docText = (doc) => `${doc.title || ''}\n${doc.description || ''}`.trim();

/** Ingest 1 tài liệu (xoá chunk cũ → ghi chunk mới). Trả về số chunk. */
const ingestDocument = async (docId, opts = {}) => {
  const prisma = require('../../config/prisma');
  const tenantId = opts.tenantId || getTenantId() || null;
  const doc = await prisma.internalDocument.findFirst({ where: { id: docId } });
  if (!doc) throw Object.assign(new Error('Tài liệu không tồn tại'), { status: 404 });
  const chunks = chunkText(docText(doc));
  const version = new Date(doc.updatedAt || doc.createdAt || Date.now()).toISOString();

  // Xoá chunk cũ của doc này (re-index khi sửa). Tagged template nội suy giá trị
  // thành tham số $1..$n của Postgres — không phải nối chuỗi, nên không có
  // đường SQL injection và không bị scanner đánh dấu `Unsafe`.
  await prisma.$executeRaw`
    DELETE FROM ai_documents
     WHERE entity_type = 'internal_doc'
       AND (metadata->>'docId') = ${doc.id}
       AND ("tenant_id" = ${tenantId} OR (${tenantId} IS NULL AND "tenant_id" IS NULL))
  `;
  for (const c of chunks) {
    const entityId = `${tenantId || 'global'}:${doc.id}:${c.idx}`;
    await prisma.$executeRaw`
      INSERT INTO ai_documents (entity_type, entity_id, content, metadata, "tenant_id")
      VALUES ('internal_doc', ${entityId}, ${c.content}, ${JSON.stringify({
        docId: doc.id, version, section: doc.title, tenantTag: 'mophong',
      })}::jsonb, ${tenantId})
      ON CONFLICT (entity_type, entity_id)
      DO UPDATE SET content = EXCLUDED.content, metadata = EXCLUDED.metadata, updated_at = now()
    `;
  }
  logger.info(`[ingest] internal_doc ${doc.id} → ${chunks.length} chunk(s) (tenant=${tenantId || 'global'})`);
  return { docId: doc.id, chunks: chunks.length, version };
};

/** Ingest toàn bộ tài liệu trong tenant (dùng cho seed/backfill). */
const ingestAll = async (opts = {}) => {
  const prisma = require('../../config/prisma');
  const docs = await prisma.internalDocument.findMany({ select: { id: true }, take: opts.limit || 200 });
  const results = [];
  for (const d of docs) {
    try {
      results.push(await ingestDocument(d.id, opts));
    } catch (e) {
      logger.warn(`[ingest] bỏ qua ${d.id}: ${e.message}`);
    }
  }
  return results;
};

module.exports = { ingestDocument, ingestAll, chunkText, CHUNK_CHARS, OVERLAP_CHARS };
