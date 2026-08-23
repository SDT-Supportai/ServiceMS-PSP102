# HANDOFF — ServiceMS (PSP102 Service Maintenance & Support)

เอกสารส่งต่องาน สรุปสถาปัตยกรรม ฟีเจอร์ วิธี deploy และสิ่งที่ยังค้าง
อัปเดตล่าสุด: 2026-07-11 (เพิ่ม Customer Engagement — LINE Bot ลงทะเบียน Warranty / แจ้งซ่อม)

---

## 1. ระบบคืออะไร
Web app จัดการงานบริการ/ซ่อมบำรุง (Handover, LBS, EV Charger, Repair, Service Report, จดหมาย, ทีม, แผนที่ check-in)
เดิมเป็น Google Apps Script + Sheets → ย้ายมาเป็น **static frontend + Supabase** โดยคง flow เดิม

**Stack**
- **Frontend:** `index.html` ไฟล์เดียว (HTML/CSS/JS ล้วน ไม่มี build step) + Leaflet/Google Fonts จาก CDN
- **Backend:** `index.ts` = Supabase Edge Function ตัวเดียว (Deno/TS) endpoint `POST /functions/v1/api`
- **DB:** PostgreSQL บน Supabase (`schema.sql`)

---

## 2. ลิงก์ & ที่อยู่ไฟล์
- **Live (Netlify):** https://famous-crisp-057c54.netlify.app  *(auto-deploy จาก GitHub push — เปลี่ยนชื่อได้ที่ Site configuration → Change site name)*
- **Repo:** https://github.com/SDT-Supportai/ServiceMS-PSP102  (branch `main`)
- **Supabase:** โปรเจกต์ของทีม (Edge Function ชื่อ `api`)

**ไฟล์ในโปรเจกต์**
| ไฟล์ | หน้าที่ | Deploy ไปที่ |
|---|---|---|
| `index.html` | Frontend ทั้งหมด (~320KB) | Netlify (push GitHub → auto) |
| **`config.js`** | **ค่าเชื่อมต่อ Supabase (URL / anon key / เวอร์ชัน) — แยกออกจาก index.html ห้ามแก้ตอนอัปเดตฟีเจอร์** | deploy คู่กับ index.html |
| **`_headers`** | Cache-Control ของ index.html/config.js (ใช้ได้ทั้ง Netlify และ Cloudflare Pages) | deploy คู่กัน |
| `index.ts` | Backend Edge Function | `supabase functions deploy api` |
| `schema.sql` | โครงสร้าง DB + RLS + seed | รันใน Supabase SQL Editor |
| `manual-project-role.html` | คู่มือ role project | (static) |
| `.github/workflows/deploy-pages.yml`, `.nojekyll` | ของ GitHub Pages เดิม (เลิกใช้แล้ว — ย้ายมา Netlify) | — |

---

## 3. สถาปัตยกรรมความปลอดภัย
- หน้าเว็บถือแค่ **anon key** (public ได้) → ยิงไป Edge Function → Edge Function ใช้ **service-role key** (ฝั่ง server) คุย DB
- **RLS = default-deny ทุกตาราง** → anon key แตะ DB ตรงๆ ไม่ได้
- **Session token เอง** (8 ชม.) เก็บใน `sessions` table (ไม่ใช้ Supabase Auth) → deploy function ด้วย `--no-verify-jwt`
- **Permission Matrix** `ROLE_REQUIRED` ใน `index.ts` = แหล่งความจริงเดียว บังคับ role ฝั่ง server (frontend มี `PERMS`/`can()` mirror ไว้ซ่อนปุ่ม)

**Roles:** `manager` (เต็ม + Settings + CRUD/Delete), `section` (review/approve, service ops, จดหมาย, ทีม, check-in), `project` (สร้าง Handover/LBS/EV + resubmit งานตัวเองที่ถูก return)

**User Management (Admin → เมนู "User Management", manager only) — ใหม่**
- ตาราง `users` **+`active`** (ปิดบัญชี = ล็อกอินไม่ได้ + `requireSession`/`serverLogin` เตะ session ทันที) **+`last_login_at`**
- RPC `create_user()` — bcrypt hash ใน DB (ห้าม hash ใน JS); คืน false ถ้า username ซ้ำ
- Server (manager-only): `serverCreateUser` / `serverUpdateUser` (name+role) / `serverSetUserActive` / `serverDeleteUser` / `serverGetUsers` (คืน active/last_login) — รหัสผ่านบังคับ ≥6
- **Lockout guard** (`otherActiveManagers()`): ห้ามลบ/ปิด/ลดสิทธิ์ **manager คนสุดท้ายที่ active**, ห้ามลบ/ปิดบัญชีตัวเอง; เปลี่ยน role → เตะ session เดิมให้ล็อกอินใหม่
- **บัญชี manager หลัก:** `siradanai.s@precise.co.th` / `siradanai.s` (seed ใน schema) — schema จะปิดบัญชี generic `manager` เดิมอัตโนมัติ *เฉพาะเมื่อ* siradanai.s มีอยู่และ active แล้ว (กัน lockout); `section`/`project` generic ยัง active จนกว่าจะสร้างบัญชีรายบุคคลแทน
- Frontend: เมนู + ตาราง (username/ชื่อ/role/สถานะ/ใช้งานล่าสุด) + modal เพิ่ม/แก้/รีเซ็ตรหัส + toggle เปิด-ปิด/ลบ (ซ่อนปุ่มอันตรายจาก self & last-manager)

**LINE Approval (อนุมัติจาก LINE ส่วนตัว) — ใหม่**
- **Flow:** งานเข้า Job Under Review (Handover/LBS/EV สร้าง/resubmit + Customer Register screen) → notify กลุ่มเปลี่ยนเป็น bell/email (`toLine=false`) + **push การ์ด Flex เข้า LINE ส่วนตัว manager** (`pushApprovalCard` — เฉพาะ manager ที่ผูก `line_user_id`) → การ์ดมี 🔗 ลิงก์ตรวจสอบ (deep-link) + ปุ่ม ✅ อนุมัติ / ↩️ ตีกลับ (postback)
- **ความปลอดภัย (ไฮบริด):** กดอนุมัติ → บอทขอ **PIN 4-6 หลัก** (`verify_approve_pin`, ผิด 3 ครั้งยกเลิก) → `doApprove`; กดตีกลับ → บอทขอเหตุผล → `doReturn` (ตีกลับไม่ต้อง PIN — mild action)
- **`doApprove`/`doReturn`** = helper กลางใช้ร่วมเว็บ+LINE, บังคับสถานะต้อง SUBMITTED/RESUBMITTED (กันอนุมัติซ้ำ), งานลูกค้า (source=CUSTOMER) อนุมัติได้เฉพาะ manager
- **Account linking:** `users` +`line_user_id`/`approve_pin_hash`/`link_code`/`link_code_expires`; เมนู **LINE Approval** (section+manager) → สร้างรหัส 6 หลัก (อายุ 10 นาที) → พิมพ์ส่ง bot ใน LINE ส่วนตัว (`tryStaffLink`) → ผูกบัญชี + ตั้ง PIN (RPC `set_approve_pin`, hash ใน DB)
- **Deep-link:** `settings.app_url` (manager ตั้งใน Settings → Notifications) → การ์ดลิงก์ `?open=Handovers:<id>` → เว็บเปิด detail หลัง login (`openDeepLink`)
- **โควตา:** การ์ดส่ง manager เท่านั้น (1 push แทน group เดิม 1 push = เท่าเดิม); postback/reply ของ bot = ฟรี
- **ยังไม่รวม:** ปุ่ม Complete ใน LINE, การอนุมัติ Customer Repair (ต้องเลือก Ref Handover ทำในเว็บ), การ์ดถึง section (ปัจจุบัน manager เท่านั้นตามที่เลือก — section ผูกไว้รองรับอนาคต)

**LINE Messaging API quota alert — ใหม่**
- `settings.line_quota_alert` (int) เก็บเกณฑ์ที่แจ้งไปแล้วต่อรอบบิล; `notify()` เรียก `maybeAlertQuota()` หลังส่ง LINE → ข้ามเกณฑ์ **80% / 95%** แจ้งอัตโนมัติ (กระดิ่ง + LINE) ครั้งเดียวต่อเกณฑ์ (reset เมื่อ % < 50 = รอบใหม่); quota API ไม่กินโควตาข้อความ
- `serverCheckLineQuota` + Settings → Notifications ปุ่ม "📊 ตรวจโควตา" แสดง progress bar (ใช้ไป/เหลือ/%)
- **`notify(title, desc, toLine=true)`** — `toLine=false` = event รองลงกระดิ่ง+email เท่านั้น ไม่ยิง LINE (ประหยัดโควตา) · **สำคัญ:** โควตา LINE นับ *จำนวน push* ไม่ใช่ความยาว → กระชับข้อความไม่ช่วยโควตา, การตัด event ต่างหากที่ช่วย; Bot reply (ตอนคุยกับลูกค้า) = ฟรี ไม่นับโควตา
- **Event ที่ตัดจาก LINE (bell/email only):** ออกจดหมาย · S.R.ใหม่ · S.R.เสร็จ · ตีกลับแก้ไข · ยกเลิกมอบหมาย LBS · S.O.เสร็จ · Customer Register ส่งเข้าพิจารณา → ลด push ~7 ข้อความ/รอบงาน
- **Event ที่คง LINE:** งานส่งใหม่ (Handover/LBS/EV) · S.O.ใหม่ · อนุมัติ · COMPLETED · มอบหมายทีม · Resubmit · ลูกค้าส่งคำขอ/อนุมัติซ่อม/ปฏิเสธ — ข้อความทั้งหมดถูกย่อให้กระชับ (2-3 บรรทัด)

---

## 4. โครงสร้างข้อมูล (ตารางหลัก)
- `users`, `sessions`
- `handovers` — **+`source`** (`DIRECT`/`LBS`/`EV`)
- `lbs_works` — **+`work_category`** (`LBS`/`EV`), **+`charger_brand`** (ใช้ตารางเดียวกันทั้ง LBS และ EV Charger)
- `service_orders` (so_no), `service_reports` (sr_no) — **UNIQUE** + เลขรัน **ชุดเดียวกัน** (SO-/SR- ไม่ซ้ำข้ามกัน)
- `letters` — **+`warranty_type/start/end/detail`**; ทุกประเภทใช้ prefix เดียว **`SL`** + เลขรันร่วม
- `team`, `activity_logs`, `notifications`, `settings` — **+`line_channel_secret`** (ยืนยันลายเซ็น LINE webhook)
- `checkins` — `kind`(LBS/SR/SO) `ref_no` `lat` `lng` **`project` `status`** `who` — สำหรับ Map Tracking
- **`customer_requests`** — คำขอจากลูกค้าผ่าน LINE Bot: `kind`(REGISTER/REPAIR), ข้อมูลลูกค้า, `warranty_start/end`, `detail`, `attachment_files`, `status`(PENDING/APPROVED/REJECTED), `result_ref`(เลข Handover/S.O. ที่สร้างตอนอนุมัติ)
- **`line_chat_states`** — state การสนทนาราย user ของ LINE Bot (flow/step/data)

---

## 5. ฟีเจอร์ที่ทำ (ไล่ตามโมดูล)
**สิทธิ์/รีวิว**
- Permission Matrix บังคับ role ฝั่ง server + แก้ช่องโหว่ `serverUpdatePassword` (เปลี่ยนได้เฉพาะรหัสตัวเองถ้าไม่ใช่ manager)
- **Job Under Review** (เดิมชื่อกล่องรออนุมัติ) — แยกกล่อง Handover/LBS, aging pill, จำนวนไฟล์แนบ, ยืนยันก่อนอนุมัติ, template เหตุผลตีกลับ
- **Resubmit flow** — project แก้ + ส่งใหม่งานที่ถูก Return (`serverResubmit`, สถานะ→RESUBMITTED)
- **Status Stepper** ในหน้า detail (Handover/LBS/SO/SR) + วันที่จาก activity log

**Dashboard**
- Service Team อยู่เหนือ Budget by Job
- Upcoming Appointments แสดง **IN_PROGRESS / OVERDUE** ตาม Planned Start–End

**Project Handover List (แท็บ)** = Project Handover / Repair Requests / Service Reports
- **Project Handover แบ่ง 3 กลุ่ม:** สร้างเอง (`source=DIRECT`) · อ้างอิง LBS · อ้างอิง EV — งาน LBS/EV ที่ **ออก Warranty แล้ว** จะถูก `serverPromoteHandover` สร้างเป็น Handover record จริง (status=COMPLETED)
- **Repair Requests:** ปุ่ม Done (IN_PROGRESS→DONE) + popup Check-in
- **New S.R.:** อ้างอิงเฉพาะ S.O. ที่ DONE, สถานะ S.R. บังคับ DONE, ไม่ popup check-in (ใช้หมุดของ S.O.)

**รายงานปัญหาก่อนปิดงาน (Done popup) — ใหม่**
- **ครอบคลุม 3 เมนู:** Project Handover · LBS Project · EV Charger Project — กด Done แล้วเปิด **popup เดียว** (`openCompleteWork`) ไม่เด้งซ้อน
- **ฟอร์ม:** ติ๊ก `✅ ไม่มีปัญหา` / `⚠️ มีปัญหา` (บังคับเลือก) → ถ้ามีปัญหาต้องกรอกรายละเอียด **≥5 ตัวอักษร** (บังคับทั้ง frontend + server) + แนบไฟล์/รูปได้ (ไม่บังคับ)
- **LBS/EV รวม Check-in ไว้ใน popup เดียวกัน** — ถ้าไซต์มีพิกัดเดิมแล้วโชว์กล่องเขียว "ใช้พิกัดเดิม" / ถ้ายังไม่มีต้องระบุพิกัดก่อนปุ่มยืนยันจะกดได้; Handover ไม่มีส่วน Check-in
- **DB:** `handovers` / `lbs_works` **+`issue_flag`** (`''`|`NONE`|`HAS`) **+`issue_detail`** **+`issue_files`** (`"name::url||…"`, อัปเข้า Storage `Issues/<Sheet>/<id>/`)
- **Server:** `serverCompleteHandover(id,user,issue)` / `serverCompleteLBS(id,user,issue)` — helper `buildIssuePatch()` validate + อัปไฟล์ (ไฟล์เดียวพังไม่บล็อกการปิดงาน) · Activity log ต่อท้าย `· พบปัญหา`
- **ไม่ส่งรายละเอียดปัญหาเข้า LINE** (ตั้งใจ) — LINE แจ้งแค่ "ปิดงานแล้ว"; ปัญหาดูได้ใน **เว็บ + PDF** เท่านั้น
- **แสดงผล:** หน้า detail มีบล็อก "⚠️ รายงานผลการดำเนินงาน" (ปัญหา + ไฟล์แนบ copy ลิงก์ได้) · ตาราง Handover/LBS/EV โชว์ไอคอน ⚠️ ข้างสถานะเมื่อ `issue_flag='HAS'`
- **PDF:** `issuePdfBlock()` แทรกในเอกสาร Handover และ LBS/EV — แสดงปัญหา + แยก **ภาพประกอบ** (photo grid) กับ **เอกสารแนบ** (รายการไฟล์) อัตโนมัติตามนามสกุล; ถ้าไม่มีปัญหาพิมพ์ว่า "ไม่พบปัญหาระหว่างดำเนินงาน"
- **🐛 แก้บั๊กเดิม:** `buildPdf` **ไม่เคยมี template `LBS`** → ปุ่ม 📄 ในหน้า LBS/EV เดิม error "Record not found" · เพิ่ม template LBS/EV แล้ว (ข้อมูลงาน + ลูกค้า + รายละเอียด + รายงานปัญหา + ช่องลายเซ็น, EV ใช้สีเขียว/แสดง Charger Brand)

**De-assignment guard (LBS/EV) — ใหม่**
- แก้ Status `ASSIGNED → SUBMITTED/RESUBMITTED/APPROVED/RETURNED` ผ่าน Edit = **ยกเลิกการมอบหมาย** → `serverUpdateRecord` ล้าง `assigned_team`, `planned_start`, `planned_end` อัตโนมัติ (บังคับฝั่ง server + notify + log) เพื่อให้ LBS list (คอลัมน์ Team/Schedule) และ Team & Scheduling เคลียร์แผนของบุคคลนั้นสอดคล้องกัน — กัน orphan team ค้างบนงานที่ยังไม่ได้มอบหมาย; frontend มี confirm เตือนพร้อมชื่อทีมก่อนบันทึก (`ASSIGNED→COMPLETED` ไม่ล้าง — งานเสร็จเก็บทีมผู้ทำไว้)

**LBS & EV**
- LBS list (ชื่อเมนู "LBS Project") + **EV Charger Project** (เมนูแยก) — กรองด้วย `work_category`
- แท็บ LBS/EV: Work / Completed Work / Warranty Period
- **Warranty Official Letter** (template header/footer เดียวกับ Service Letter) ออกจากงาน Completed
- **Create EV Charger** = ฟอร์ม LBS (ตัด Required Documents, + Charger Brand, placeholder `EV-2026-###`)

**Team & Scheduling**
- ตารางงานรายบุคคล (Service & Scheduling) แทนปฏิทิน (ปฏิทินยังอยู่บน Dashboard)
- ปุ่ม Assign Repair / **Assign LBS / Assign EV** (แยกประเภท)
- **พิมพ์ตาราง PDF รายบุคคล/หลายคน** — ติ๊ก checkbox หน้าการ์ดแต่ละคน (หรือ "เลือกทั้งหมด") → ปุ่ม "🖨️ พิมพ์ตารางที่เลือก" สร้าง HTML A4 client-side (`buildTeamSchedule` ใช้ร่วมกับการแสดงผล) เปิดผ่าน `openPrintWindow`/`writePrintWindow` เดิม — งานแยกสี REPAIR/LBS/EV
- **Dashboard Calendar:** งาน **EV Charger = สีเขียว** (`.cal-ev.ev`), LBS = ส้ม, Repair = น้ำเงิน — ทั้งช่องปฏิทิน, popup รายวัน และ legend

**Map Tracking (เมนูแยกใน Overview)**
- แผนที่ไทย (Leaflet/OSM) + หมุด check-in, กรองพิกัดนอกช่วง −180..180 ออก (กัน map พัง), default view = ไทย
- **Check-in:** ตอนกด Done ที่ LBS/EV/Repair → popup ขอ **GPS หรือกรอกพิกัดเอง**
- **ล็อกตำแหน่งตามไซต์:** ถ้าไซต์ (Handover job) มี check-in แล้ว ไม่ให้ check-in ซ้ำ
- **Recent Check-ins:** Ref | พิกัด | Project | Status + **manager แก้ไข/ลบ (CRUD)**

**เอกสาร/เลขที่**
- Service Letter (เดิม "ออกจดหมาย") — ทุกประเภท prefix `SL` + เลขรันเดียว
- SO+SR เลขรันชุดเดียวกัน (ไม่ซ้ำข้ามกัน) + UNIQUE constraint + retry กันชน

**Customer Engagement (LINE Bot) — ใหม่ 2026-07-11**
- **Webhook:** `POST /functions/v1/api/line-webhook` (ฟังก์ชันเดียวกับ api, แยก path) — ยืนยันลายเซ็นด้วย `x-line-signature` + Channel Secret; ถ้ายังไม่ตั้ง token/secret จะตอบ 200 เฉยๆ (กด Verify ใน LINE Developers ผ่าน); Bot คุยเฉพาะแชท 1:1 (เงียบในกลุ่ม)
- **Bot "ลงทะเบียน" (8 ขั้น):** **ประเภทงาน (1=Project / 2=LBS / 3=EV → `register_type` กำหนดกล่องปลายทาง)** → โครงการ → เลขสัญญา (พิมพ์ "ไม่มี" ได้) → ลูกค้า/บริษัท → ผู้ติดต่อ+เบอร์ (แยกเบอร์ด้วย regex) → สถานที่ (พิมพ์ หรือแชร์ LINE Location = เก็บ lat/lng) → ช่วงประกัน (YYYY-MM-DD×2) → แนบ Warranty Doc ≥1 ไฟล์ *(เลขเมนูลัด 1/2 ใช้ได้เฉพาะตอนยังไม่อยู่ใน flow — กันชนกับคำตอบตัวเลขระหว่างขั้น)*
- **Bot "แจ้งซ่อม" (6 ขั้น):** อ้างอิงงาน (จับคู่ job_no/ชื่อโครงการอัตโนมัติ) → ผู้แจ้ง → โทร → อาการ+จุดที่เสีย → วัน-เวลาสะดวกให้เข้าตรวจ (ข้ามได้) → แนบรูป **บังคับ ≥1** — พิมพ์ "เสร็จ" ยืนยัน / "ยกเลิก" เริ่มใหม่; ไฟล์ดึงผ่าน api-data.line.me → Storage `attachments/CustomerRequests/…`
- **Flow REGISTER (2 ชั้น สอดคล้อง flow เดิม, route 3 กล่องตาม `register_type`):** section/manager เปิดกล่อง Customer Register → ตรวจ + กรอกรายละเอียด → สร้างรายการ **status=SUBMITTED, source=CUSTOMER** เข้า **Job Under Review กล่องที่ตรงประเภท** → **manager เท่านั้น**อนุมัติขั้นสุดท้าย (server บังคับทั้ง handovers และ lbs_works + frontend ซ่อนปุ่มจาก section) → **push Job No. แจ้งลูกค้าทาง LINE** + ปักหมุด Map (kind=CUSTOMER) ถ้าลูกค้าแชร์พิกัด
  - **PROJECT** → `handovers` (เลขอัตโนมัติ `CST-YYYY-###`; modal กรอก Job No, Handover Date, Warranty Type FULL/PARTIAL, Budget, PM) → กล่อง Project Handover กลุ่ม "ลูกค้าลงทะเบียนผ่าน LINE"
  - **LBS / EV** → `lbs_works` (work_category=LBS/EV, **+`source`**, เลขอัตโนมัติ `LBS-`/`EV-YYYY-###`; modal กรอก Job No + PM; ตารางนี้ไม่มีคอลัมน์ warranty จึงเก็บช่วงประกัน+เลขสัญญาใน work_description) → เข้า LBS Project / EV Charger Project ตาม flow เดิม **และตอนอนุมัติขั้นสุดท้ายระบบสร้าง handover เงา (COMPLETED, source=LBS/EV) อัตโนมัติ** เพื่อให้ Job No. ใช้อ้างอิงแจ้งซ่อมได้ทันที (ไม่ต้องรอ Assign→Complete→Warranty Letter→Promote)
- **สถานะคำขอ REGISTER (`customer_requests.status`):** PENDING → **FORWARDED** (ผ่านชั้น screen, ส่งเข้า Job Under Review แล้ว) → APPROVED (manager อนุมัติขั้นสุดท้าย — sync ใน `serverApprove`) หรือ REJECTED; **ตีกลับ (Return) งานลูกค้าใน Job Under Review = ปฏิเสธคำขอ** — `serverReturn` จะ sync คำขอเป็น REJECTED + push เหตุผลให้ลูกค้าทาง LINE ให้พิมพ์ "ลงทะเบียน" ส่งใหม่ (ลูกค้าไม่มีเส้นทาง resubmit แบบ role project; รายการ RETURNED ที่ค้างให้ manager ลบ/แก้เอง)
- **Flow REPAIR (ชั้นเดียว):** section ดู/ปฏิเสธได้ แต่**อนุมัติได้เฉพาะ manager** → เลือก Ref Handover (ต้อง APPROVED/COMPLETED, มี**คำเตือนแดงถ้าประกันหมดอายุ**) → ออก S.O. (เลขรันร่วมชุด SO/SR เดิม) + รูปลูกค้า→before_photos + bump repair_count → กล่อง Repair Requests + แจ้งผลลูกค้าทาง LINE
- **ความคืบหน้างานซ่อมแจ้งลูกค้าอัตโนมัติ** (`linePushRepairProgress` — จับคู่ `customer_requests.result_ref = so_no` เฉพาะงานที่แจ้งผ่าน LINE; S.O. ที่ทีมสร้างเองไม่ push): **Assign ทีม** → แจ้งชื่อทีมช่าง + กำหนดเข้าดำเนินการ · **S.O. Done** → แจ้งงานเสร็จ + ชวนแจ้งซ่อมเพิ่มได้
- **ปฏิเสธ (section/manager):** ระบุเหตุผล → แจ้งลูกค้าทาง LINE ให้ส่งใหม่ได้
- **เมนู:** manager = Project Module · section = Review & Approve (badge นับ PENDING แยก REGISTER/REPAIR)
- **Settings → Notifications:** เพิ่มช่อง LINE Channel Secret + แสดง Webhook URL พร้อมปุ่ม Copy + **ปุ่ม "📨 ส่งข้อความทดสอบ"** (`serverTestLine`) ที่ยิงจริงไป Target แล้วโชว์ผล/สาเหตุที่ล้มเหลว; ⚠️ เมื่อเปิด Bot ลูกค้า **ต้องตั้ง Target ID** (ห้ามเว้นว่าง — Broadcast จะส่งแจ้งเตือนภายในหาลูกค้าทุกคน)
- **`sendLine` อ่าน response + log ทุกความล้มเหลว** ลง Activity Logs (user="LINE") — เดิมยิงแล้วไม่อ่านผล → แจ้งเตือนเข้ากลุ่มล้มเหลวแบบเงียบ (Bot ไม่อยู่ในกลุ่ม / token ผิด / เกินโควตา) โดยไม่มีร่องรอย

**ความทนทานของระบบ (Sprint 1 — hardening)**
- **`config.js` แยกไฟล์** — กันเคส push ทับจน anon key หาย + มีหน้าจอแจ้งเตือนถ้าคีย์ไม่พร้อม
- **เซสชันหมดอายุไม่ทำข้อมูลหาย** — `gsr()` ดัก `SESSION_INVALID` → `handleSessionExpired()` ซ้อน overlay ให้ล็อกอินใหม่ **โดยไม่ล้าง DOM** ผู้ใช้กดบันทึกซ้ำได้ทันที (เดิม: alert ดิบ + ข้อมูลหายทั้งฟอร์ม); timer หมดอายุก็ใช้ทางเดียวกัน
- **กันกดซ้ำรวมศูนย์** — `gsr()` dedupe คำสั่งที่เปลี่ยนข้อมูล (`_inflight`) ระหว่าง request ยังค้าง → ดับเบิลคลิก "อนุมัติ/สร้าง" ยิง network ครั้งเดียว; คำสั่งอ่าน (`serverGet*`) ไม่ถูก dedupe
- **Error เป็นภาษาผู้ใช้** — `friendlyError()`/`uiErr()` แปลง Postgres/HTTP error เป็นข้อความไทย (ข้อความไทยที่ server เขียนเองผ่านตรง) + log ของจริงลง console; แทนที่ `alert('Error: '+e)` ครบทุกจุด → ไม่หลุดชื่อ constraint/ตารางให้ผู้ใช้เห็นอีก
- **Cache-busting** — `_headers` (Netlify + Cloudflare Pages) + meta no-cache + เลขเวอร์ชันมุม Sidebar แก้ปัญหาผู้ใช้เห็นเวอร์ชันเก่าหลัง deploy

**อื่นๆ**
- Save/Print PDF รองรับมือถือ (เปิดแท็บจริง + ปุ่มพิมพ์ แทน hidden iframe)
- Sub-tab ทุกที่พื้นหลังกรมท่า/แท็บเลือกส้มอ่อน (หุ้มเฉพาะแท็บ)
- **ลิงก์ไฟล์แนบทุกจุด** (attachListHtml) แสดง URL จริง (ตัดด้วย …) + ปุ่ม 📋 Copy (clipboard API + fallback execCommand)

---

## 6. วิธี Deploy (สำคัญ)
ต้องทำครบ 3 ชั้นเมื่อมีการแก้:

1. **DB (`schema.sql`)** → Supabase → SQL Editor → วางทั้งไฟล์ → Run *(idempotent รันซ้ำได้)*
2. **Backend (`index.ts`)** → ติดตั้ง Supabase CLI + Docker แล้ว:
   ```
   supabase functions deploy api --no-verify-jwt
   ```
3. **Frontend (`index.html`)** → push ขึ้น GitHub `main` → **Netlify deploy อัตโนมัติ** (~5 วิ)

> แก้เฉพาะ frontend → push GitHub พอ
> แก้ backend/schema → ต้องทำชั้น 1–2 ด้วย ไม่งั้นฟีเจอร์ใหม่ error

---

## 7. Config ที่ต้องมี
- **`config.js`** (ไฟล์แยก): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APP_VERSION`
  - ⚠️ ไฟล์ที่ deploy **ต้องมี anon key จริง** — ถ้ายังเป็น `PASTE_YOUR_ANON_KEY_HERE` แอปจะขึ้นหน้าจอ "ยังไม่ได้ตั้งค่าการเชื่อมต่อระบบ" แทนที่จะพังเงียบ
  - เหตุผลที่แยกไฟล์: `index.html` ถูกแก้บ่อยมาก เดิมเก็บ key ไว้ในนั้นจึงเสี่ยง push ทับจนคีย์หาย = ทั้งระบบล็อกอินไม่ได้
  - อัปเดต `APP_VERSION` ทุกครั้งที่ deploy → เลขเวอร์ชันโชว์มุมล่าง Sidebar ใช้ยืนยันกับผู้ใช้ว่าเปิดตัวล่าสุดจริง
- Supabase secrets (ถ้าใช้แจ้งเตือน): `RESEND_API_KEY`, `EMAIL_FROM`; LINE token กรอกใน Settings → Notifications
- บัญชี seed เริ่มต้น (จาก `schema.sql`): `manager/manager102`, `section/section102`, `project/project102` — **เปลี่ยนรหัสหลัง login**

---

## 8. ⚠️ สิ่งที่ยังค้าง / ข้อควรรู้
- [ ] **Deploy backend ล่าสุด** — ฟีเจอร์รอบหลัง (shared numbering `SL`/SO-SR, `serverPromoteHandover`, checkins `project/status`, `work_category`, `charger_brand`, `handovers.source`, **LINE Bot + customer_requests**) ต้อง `deploy api` + รัน `schema.sql` ให้ครบ ไม่งั้นของใหม่จะ error
- [ ] **เปิดใช้ LINE Bot ลูกค้า** — (1) รัน `schema.sql` + deploy `api` (2) Settings → Notifications: ใส่ Channel Access Token + **Channel Secret** + **Target ID ของทีมงาน (ห้ามเว้นว่าง)** (3) LINE Developers → Messaging API: วาง Webhook URL (ปุ่ม Copy ใน Settings) + เปิด Use webhook + ปิด Auto-reply
- [ ] **ล็อก CORS** — `index.ts` ยังตั้ง `Access-Control-Allow-Origin: *` ควรล็อกเป็นโดเมน Netlify
- [ ] **ข้อมูล check-in เสีย 2 แถว** (lng จุดทศนิยมหาย เช่น `1032058022`) — แก้ผ่าน Map → Recent Check-ins → ✏️ (ตอนนี้ map ข้ามให้แล้ว)
- [ ] **Promote handover ไม่ย้อนหลัง** — ทำงานเฉพาะ Warranty ที่ออก *หลัง* deploy; งานเก่าต้อง backfill เอง
- [ ] **prefix จดหมาย = `SL`** (เปลี่ยนได้ที่ constant `LETTER_PREFIX` ใน `index.ts`)
- [ ] **เลขรันร่วม** ใช้ max-across-tables + retry — ปลอดภัยสำหรับใช้งานทั่วไป แต่ไม่ 100% กันชนถ้าสร้างพร้อมกันจริงๆ ข้ามตาราง
- [ ] Job Under Review / Dashboard stat ยังนับ EV รวมกับ LBS (ถ้าต้องแยก บอกได้)

---

## 9. Dev / Local
- เครื่อง dev **ไม่มี** node/deno/supabase CLI; โฟลเดอร์ scratch นี้ **ไม่ใช่ git repo** (repo จริงอยู่ที่อื่น/แก้ผ่าน GitHub web)
- Preview frontend: เสิร์ฟ static ด้วย python `http.server` (แต่ต้องใส่ SUPABASE keys + login ถึงจะดึงข้อมูลได้; ส่วน UI ทดสอบ render ได้)
- GitHub Pages เดิม fail บ่อย (deploy-pages backend flaky) → **ย้ายมา Netlify แล้ว** (เสถียร)
