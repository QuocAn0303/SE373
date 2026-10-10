/**
 * prisma/seed_candora.js — Seed công ty hư cấu CANDORA (HERMES Phase 0)
 *
 * Tenant `candora-demo` (chuỗi bán lẻ, template `business`): 6 Department
 * (SALES, MARKETING, HR, ACCOUNTING, CSKH, OPS), mỗi phòng ≥2 user đúng role,
 * CompanySettings + 5 InternalDocument mẫu, DeptBudget mẫu tháng hiện tại.
 *
 * - Idempotent: toàn bộ upsert theo unique key, chạy lại không đẻ trùng.
 * - Dry-run mặc định (in kế hoạch, KHÔNG ghi). Ghi thật: --apply
 *   (chuẩn scripts/demo/ensure-demo-login.js).
 * - Mật khẩu mẫu: 123456 (khớp prisma/seed.js). Tenant demo, không dùng production.
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const { runWithTenant } = require('../src/config/tenantContext');
const logger = require('../src/utils/logger');

const APPLY = process.argv.includes('--apply');
const SLUG = 'candora-demo';
const PLAIN_PASSWORD = '123456';

const DEPARTMENTS = [
  { code: 'SALES', name: 'Kinh doanh', description: 'Bán hàng + POS + đơn hàng' },
  { code: 'MARKETING', name: 'Marketing', description: 'Chiến dịch + phân khúc KH' },
  { code: 'HR', name: 'Nhân sự', description: 'Chấm công + lương + vi phạm' },
  { code: 'ACCOUNTING', name: 'Kế toán', description: 'Sổ sách + thuế + đối soát' },
  { code: 'CSKH', name: 'Chăm sóc khách hàng', description: 'Đổi trả + nhiệm vụ CSKH' },
  { code: 'OPS', name: 'Vận hành', description: 'Kho + chuyển kho + kiểm kê + sản xuất' },
];

// Mỗi phòng ≥2 user đúng role (Sales→CASHIER/MANAGER, Kế toán→ACCOUNTANT, Vận hành→WAREHOUSE…)
const USERS = [
  { email: 'sales1@candora.demo', fullName: 'CANDORA Sales 1', role: 'CASHIER', dept: 'SALES' },
  { email: 'sales2@candora.demo', fullName: 'CANDORA Sales 2', role: 'MANAGER', dept: 'SALES' },
  { email: 'mkt1@candora.demo', fullName: 'CANDORA MKT 1', role: 'CASHIER', dept: 'MARKETING' },
  { email: 'mkt2@candora.demo', fullName: 'CANDORA MKT 2', role: 'MANAGER', dept: 'MARKETING' },
  { email: 'hr1@candora.demo', fullName: 'CANDORA HR 1', role: 'MANAGER', dept: 'HR' },
  { email: 'hr2@candora.demo', fullName: 'CANDORA HR 2', role: 'CASHIER', dept: 'HR' },
  { email: 'kt1@candora.demo', fullName: 'CANDORA Kế toán 1', role: 'ACCOUNTANT', dept: 'ACCOUNTING' },
  { email: 'kt2@candora.demo', fullName: 'CANDORA Kế toán 2', role: 'ACCOUNTANT', dept: 'ACCOUNTING' },
  { email: 'cskh1@candora.demo', fullName: 'CANDORA CSKH 1', role: 'CASHIER', dept: 'CSKH' },
  { email: 'cskh2@candora.demo', fullName: 'CANDORA CSKH 2', role: 'MANAGER', dept: 'CSKH' },
  { email: 'ops1@candora.demo', fullName: 'CANDORA Vận hành 1', role: 'WAREHOUSE', dept: 'OPS' },
  { email: 'ops2@candora.demo', fullName: 'CANDORA Vận hành 2', role: 'WAREHOUSE', dept: 'OPS' },
  { email: 'admin@candora.demo', fullName: 'CANDORA Admin', role: 'ADMIN', dept: 'SALES' },
];

// 5 tài liệu mẫu (fileUrl trỏ storage nội bộ giả — ingest Phase 2 đọc title/description,
// file thật do admin upload sau; fileSize=0 đánh dấu "metadata-only").
const DOCUMENTS = [
  {
    title: 'Quy trình bán hàng CANDORA',
    description: 'Các bước tạo đơn, thu tiền, in bill, xử lý đổi trả tại quầy.',
    fileName: 'quy-trinh-ban-hang.pdf', fileUrl: 'seed://candora/quy-trinh-ban-hang.pdf',
    fileType: 'application/pdf', fileSize: 0, depts: ['SALES', 'CSKH'],
    body: 'ĐIỀU 1. Mọi đơn hàng phải có mã ORD-YYYYMMDD-XXXX. ĐIỀU 2. Thu tiền trước khi giao hàng trừ khách nợ đã duyệt.',
  },
  {
    title: 'Chính sách chi tiêu CANDORA',
    description: 'Ngưỡng duyệt chi khớp po-template: <5tr, 5–50tr, >50tr.',
    fileName: 'chinh-sach-chi-tieu.pdf', fileUrl: 'seed://candora/chinh-sach-chi-tieu.pdf',
    fileType: 'application/pdf', fileSize: 0, depts: ['ACCOUNTING', 'SALES', 'OPS'],
    body: 'ĐIỀU 1. Chi dưới 5 triệu trong ngân sách phòng được tự duyệt. ĐIỀU 2. Chi 5–50 triệu cần MANAGER phòng duyệt. ĐIỀU 3. Chi trên 50 triệu cần ADMIN duyệt. ĐIỀU 4. Cấm tự duyệt chi cho chính mình.',
  },
  {
    title: 'Quy trình CSKH đổi trả CANDORA',
    description: 'Tiếp nhận đổi trả trong 7 ngày, hoàn tiền qua store-credit.',
    fileName: 'quy-trinh-cskh.pdf', fileUrl: 'seed://candora/quy-trinh-cskh.pdf',
    fileType: 'application/pdf', fileSize: 0, depts: ['CSKH'],
    body: 'ĐIỀU 1. Nhận đổi trả trong 7 ngày với hóa đơn. ĐIỀU 2. Hoàn tiền ưu tiên store-credit, tiền mặt cần MANAGER duyệt.',
  },
  {
    title: 'Nội quy nhân sự CANDORA',
    description: '3 ca MORNING/AFTERNOON/NIGHT, vi phạm LATE/EARLY.',
    fileName: 'noi-quy-nhan-su.pdf', fileUrl: 'seed://candora/noi-quy-nhan-su.pdf',
    fileType: 'application/pdf', fileSize: 0, depts: ['HR'],
    body: 'ĐIỀU 1. Ba ca: SÁNG/CHIỀU/TỐI. ĐIỀU 2. Đi muộn 3 lần/tháng trừ thi đua. ĐIỀU 3. Bảng lương chốt ngày 25.',
  },
  {
    title: 'Quy trình đóng kỳ kế toán CANDORA',
    description: 'Chốt sổ cuối tháng, đối soát ngân hàng trước ngày 28.',
    fileName: 'quy-trinh-dong-ky.pdf', fileUrl: 'seed://candora/quy-trinh-dong-ky.pdf',
    fileType: 'application/pdf', fileSize: 0, depts: ['ACCOUNTING'],
    body: 'ĐIỀU 1. Đối soát ngân hàng trước ngày 28. ĐIỀU 2. Khóa kỳ sau khi ADMIN xác nhận. ĐIỀU 3. Mọi bút toán điều chỉnh phải có ghi chú.',
  },
];

async function main() {
  const prisma = require('../src/config/prisma');
  const plan = [];
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  plan.push(`Tenant: upsert slug=${SLUG} (CANDORA — chuỗi bán lẻ)`);
  plan.push(`Departments: ${DEPARTMENTS.map((d) => d.code).join(', ')} (upsert theo [tenantId, code])`);
  plan.push(`Users: ${USERS.length} (upsert theo email, password 123456)`);
  plan.push(`InternalDocuments: ${DOCUMENTS.length} + visibility theo phòng`);
  plan.push(`DeptBudget: mỗi phòng 50tr tháng ${month}/${year}`);

  if (!APPLY) {
    console.log('[seed_candora] DRY-RUN — chưa ghi gì. Thêm --apply để ghi thật.\n');
    plan.forEach((p) => console.log(`  • ${p}`));
    console.log('\nVí dụ: node prisma/seed_candora.js --apply');
    return;
  }

  const password = await bcrypt.hash(PLAIN_PASSWORD, 12);
  let tenant = await prisma.tenant.findUnique({ where: { slug: SLUG } });
  if (!tenant) {
    tenant = await prisma.tenant.create({ data: { name: 'CANDORA — chuỗi bán lẻ (demo)', slug: SLUG } });
    logger.info(`[seed_candora] created tenant ${tenant.id}`);
  }

  await runWithTenant(tenant.id, async () => {
    const deptByCode = {};
    for (const d of DEPARTMENTS) {
      const existing = await prisma.department.findFirst({ where: { code: d.code } });
      if (existing) {
        deptByCode[d.code] = existing;
        continue;
      }
      deptByCode[d.code] = await prisma.department.create({
        data: { name: d.name, code: d.code, description: d.description, isActive: true },
      });
    }

    for (const u of USERS) {
      const dept = deptByCode[u.dept];
      const found = await prisma.user.findUnique({ where: { email: u.email } });
      if (found) {
        await prisma.user.update({
          where: { email: u.email },
          data: { tenantId: tenant.id, departmentId: dept.id, role: u.role, isActive: true },
        });
        continue;
      }
      const created = await prisma.user.create({
        data: {
          email: u.email, password, fullName: u.fullName, role: u.role,
          tenantId: tenant.id, departmentId: dept.id,
          isActive: true, emailVerified: true, registrationStatus: 'APPROVED',
        },
      });
      if (['HR', 'OPS', 'SALES'].includes(u.dept)) {
        await prisma.employee.create({
          data: { userId: created.id, departmentId: dept.id, position: u.role, isActive: true },
        }).catch(() => null);
      }
    }

    const adminUser = await prisma.user.findUnique({ where: { email: 'admin@candora.demo' } });
    const existingSettings = await prisma.companySettings.findFirst({ where: {} }).catch(() => null);
    if (!existingSettings) {
      await prisma.companySettings.create({
        data: {
          tenantId: tenant.id, name: 'CANDORA', address: '123 Nguyễn Huệ, Q.1, TP.HCM',
          phone: '0900000001', businessTemplate: 'business',
        },
      }).catch(() => null);
    } else {
      await prisma.companySettings.update({
        where: { id: existingSettings.id },
        data: { name: 'CANDORA', businessTemplate: 'business' },
      }).catch(() => null);
    }

    for (const doc of DOCUMENTS) {
      let rec = await prisma.internalDocument.findFirst({ where: { title: doc.title } });
      if (!rec) {
        rec = await prisma.internalDocument.create({
          data: {
            title: doc.title, description: `${doc.description}\n\n${doc.body}`,
            fileName: doc.fileName, fileUrl: doc.fileUrl,
            fileType: doc.fileType, fileSize: doc.fileSize,
            createdBy: adminUser ? adminUser.id : (await prisma.user.findFirst({ where: {} })).id,
            sendToAll: false,
          },
        });
      }
      for (const code of doc.depts) {
        await prisma.internalDocumentDepartment.upsert({
          where: { documentId_departmentId: { documentId: rec.id, departmentId: deptByCode[code].id } },
          create: { documentId: rec.id, departmentId: deptByCode[code].id },
          update: {},
        });
      }
    }

    // DeptBudget mẫu — model mới có thể chưa có trong client cũ → bắt lỗi mềm.
    if (prisma.deptBudget) {
      for (const d of DEPARTMENTS) {
        await prisma.deptBudget.upsert({
          where: {
            tenantId_departmentId_month_year: {
              tenantId: tenant.id, departmentId: deptByCode[d.code].id, month, year,
            },
          },
          create: {
            tenantId: tenant.id, departmentId: deptByCode[d.code].id,
            month, year, limit: 50000000, spent: 0,
          },
          update: {},
        });
      }
    } else {
      logger.warn('[seed_candora] prisma client chưa có DeptBudget — chạy `npx prisma generate` rồi seed lại');
    }

    // Gói business cho tenant demo (để requireModule("ai") không chặn).
    const plan = await prisma.subscriptionPlan.findUnique({ where: { key: 'business' } }).catch(() => null);
    if (plan) {
      const sub = await prisma.tenantSubscription.findFirst({
        where: { tenantId: tenant.id, status: { in: ['ACTIVE', 'TRIAL'] } },
      });
      if (!sub) {
        await prisma.tenantSubscription.create({
          data: {
            tenantId: tenant.id, planId: plan.id, status: 'ACTIVE',
            startDate: new Date(), endDate: new Date(Date.now() + 365 * 86400000),
          },
        });
      }
    }
  });

  console.log(`[seed_candora] DONE tenant=${tenant.id} slug=${SLUG}`);
}

main()
  .catch((e) => { console.error('[seed_candora] FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    try {
      const prisma = require('../src/config/prisma');
      await prisma.$disconnect().catch(() => null);
    } catch { /* ignore */ }
  });
