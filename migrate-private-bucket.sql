-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  ServiceMS — MIGRATION: bucket `attachments` public → private          ║
-- ║  (แก้จุดบกพร่องกลุ่ม 2 · ดู HANDOFF §14)                                ║
-- ║  ใช้กับ instance ที่ "ใช้งานอยู่แล้ว" — instance ใหม่ได้ private จาก     ║
-- ║  schema.sql ตั้งแต่ต้นอยู่แล้ว ไม่ต้องรันไฟล์นี้                          ║
-- ╚══════════════════════════════════════════════════════════════════════╝
--
-- ปัญหาที่แก้:
--   bucket เป็น public:true + policy `select` ทั้ง bucket → เปิดกว้าง 2 ชั้น
--   (1) ใครมีลิงก์/เดา path ได้ → อ่านลายเซ็นลูกค้า เอกสารประกัน รูปซ่อม ได้ทันที
--   (2) policy select ทั้ง bucket → anon key เรียก storage list() ไล่ path ได้ทั้งถัง
--
-- ⚠️ ลำดับสำคัญมาก — ทำผิดลำดับ = รูป/ไฟล์แนบ/รูปใน PDF พังทั้งระบบทันที
--    เพราะ URL ที่เก็บใน DB ทุกคอลัมน์ (attachment_files, before_photos, after_photos,
--    sig_technician, sig_customer, issue_files, team.photo) เป็น URL รูปแบบ public
--
--    STEP 1  ← รันได้ทันที (ไม่กระทบผู้ใช้)
--    STEP 2  ← ต้อง deploy `api` (Edge Function) ชุดใหม่ก่อน   [serverSignUrls + signHtmlUrls]
--    STEP 3  ← ต้อง deploy frontend (index.html) ชุดใหม่ก่อน   [signUrls + openAttachment + observer]
--    STEP 4  ← ตรวจของจริงในเว็บให้ผ่านก่อน แล้วจึงรัน STEP 5
--    STEP 5  ← flip เป็น private (จุดที่พฤติกรรมเปลี่ยนจริง)
--
-- URL ใน DB "ไม่ต้อง migrate" — โค้ดใหม่ใช้เป็นตัวชี้ path แล้วแลกเป็น signed URL ตอนอ่าน
-- ดังนั้น rollback = รัน STEP R ท้ายไฟล์ (เปิด public กลับ) รูปกลับมาทันทีไม่ต้องแก้ข้อมูล


-- ═══════════════════════════════════════════════════════════════════════
-- STEP 1 — ปิดช่องไล่ไฟล์ทั้งถัง (ทำได้เลยวันนี้ · ZERO IMPACT)
-- ═══════════════════════════════════════════════════════════════════════
-- ลบ policy select ทั้ง bucket → anon key เรียก list() ไม่ได้อีก
-- ไม่กระทบรูปที่แสดงอยู่ เพราะ endpoint /object/public/... ของ bucket ที่ public
-- ไม่ผ่าน RLS อยู่แล้ว (policy นี้จำเป็นแค่กับ list / object/authenticated)
drop policy if exists "attachments public read" on storage.objects;

-- ตรวจผล: ต้องได้ 0 แถว
select policyname from pg_policies
 where schemaname = 'storage' and tablename = 'objects'
   and policyname = 'attachments public read';


-- ═══════════════════════════════════════════════════════════════════════
-- STEP 2 / STEP 3 — deploy โค้ด (ไม่ใช่ SQL)
-- ═══════════════════════════════════════════════════════════════════════
--   STEP 2:  supabase functions deploy api      (หรือ Dashboard → Edge Functions → deploy)
--   STEP 3:  deploy index.html ขึ้น Netlify / Cloudflare Pages
-- ทั้ง 2 ขั้นทำได้ตอน bucket ยังเป็น public — signed URL ใช้ได้กับ bucket ทั้งสองแบบ
-- จึงไม่มีช่วงที่ระบบพัง (no downtime window)


-- ═══════════════════════════════════════════════════════════════════════
-- STEP 4 — ตรวจของจริงก่อน flip (ทำในเว็บ ไม่ใช่ SQL) · ต้องผ่านทั้ง 5 ข้อ
-- ═══════════════════════════════════════════════════════════════════════
--   [ ] Team & Scheduling → รูปช่างขึ้นครบ (มาจาก team.photo)
--   [ ] เปิด Handover ที่มีไฟล์แนบ → กด "คลิกเพื่อเปิด" → ไฟล์เปิดได้
--   [ ] กด 📋 Copy ที่ไฟล์แนบ → วาง URL ในแท็บใหม่ → เปิดได้ (URL มี ?token=)
--   [ ] กด 📄 PDF ของ S.R. ที่มีรูป before/after + ลายเซ็น → รูปขึ้นครบในเอกสาร
--   [ ] ลิงก์โครงการที่ผู้ใช้พิมพ์เอง (rec.attachments) → ยังเปิดได้แบบเดิม
-- ถ้าข้อใดไม่ผ่าน → "อย่ารัน STEP 5" แก้โค้ดก่อน (ตอนนี้ยัง public อยู่ ไม่มีอะไรพัง)


-- ═══════════════════════════════════════════════════════════════════════
-- STEP 5 — flip เป็น private  ⚠️ จุดที่พฤติกรรมเปลี่ยนจริง
-- ═══════════════════════════════════════════════════════════════════════
update storage.buckets set public = false where id = 'attachments';

-- ตรวจผล: ต้องได้ public = false
select id, public from storage.buckets where id = 'attachments';

-- หลัง flip: URL รูปแบบ /object/public/attachments/... จะตอบ 400 ทันที
-- ซึ่งคือสิ่งที่ต้องการ — ลิงก์เก่าที่เคยหลุดออกไปนอกองค์กร "ตายทั้งหมด"


-- ═══════════════════════════════════════════════════════════════════════
-- STEP R — ROLLBACK (ถ้าเจอปัญหาหลัง flip · รูปกลับมาทันที)
-- ═══════════════════════════════════════════════════════════════════════
-- update storage.buckets set public = true where id = 'attachments';
--
-- ไม่ต้องแก้ข้อมูลใน DB เลย เพราะ URL ที่เก็บไว้ยังเป็นรูปแบบ public ตลอด
-- (โค้ดใหม่ทำงานได้ทั้ง 2 สถานะ — signed URL ใช้ได้กับ bucket public ด้วย)
