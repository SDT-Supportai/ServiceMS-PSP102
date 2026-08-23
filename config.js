/* ╔══════════════════════════════════════════════════════════════════════╗
   ║  ServiceMS — Runtime Config                                          ║
   ║  ไฟล์นี้เก็บค่าเชื่อมต่อ Supabase แยกจาก index.html                    ║
   ║                                                                      ║
   ║  ⚠️ อย่าแก้ไฟล์นี้เวลาอัปเดตฟีเจอร์ — แก้เฉพาะตอนเปลี่ยนโปรเจกต์         ║
   ║  ✅ ANON KEY เป็นคีย์สาธารณะ commit ได้ (RLS ปิดตายทุกตารางอยู่แล้ว)    ║
   ╚══════════════════════════════════════════════════════════════════════╝ */
window.SERVICEMS_CONFIG = {
  // Supabase → Project Settings → API → Project URL
  SUPABASE_URL: 'https://yqmvlsdzppygsrtrctjz.supabase.co',

  // Supabase → Project Settings → API → Project API keys → anon / public
  SUPABASE_ANON_KEY: 'sb_publishable_qU1B87CYzQ9bDrj-h0BvOw_ekE-8xl-',

  // แสดงมุมล่างของ Sidebar — ใช้ยืนยันว่าผู้ใช้เปิดเวอร์ชันล่าสุดจริง
  APP_VERSION: '2026.08.07'
};
