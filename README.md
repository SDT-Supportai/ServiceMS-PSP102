# ServiceMS — PSP102 · Deployment Guide
**Frontend:** GitHub Pages (HTML/JS) · **Backend/DB:** Supabase (PostgreSQL + Edge Functions + Storage)

ระบบเดิม (Google Apps Script + Sheets) ถูกย้ายมาที่ Supabase โดย **คง flow / logic เดิมไว้ครบทุกส่วน** — เปลี่ยนเฉพาะชั้นเชื่อมต่อ backend จาก `google.script.run` เป็น Supabase Edge Function เดียว (`gsr()` ยังหน้าตาเหมือนเดิม)

```
servicems/
├── index.html                      # Frontend (วางบน GitHub Pages)
├── schema.sql                      # โครงสร้าง Database + seed + RLS
├── supabase/functions/api/index.ts # Backend ทั้งหมด (1 Edge Function)
└── README.md
```

สถาปัตยกรรมความปลอดภัย: หน้าเว็บถือแค่ **anon key** (public ได้) → ยิงไปที่ Edge Function → Edge Function ใช้ **service-role key** (เก็บฝั่ง server) คุยกับ DB ส่วน RLS ตั้งเป็น *default-deny* ทุกตาราง ดังนั้น anon key เปล่า ๆ แตะ DB ตรง ๆ ไม่ได้เลย

---

## ขั้นที่ 1 — สร้างฐานข้อมูล (SQL)
1. ไปที่ [supabase.com](https://supabase.com) → สร้าง Project ใหม่ (จดรหัส Database ไว้)
2. เมนูซ้าย → **SQL Editor** → **New query**
3. คัดลอกทั้งไฟล์ `schema.sql` ไปวาง → กด **Run**
4. จะได้: 10 ตาราง + ฟังก์ชัน bcrypt + RLS + Storage bucket `attachments` + บัญชีเริ่มต้น 3 ตัว

บัญชีเริ่มต้น (⚠️ เปลี่ยนรหัสทันทีหลังล็อกอินที่ Settings → Password):

| Username | Password | Role | สิทธิ์ |
|---|---|---|---|
| `manager` | `manager123` | manager | เต็ม + System Settings |
| `section` | `section123` | section | Review & Approve |
| `project` | `project123` | project | สร้าง Handover / LBS |

---

## ขั้นที่ 2 — เอา API Keys มาใส่หน้าเว็บ
1. Supabase → **Project Settings → API**
2. คัดลอก **Project URL** และ **anon / public key**
3. เปิด `index.html` แก้ 2 บรรทัดบนสุดของ `<script>`:
```js
var SUPABASE_URL      = 'https://YOUR_PROJECT_REF.supabase.co';  // วาง Project URL
var SUPABASE_ANON_KEY = 'YOUR_PUBLIC_ANON_KEY';                  // วาง anon key
```
> ใช้ **anon key เท่านั้น** ห้ามวาง service_role key ในหน้าเว็บเด็ดขาด

---

## ขั้นที่ 3 — Deploy Edge Function (Backend)
ติดตั้ง Supabase CLI ([คู่มือ](https://supabase.com/docs/guides/cli)) แล้วรันในโฟลเดอร์โปรเจกต์:
```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy api --no-verify-jwt
```
> `--no-verify-jwt` จำเป็น เพราะเราใช้ระบบ session token ของเราเอง (ไม่ใช่ Supabase Auth)

ตั้งค่า Secrets ฝั่ง server (service-role key มีให้อัตโนมัติแล้ว ไม่ต้องตั้ง):
```bash
# อีเมล (ไม่ใส่ก็ได้ — ระบบจะข้ามการส่งอีเมลไปเฉย ๆ)
supabase secrets set RESEND_API_KEY="re_xxxxxxxx"
supabase secrets set EMAIL_FROM="ServiceMS <noreply@yourdomain.com>"
```

### การแจ้งเตือน LINE + Email
- **LINE:** สร้าง *Messaging API channel* ที่ [LINE Developers](https://developers.line.biz) → คัดลอก **Channel Access Token** → กรอกในแอปที่ **Settings → Notifications** (Target ID เว้นว่าง = Broadcast หาผู้ติดตามทั้งหมด)
- **Email:** สมัคร [Resend](https://resend.com) → เอา API key มาตั้งเป็น secret `RESEND_API_KEY` ข้างบน → ใส่อีเมลผู้รับใน Settings → Notifications
- ระบบจะยิงแจ้งเตือนอัตโนมัติตอน: สร้าง/อนุมัติ/ส่งกลับ/สร้าง S.O./S.R./มอบหมายทีม

---

## ขั้นที่ 4 — ขึ้น GitHub Pages
```bash
git init
git add index.html        # วางแค่ index.html ที่ root ก็พอ (schema/supabase ไม่ต้องขึ้นเว็บ)
git commit -m "ServiceMS frontend"
git branch -M main
git remote add origin https://github.com/USERNAME/REPO.git
git push -u origin main
```
จากนั้น: GitHub repo → **Settings → Pages** → Source = `Deploy from a branch` → Branch = `main` / `root` → **Save**
เว็บจะอยู่ที่ `https://USERNAME.github.io/REPO/` (รอ ~1 นาที)

> **CORS:** Edge Function ตั้ง `Access-Control-Allow-Origin: *` ไว้แล้ว จึงเรียกข้ามโดเมนจาก GitHub Pages ได้ทันที (ถ้าอยากล็อกเฉพาะโดเมนของคุณ แก้ค่า `CORS` ใน `index.ts`)

---

## เช็กลิสต์หลัง Deploy
- [ ] รัน `schema.sql` สำเร็จ (เห็น 10 ตารางใน Table Editor)
- [ ] วาง `SUPABASE_URL` + `SUPABASE_ANON_KEY` ใน `index.html` แล้ว
- [ ] `supabase functions deploy api --no-verify-jwt` ผ่าน
- [ ] เปิดเว็บ → ล็อกอิน `manager / manager123` ได้
- [ ] เปลี่ยนรหัสผ่านบัญชีเริ่มต้นทั้ง 3 ที่ Settings → Password
- [ ] (ถ้าใช้) ตั้ง LINE token + Resend key แล้วทดสอบแจ้งเตือน

## หมายเหตุการย้ายระบบ
- **โค้ด UI เดิมคงไว้ครบ 100%** (dashboard, calendar, KPI, ranking, budget, signature pad, before/after photo, PDF print, session 8 ชม.) — เปลี่ยนแค่ `gsr()` bridge + การอัปโหลดไฟล์ (Drive → Supabase Storage)
- เลขรันนิ่ง S.O./S.R. เป็นรูปแบบ `SO-YYYY-NNN` / `SR-YYYY-NNN` สร้างฝั่ง server (กันเลขชนกัน)
- `repair_count` ของ Handover เพิ่มอัตโนมัติเมื่อสร้าง S.O. ที่อ้างถึง job เดียวกัน (ขับ Top-3 Ranking)
- ไม่มีไฟล์ Google Apps Script (`.gs`) เดิมในโปรเจกต์ — logic ฝั่ง server ถูกสร้างใหม่ให้ตรงพฤติกรรมที่หน้าเว็บคาดหวัง หากมีไฟล์ `.gs` เดิม ส่งมาเทียบได้เพื่อความตรงเป๊ะ 100%
