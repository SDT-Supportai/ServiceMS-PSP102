-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  ServiceMS — PSP102 Service Maintenance & Support                      ║
-- ║  Supabase / PostgreSQL schema  (run once in Supabase → SQL Editor)     ║
-- ║  By migration of the original Google Apps Script + Sheets backend.     ║
-- ╚══════════════════════════════════════════════════════════════════════╝

-- pgcrypto powers bcrypt password hashing (crypt / gen_salt) + gen_random_uuid
-- pgcrypto powers bcrypt password hashing. On Supabase it lives in the
-- "extensions" schema, so calls below are schema-qualified (extensions.crypt).
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ─────────────────────────────────────────────────────────────────────────
-- 1) USERS  (custom auth — username + bcrypt hash, 3 roles)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  username      text unique not null,
  password_hash text not null,
  role          text not null check (role in ('manager','section','project')),
  name          text,
  active        boolean default true,          -- ปิดบัญชี = ล็อกอินไม่ได้ + session ถูกเตะ
  last_login_at timestamptz,                   -- เวลาล็อกอินล่าสุด (แสดงในหน้า User Management)
  created_at    timestamptz default now()
);
-- migration for tables created before these columns existed (safe to re-run)
alter table users add column if not exists active        boolean default true;
alter table users add column if not exists last_login_at timestamptz;
-- LINE approval (section/manager): ผูก LINE ส่วนตัว + PIN ยืนยันการอนุมัติ
alter table users add column if not exists line_user_id       text;          -- LINE userId ที่ผูกไว้
alter table users add column if not exists approve_pin_hash   text;          -- bcrypt hash ของ PIN
alter table users add column if not exists link_code          text;          -- รหัสผูกบัญชี 6 หลัก (ชั่วคราว)
alter table users add column if not exists link_code_expires  timestamptz;
create index if not exists idx_users_lineid on users(line_user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 2) SESSIONS  (token-based, 8h expiry — mirrors the original)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists sessions (
  token       text primary key,
  username    text not null,
  role        text not null,
  expires_at  timestamptz not null,
  created_at  timestamptz default now()
);
create index if not exists idx_sessions_expires on sessions(expires_at);

-- ─────────────────────────────────────────────────────────────────────────
-- 3) HANDOVERS  (Project Handover)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists handovers (
  id               uuid primary key default gen_random_uuid(),
  job_no           text,
  project_name     text,
  location         text,
  customer_name    text,
  customer_contact text,
  phone            text,
  email            text,
  handover_date    text,
  warranty_type    text default 'FULL',          -- FULL | PARTIAL_EQUIPMENT
  warranty_start   text,
  warranty_end     text,
  warranty_budget  bigint default 0,
  project_manager  text,
  status           text default 'SUBMITTED',     -- SUBMITTED|RESUBMITTED|APPROVED|RETURNED|COMPLETED
  attachments      text default '',              -- external link
  attachment_files text default '',              -- "name::url||name::url"
  repair_count     int  default 0,
  comments         text default '',
  created_at       timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- 4) LBS_WORKS  (LBS & Support Work)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists lbs_works (
  id               uuid primary key default gen_random_uuid(),
  job_no           text,
  project_name     text,
  location         text,
  customer_name    text,
  customer_contact text,
  phone            text,
  email            text,
  work_type        text default 'SUPPLY',        -- SUPPLY | SUPPLY_AND_CONSTRUCTION | OTHER
  work_description text default '',
  status           text default 'SUBMITTED',     -- SUBMITTED|RESUBMITTED|APPROVED|ASSIGNED|RETURNED|COMPLETED
  planned_start    text,
  planned_end      text,
  project_manager  text,
  attachments      text default '',
  attachment_files text default '',
  delivery_order   text default 'FALSE',
  handover_project text default 'FALSE',
  assigned_team    jsonb default '[]'::jsonb,    -- array of psp_id
  comments         text default '',
  created_at       timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- 5) SERVICE_ORDERS  (Repair Requests)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists service_orders (
  id             uuid primary key default gen_random_uuid(),
  so_no          text,
  ref_job_no     text,                            -- FK (logical) to handovers.job_no
  request_date   text,
  planned_start  text,
  planned_finish text,
  status         text default 'PENDING',          -- PENDING | IN_PROGRESS | DONE
  description    text default '',
  assigned_team  jsonb default '[]'::jsonb,
  before_photos  text default '',
  created_at     timestamptz default now()
);
create index if not exists idx_so_ref on service_orders(ref_job_no);

-- ─────────────────────────────────────────────────────────────────────────
-- 6) SERVICE_REPORTS  (Service Reports)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists service_reports (
  id                uuid primary key default gen_random_uuid(),
  sr_no             text,
  ref_so            text,                          -- FK (logical) to service_orders.so_no
  damaged_type      text default 'EQUIPMENT',      -- EQUIPMENT|STRUCTURE|ELECTRICAL|OTHER
  damaged_items     text default '',
  supplier_serial   text default '',
  construction_name text default '',
  status            text default 'IN_PROGRESS',    -- IN_PROGRESS | DONE
  cost_labor        bigint default 0,
  cost_material     bigint default 0,
  cost_total        bigint default 0,
  before_photos     text default '',               -- '||'-joined storage URLs
  after_photos      text default '',               -- '||'-joined storage URLs
  repair_details    text default '',               -- รายละเอียดการซ่อม (DONE)
  attachment_files  text default '',               -- "name::url||..." (e.g. test-result PDFs)
  sig_technician    text default '',               -- signature image URL
  sig_customer      text default '',               -- signature image URL
  created_at        text                           -- frontend sends YYYY-MM-DD
);
create index if not exists idx_sr_ref on service_reports(ref_so);

-- ─────────────────────────────────────────────────────────────────────────
-- 7) TEAM  (Service technicians)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists team (
  psp_id     text primary key,
  name       text not null,
  position   text default '',
  phone      text default '',
  color      text default '#2d7ff9',
  photo      text default '',
  active     boolean default true,
  created_at timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- 8) ACTIVITY_LOGS
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists activity_logs (
  id         uuid primary key default gen_random_uuid(),
  "time"     text,           -- pre-formatted display string (Asia/Bangkok)
  "user"     text,
  action     text,
  created_at timestamptz default now()
);
create index if not exists idx_logs_created on activity_logs(created_at desc);

-- ─────────────────────────────────────────────────────────────────────────
-- 9) NOTIFICATIONS   (note: "desc" is quoted — it is a reserved word)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  title      text,
  "desc"     text,
  "time"     text,
  unread     boolean default true,
  created_at timestamptz default now()
);
create index if not exists idx_notif_created on notifications(created_at desc);

-- ─────────────────────────────────────────────────────────────────────────
-- 10) SETTINGS  (single row: id = 1)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists letters (
  id               uuid primary key default gen_random_uuid(),
  letter_no        text,
  letter_date      text,
  letter_type      text default 'EXTERNAL',     -- EXTERNAL / INTERNAL
  recipient        text,                          -- เรียน
  recipient_org    text default '',               -- หน่วยงาน/บริษัทผู้รับ
  subject          text,                          -- เรื่อง
  reference        text default '',               -- อ้างถึง
  enclosure        text default '',               -- สิ่งที่ส่งมาด้วย
  body             text,                          -- เนื้อความ
  ref_job          text default '',               -- อ้างอิงโครงการ (optional)
  cc               text default '',               -- สำเนาเรียน
  signer_name      text default '',               -- ผู้ลงนาม
  signer_position  text default '',               -- ตำแหน่ง
  category         text default 'GENERAL',        -- GENERAL / SM (Service & Maintenance letter)
  attention        text default '',               -- บรรทัด "เรียน" (S&M)
  site             text default '',               -- สถานที่/หน้า (S&M)
  body2            text default '',               -- เนื้อความย่อหน้า 2 (S&M)
  tech_list        text default '',               -- รายชื่อเจ้าหน้าที่ (S&M) บรรทัดละคน "ชื่อ|เบอร์"
  sig_image        text default '',               -- ลายเซ็น (data URL) ถ้าวาดใหม่
  status           text default 'ISSUED',         -- DRAFT / ISSUED
  created_by       text default '',
  created_at       text
);

create table if not exists settings (
  id                 int primary key default 1,
  line_channel_token text default '',
  line_target_id     text default '',
  email_recipients   text default '',
  updated_by         text default '',
  updated_at         timestamptz default now()
);
insert into settings (id) values (1) on conflict (id) do nothing;
-- LINE Bot webhook (Customer Engagement) — channel secret for signature verify
alter table settings add column if not exists line_channel_secret text default '';
-- Messaging API quota alert — highest threshold (%) already alerted this cycle (0/80/95)
alter table settings add column if not exists line_quota_alert int default 0;
-- โดเมนเว็บแอป (สำหรับลิงก์ตรวจสอบใน LINE approval card) เช่น https://xxx.pages.dev
alter table settings add column if not exists app_url text default '';

-- ─────────────────────────────────────────────────────────────────────────
-- 13) CUSTOMER_REQUESTS  (Customer Engagement via LINE Bot)
--     kind = 'REGISTER' → Warranty registration → approve → handovers
--     kind = 'REPAIR'   → Repair request        → approve → service_orders
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists customer_requests (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null check (kind in ('REGISTER','REPAIR')),
  register_type     text default 'PROJECT', -- REGISTER: 'PROJECT' | 'LBS' | 'EV' → กล่องปลายทาง
  line_user_id      text not null,
  line_display_name text default '',
  project_name      text default '',
  contract_no       text default '',        -- REGISTER: เลขสัญญา
  location          text default '',
  lat               double precision,       -- REGISTER: พิกัดจาก LINE location share
  lng               double precision,
  customer_name     text default '',
  customer_contact  text default '',        -- ชื่อผู้ติดต่อ
  phone             text default '',
  preferred_time    text default '',        -- REPAIR: วัน/เวลาสะดวกให้เข้าตรวจ
  ref_job_no        text default '',        -- REPAIR: referenced handover job_no (if matched)
  warranty_start    text default '',        -- REGISTER
  warranty_end      text default '',        -- REGISTER
  detail            text default '',        -- REPAIR: symptom / REGISTER: extra notes
  attachment_files  text default '',        -- "name::url||name::url" (Warranty doc / repair photos)
  status            text default 'PENDING', -- PENDING | APPROVED | REJECTED
  reject_reason     text default '',
  reviewed_by       text default '',
  reviewed_at       timestamptz,
  result_ref        text default '',        -- job_no / so_no created on approval
  created_at        timestamptz default now()
);
create index if not exists idx_custreq_status on customer_requests(status);
create index if not exists idx_custreq_line   on customer_requests(line_user_id);
-- migration for tables created before these fields existed (safe to re-run)
alter table customer_requests add column if not exists register_type    text default 'PROJECT';
alter table customer_requests add column if not exists contract_no      text default '';
alter table customer_requests add column if not exists customer_contact text default '';
alter table customer_requests add column if not exists lat              double precision;
alter table customer_requests add column if not exists lng              double precision;
alter table customer_requests add column if not exists preferred_time   text default '';
-- ที่มาของงาน LBS/EV (Customer Register ผ่าน LINE = 'CUSTOMER')
alter table lbs_works add column if not exists source text default 'DIRECT';

-- ─────────────────────────────────────────────────────────────────────────
-- 14) LINE_CHAT_STATES  (per-user conversation state for the LINE Bot)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists line_chat_states (
  line_user_id text primary key,
  display_name text default '',
  flow         text default '',             -- REGISTER | REPAIR
  step         int  default 0,
  data         jsonb default '{}'::jsonb,   -- collected answers + uploaded files
  updated_at   timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- 12) CHECKINS  (location check-ins captured on LBS / Service Report completion)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists checkins (
  id         uuid primary key default gen_random_uuid(),
  kind       text,                 -- 'LBS' | 'SR'
  ref_no     text,                 -- LBS job_no / S.R. no
  lat        double precision,
  lng        double precision,
  label      text default '',
  project    text default '',      -- denormalized project name (for Recent Check-ins)
  status     text default '',      -- work status at check-in (e.g. DONE / COMPLETED)
  who        text default '',
  created_at timestamptz default now()
);
create index if not exists idx_checkins_created on checkins(created_at desc);
alter table checkins add column if not exists project text default '';
alter table checkins add column if not exists status  text default '';

-- ─────────────────────────────────────────────────────────────────────────
-- MIGRATION — add new columns to existing tables (safe to re-run)
-- ─────────────────────────────────────────────────────────────────────────
alter table service_reports add column if not exists before_photos    text default '';
alter table service_reports add column if not exists after_photos     text default '';
alter table service_reports add column if not exists repair_details   text default '';
alter table service_reports add column if not exists attachment_files text default '';
alter table service_reports add column if not exists sig_technician   text default '';
alter table service_reports add column if not exists sig_customer     text default '';
alter table team            add column if not exists photo            text default '';
alter table letters         add column if not exists category   text default 'GENERAL';
alter table letters         add column if not exists attention  text default '';
alter table letters         add column if not exists site       text default '';
alter table letters         add column if not exists body2      text default '';
alter table letters         add column if not exists tech_list  text default '';
alter table letters         add column if not exists sig_image  text default '';
alter table handovers       add column if not exists source        text default 'DIRECT'; -- 'DIRECT' | 'LBS' | 'EV' (origin of the handover)
-- Closing issue report — บันทึกตอนกด Done (Handover / LBS / EV)
-- issue_flag: '' (ยังไม่ปิดงาน) | 'NONE' (ไม่มีปัญหา) | 'HAS' (มีปัญหา)
alter table handovers       add column if not exists issue_flag    text default '';
alter table handovers       add column if not exists issue_detail  text default '';
alter table handovers       add column if not exists issue_files   text default '';  -- "name::url||name::url"
alter table lbs_works       add column if not exists issue_flag    text default '';
alter table lbs_works       add column if not exists issue_detail  text default '';
alter table lbs_works       add column if not exists issue_files   text default '';
alter table lbs_works       add column if not exists work_category text default 'LBS';  -- 'LBS' | 'EV' (EV Charger)
alter table lbs_works       add column if not exists charger_brand text default '';     -- EV Charger brand
-- Warranty Official Letter fields (category = 'WARRANTY')
alter table letters         add column if not exists warranty_type   text default '';
alter table letters         add column if not exists warranty_start  text default '';
alter table letters         add column if not exists warranty_end    text default '';
alter table letters         add column if not exists warranty_detail text default '';

-- ─────────────────────────────────────────────────────────────────────────
-- UNIQUE running numbers — back the Edge Function's collision-safe numbering
-- (insert + retry on 23505). Guarded: skips with a notice if legacy duplicate
-- values already exist, so re-running schema.sql is always safe.
-- ─────────────────────────────────────────────────────────────────────────
do $$ begin
  begin alter table service_orders  add constraint uq_service_orders_so_no    unique (so_no);
  exception when duplicate_table then null; when duplicate_object then null;
            when others then raise notice 'skip uq so_no: %', sqlerrm; end;
  begin alter table service_reports add constraint uq_service_reports_sr_no   unique (sr_no);
  exception when duplicate_table then null; when duplicate_object then null;
            when others then raise notice 'skip uq sr_no: %', sqlerrm; end;
  begin alter table letters         add constraint uq_letters_letter_no       unique (letter_no);
  exception when duplicate_table then null; when duplicate_object then null;
            when others then raise notice 'skip uq letter_no: %', sqlerrm; end;
end $$;

-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  AUTH HELPERS  (SECURITY DEFINER — only the Edge Function/service role ║
-- ║  can call these; the public anon key cannot, thanks to RLS below)      ║
-- ╚══════════════════════════════════════════════════════════════════════╝
create or replace function verify_login(p_username text, p_password text)
returns table(username text, role text, name text)
language sql security definer set search_path = public, extensions as $$
  select u.username, u.role, u.name
  from users u
  where u.username = p_username
    and u.password_hash = extensions.crypt(p_password, u.password_hash);
$$;

create or replace function set_password(p_username text, p_password text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  update users
     set password_hash = extensions.crypt(p_password, extensions.gen_salt('bf'))
   where username = p_username;
  return found;
end;
$$;

-- approve PIN — hash/verify in the DB (never in JS), reuses pgcrypto bcrypt.
create or replace function set_approve_pin(p_username text, p_pin text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  update users set approve_pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf'))
   where username = p_username;
  return found;
end;
$$;
create or replace function verify_approve_pin(p_username text, p_pin text)
returns boolean
language sql security definer set search_path = public, extensions as $$
  select exists(
    select 1 from users u
     where u.username = p_username
       and u.approve_pin_hash is not null
       and u.approve_pin_hash = extensions.crypt(p_pin, u.approve_pin_hash)
  );
$$;

-- create_user — bcrypt hashing stays in the DB (never in the Edge Function/JS).
-- Returns false on duplicate username so the caller can surface a friendly error.
create or replace function create_user(p_username text, p_password text, p_role text, p_name text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into users (username, password_hash, role, name, active)
  values (p_username,
          extensions.crypt(p_password, extensions.gen_salt('bf')),
          p_role, coalesce(p_name, ''), true);
  return true;
exception when unique_violation then
  return false;
end;
$$;

-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  ROW LEVEL SECURITY — default-deny on every table.                    ║
-- ║  The anon/public key (shipped in index.html) gets ZERO direct access. ║
-- ║  All reads/writes go through the Edge Function using the service-role ║
-- ║  key (which bypasses RLS). This is the secure pattern for a static    ║
-- ║  GitHub Pages frontend.                                                ║
-- ╚══════════════════════════════════════════════════════════════════════╝
do $$
declare t text;
begin
  foreach t in array array[
    'users','sessions','handovers','lbs_works','service_orders',
    'service_reports','team','activity_logs','notifications','letters','settings','checkins',
    'customer_requests','line_chat_states'
  ] loop
    execute format('alter table %I enable row level security;', t);
    -- no policies created => deny all for anon & authenticated roles.
  end loop;
end $$;

-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  SEED DATA — default accounts & team.                                 ║
-- ║  ⚠️ CHANGE THESE PASSWORDS after first login (Settings → Password).   ║
-- ╚══════════════════════════════════════════════════════════════════════╝
insert into users (username, password_hash, role, name) values
  ('manager', extensions.crypt('manager102', extensions.gen_salt('bf')), 'manager', 'System Manager'),
  ('section', extensions.crypt('section102', extensions.gen_salt('bf')), 'section', 'Section Head'),
  ('project', extensions.crypt('project102', extensions.gen_salt('bf')), 'project', 'Project Officer')
on conflict (username) do nothing;

-- ── Primary manager account (per-person) ──────────────────────────────────
insert into users (username, password_hash, role, name, active) values
  ('siradanai.s@precise.co.th',
   extensions.crypt('siradanai.s', extensions.gen_salt('bf')),
   'manager', 'Siradanai S.', true)
on conflict (username) do nothing;

-- Make siradanai.s the ONLY active manager: deactivate the generic 'manager'
-- seed — but ONLY once the new manager exists & is active (guards against lockout).
-- (section/project generic accounts stay active until per-person accounts replace them.)
update users set active = false
 where username = 'manager'
   and exists (select 1 from users
                where username = 'siradanai.s@precise.co.th'
                  and role = 'manager' and coalesce(active, true));

-- Migrate default passwords to *102 ONLY if the account still uses the old *123 default
-- (accounts whose password was already customized via Settings are left untouched).
update users set password_hash = extensions.crypt('manager102', extensions.gen_salt('bf'))
  where username = 'manager' and password_hash = extensions.crypt('manager123', password_hash);
update users set password_hash = extensions.crypt('section102', extensions.gen_salt('bf'))
  where username = 'section' and password_hash = extensions.crypt('section123', password_hash);
update users set password_hash = extensions.crypt('project102', extensions.gen_salt('bf'))
  where username = 'project' and password_hash = extensions.crypt('project123', password_hash);

insert into team (psp_id, name, position, phone, color, active) values
  ('PSP-001', 'สมชาย ใจดี',     'Senior Technician', '081-111-1111', '#2d7ff9', true),
  ('PSP-002', 'สมหญิง รักงาน',   'Technician',        '082-222-2222', '#28a745', true),
  ('PSP-003', 'อนุชา ขยัน',      'Field Engineer',    '083-333-3333', '#f5920b', true)
on conflict (psp_id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────
-- 11) STORAGE BUCKET  (PRIVATE — อ่านผ่าน signed URL เท่านั้น · เขียนผ่าน service-role)
--
-- เดิม bucket นี้เป็น public:true + policy select ทั้ง bucket ซึ่งเปิดกว้างเกินไป 2 ชั้น:
--   (1) ใครมีลิงก์ (หรือเดา path ได้) อ่านลายเซ็นลูกค้า/เอกสารประกัน/รูปซ่อมได้ทันที
--   (2) policy select ทั้ง bucket ทำให้ anon key เรียก storage list() ไล่ path ได้ทั้งถัง
-- ตอนนี้: ไม่มี policy select (ปิด list) + bucket ใหม่เป็น private
-- โค้ดฝั่ง server มี signMany()/signHtmlUrls() แลก signed URL อายุ 8 ชม. ให้แล้ว
--
-- ⚠️ instance ที่ใช้งานอยู่แล้ว: `on conflict do nothing` ด้านล่างจะ "ไม่" แตะ bucket เดิม
--    (bucket เดิมยังเป็น public จนกว่าจะรัน migrate-private-bucket.sql)
--    → รัน schema.sql ทับ instance ที่ live ได้ปลอดภัย ไม่ทำรูปพังกลางวัน
--    การ flip เป็น private ต้องทำ "หลัง" deploy api + frontend ชุดใหม่ ดู migrate-private-bucket.sql
-- ─────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

-- ปิดช่องไล่ไฟล์ทั้งถังด้วย anon key (storage list) — ปลอดภัยกับ instance ที่ live อยู่
-- เพราะ URL รูปแบบ /object/public/... ของ bucket ที่ public อยู่ "ไม่" ผ่าน RLS
-- (ลบ policy = list ไม่ได้อีก แต่รูป/ไฟล์เดิมที่แสดงอยู่ยังเปิดได้ปกติ)
drop policy if exists "attachments public read" on storage.objects;

-- Done. Default logins:
--   manager / manager102   (full access + System Settings)
--   section / section102   (review & approve)
--   project / project102   (create handover & LBS)
