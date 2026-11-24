/* ╔══════════════════════════════════════════════════════════════════════╗
   ║  ServiceMS — Runtime Config                                          ║
   ║  ไฟล์นี้เก็บค่าเชื่อมต่อ Supabase แยกจาก index.html                    ║
   ║                                                                      ║
   ║  ⚠️ แก้เฉพาะตอนเปลี่ยนโปรเจกต์ หรือ bump APP_VERSION ตอน deploy         ║
   ║  ✅ publishable key เป็นคีย์สาธารณะ commit ได้ (RLS ปิดตายทุกตาราง)     ║
   ║  ❌ ห้ามวาง secret key (sb_secret_… / service_role) ที่นี่เด็ดขาด        ║
   ╚══════════════════════════════════════════════════════════════════════╝ */
window.SERVICEMS_CONFIG = {
  // Supabase → Project Settings → API → Project URL
  SUPABASE_URL: 'https://yqmvlsdzppygsrtrctjz.supabase.co',

  // Supabase → Project Settings → API Keys → publishable (คีย์สาธารณะ)
  SUPABASE_ANON_KEY: 'sb_publishable_qU1B87CYzQ9bDrj-h0BvOw_ekE-8xl-',

  // แสดงมุมล่างของ Sidebar — ใช้ยืนยันว่าผู้ใช้เปิดเวอร์ชันล่าสุดจริง
  // 👉 อัปเดตเลขนี้ทุกครั้งที่ deploy
  APP_VERSION: '2026.11.24'
};
