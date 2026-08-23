// ╔══════════════════════════════════════════════════════════════════════╗
// ║  ServiceMS API — Supabase Edge Function (Deno / TypeScript)            ║
// ║  Single RPC endpoint replacing the original google.script.run backend.║
// ║  Frontend calls:  POST /functions/v1/api  { fn, args, token }         ║
// ║  Uses the SERVICE-ROLE key (server-side only) so RLS stays default-deny║
// ╚══════════════════════════════════════════════════════════════════════╝
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY    = Deno.env.get("RESEND_API_KEY")   ?? "";          // optional (email)
const EMAIL_FROM    = Deno.env.get("EMAIL_FROM")       ?? "ServiceMS <onboarding@resend.dev>";
const SESSION_HOURS = 8;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Sheet name (frontend) → table name (Postgres)
const TBL: Record<string, string> = {
  Handovers: "handovers", LBSWorks: "lbs_works", ServiceOrders: "service_orders",
  ServiceReports: "service_reports", Team: "team",
  ActivityLogs: "activity_logs", Notifications: "notifications", Letters: "letters",
  Checkins: "checkins", CustomerRequests: "customer_requests",
};

// ── Permission Matrix ──────────────────────────────────────────────────────
// Single source of truth for role-based access, enforced server-side.
// Any fn NOT listed here is allowed for every authenticated session
// (reads, logout, PDF, attachment upload, own-password — guarded separately).
const ROLE_REQUIRED: Record<string, readonly string[]> = {
  // Admin — manager only
  serverSaveSettings: ["manager"],
  serverGetSettings:  ["manager"],
  serverTestLine:     ["manager"],
  serverCheckLineQuota: ["manager"],
  serverGetUsers:     ["manager"],
  serverCreateUser:   ["manager"],
  serverUpdateUser:   ["manager"],
  serverSetUserActive:["manager"],
  serverDeleteUser:   ["manager"],
  // LINE approval — ผูกบัญชี/ตั้ง PIN (ผู้อนุมัติ = section + manager)
  serverGenLinkCode:   ["section", "manager"],
  serverGetMyLineLink: ["section", "manager"],
  serverUnlinkLine:    ["section", "manager"],
  serverSetApprovePin: ["section", "manager"],
  serverResetSheets:  ["manager"],
  serverUpdateRecord: ["manager"],
  serverDelete:       ["manager"],
  // Review & service ops — section + manager
  serverApprove:          ["section", "manager"],
  serverReturn:           ["section", "manager"],
  serverCompleteHandover: ["section", "manager"],
  serverCompleteLBS:      ["section", "manager"],
  serverAssignTeam:       ["section", "manager"],
  serverAssignLBS:        ["section", "manager"],
  serverAddTeamMember:    ["section", "manager"],
  serverSetTeamPhoto:     ["section", "manager"],
  serverUpdateBudget:     ["section", "manager"],
  serverCreateSO:         ["section", "manager"],
  serverCreateSR:         ["section", "manager"],
  serverCompleteSR:       ["section", "manager"],
  serverCreateLetter:     ["section", "manager"],
  serverGetNextSO:        ["section", "manager"],
  serverGetNextSR:        ["section", "manager"],
  serverGetNextLetter:    ["section", "manager"],
  serverGetNextSM:        ["section", "manager"],
  serverGetNextWarranty:  ["section", "manager"],
  // Creation — project + manager
  serverCreateHandover: ["project", "manager"],
  serverCreateLBS:      ["project", "manager"],
  // Resubmit a RETURNED item — creator (project) + reviewers
  serverResubmit:       ["project", "section", "manager"],
  // Location check-in on completion — section + manager
  serverAddCheckin:     ["section", "manager"],
  serverCompleteSO:     ["section", "manager"],
  serverPromoteHandover:["section", "manager"],
  // Customer Engagement (LINE Bot) — section screens/rejects; REPAIR final approve = manager only (checked in handler)
  serverApproveCustomerRequest: ["section", "manager"],
  serverRejectCustomerRequest:  ["section", "manager"],
};

// ── helpers ──────────────────────────────────────────────────────────────
const ok  = (data: unknown) => json(data);
const err = (message: string) => json({ __error: message });
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
function bkk(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date()).replace(",", "");
}
function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date()); // YYYY-MM-DD
}
function normTeam(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  if (typeof v === "string" && v.trim()) return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}
async function addLog(user: string, action: string) {
  await db.from("activity_logs").insert({ time: bkk(), user: user || "System", action });
}

// notification + LINE + Email (best-effort, never blocks the main op)
// toLine=false → event รอง: ลงกระดิ่งในเว็บ + email เท่านั้น (ไม่กินโควตา LINE)
async function notify(title: string, desc: string, toLine = true) {
  try { await db.from("notifications").insert({ title, desc, time: bkk(), unread: true }); } catch (_) {}
  try {
    const { data: s } = await db.from("settings").select("*").eq("id", 1).single();
    if (toLine && s?.line_channel_token) {
      await sendLine(s.line_channel_token, s.line_target_id, `📢 ${title}\n${desc}`);
      await maybeAlertQuota(s.line_channel_token, s.line_target_id ?? "", s.line_quota_alert ?? 0); // แจ้งเตือนอัตโนมัติเมื่อโควตาใกล้เต็ม
    }
    if (s?.email_recipients)  await sendEmail(s.email_recipients, `[ServiceMS] ${title}`, `${title}\n\n${desc}`);
  } catch (_) {}
}
// ── LINE Messaging API quota ────────────────────────────────────────────
// quota API calls ไม่นับรวมโควตาข้อความ จึงเรียกเช็คได้โดยไม่กินโควตา
async function lineQuota(token: string): Promise<{ limited: boolean; limit: number; used: number; percent: number; remaining: number } | null> {
  try {
    const qr = await fetch("https://api.line.me/v2/bot/message/quota", { headers: { Authorization: `Bearer ${token}` } });
    if (!qr.ok) return null;
    const q = await qr.json() as { type?: string; value?: number };
    if (q.type !== "limited") return { limited: false, limit: 0, used: 0, percent: 0, remaining: 0 };
    const cr = await fetch("https://api.line.me/v2/bot/message/quota/consumption", { headers: { Authorization: `Bearer ${token}` } });
    const c = cr.ok ? await cr.json() as { totalUsage?: number } : { totalUsage: 0 };
    const limit = q.value ?? 0, used = c.totalUsage ?? 0;
    const percent = limit > 0 ? Math.round((used / limit) * 100) : 0;
    return { limited: true, limit, used, percent, remaining: Math.max(0, limit - used) };
  } catch (_) { return null; }
}
// แจ้งเตือนเมื่อข้ามเกณฑ์ 80% / 95% (ครั้งเดียวต่อเกณฑ์ต่อรอบบิล) — reset เมื่อ % ตกลงต่ำกว่า 50 (รอบใหม่)
async function maybeAlertQuota(token: string, target: string, lastLevel: number) {
  const q = await lineQuota(token);
  if (!q || !q.limited) return;
  if (q.percent < 50 && lastLevel !== 0) { await db.from("settings").update({ line_quota_alert: 0 }).eq("id", 1); return; }
  const level = q.percent >= 95 ? 95 : q.percent >= 80 ? 80 : 0;
  if (level <= lastLevel) return;
  await db.from("settings").update({ line_quota_alert: level }).eq("id", 1);
  const emoji = level >= 95 ? "🚨" : "⚠️";
  await db.from("notifications").insert({
    title: `${emoji} โควตาข้อความ LINE ใกล้เต็ม (${q.percent}%)`,
    desc: `ใช้ไป ${q.used.toLocaleString()} / ${q.limit.toLocaleString()} ข้อความเดือนนี้ (เหลือ ${q.remaining.toLocaleString()})\nโปรดพิจารณาอัปเกรดแผน LINE OA เพื่อไม่ให้แจ้งเตือนขาดช่วง`,
    time: bkk(), unread: true,
  }).catch(() => {});
  await sendLine(token, target, `${emoji} โควตาข้อความ LINE เดือนนี้ใช้ไป ${q.percent}% (${q.used.toLocaleString()}/${q.limit.toLocaleString()})\nใกล้เต็มแล้ว โปรดพิจารณาอัปเกรดแผนเพื่อไม่ให้แจ้งเตือนขาดช่วงค่ะ`);
}
async function teamNames(ids: unknown): Promise<string> {
  const arr = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!arr.length) return "-";
  try {
    const { data } = await db.from("team").select("psp_id, name").in("psp_id", arr as string[]);
    const m = new Map((data ?? []).map((t: Record<string, string>) => [t.psp_id, t.name]));
    return arr.map((id) => (m.get(id as string) ? `${m.get(id as string)} (${id})` : String(id))).join(", ");
  } catch (_) { return arr.join(", "); }
}
// ส่งข้อความ LINE (push ถ้ามี target / broadcast ถ้าไม่มี) — คืนผลจริงจาก LINE API
// เพื่อให้จับสาเหตุที่ push เข้ากลุ่มล้มเหลวได้ (เดิมยิงแล้วไม่อ่าน response เลย → fail เงียบ)
async function sendLine(token: string, target: string, text: string): Promise<{ ok: boolean; status: number; detail: string; mode: string }> {
  const tgt = target?.trim();
  const mode = tgt ? "push" : "broadcast";
  const body = tgt ? { to: tgt, messages: [{ type: "text", text }] } : { messages: [{ type: "text", text }] };
  const url = tgt ? "https://api.line.me/v2/bot/message/push" : "https://api.line.me/v2/bot/message/broadcast";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const detail = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 300);
    if (!res.ok) {
      // log ให้เห็นในหน้า Settings → Activity Logs (เดิมล้มเหลวแบบเงียบสนิท)
      await addLog("LINE", `⚠️ ส่งแจ้งเตือน LINE ล้มเหลว (${mode}, HTTP ${res.status}) target=${tgt || "broadcast"} : ${detail}`).catch(() => {});
    }
    return { ok: res.ok, status: res.status, detail, mode };
  } catch (e) {
    await addLog("LINE", `⚠️ ส่งแจ้งเตือน LINE error (${mode}): ${String((e as Error).message ?? e)}`).catch(() => {});
    return { ok: false, status: 0, detail: String((e as Error).message ?? e), mode };
  }
}
async function sendEmail(recipients: string, subject: string, text: string) {
  if (!RESEND_KEY) return; // email disabled until RESEND_API_KEY is set
  const to = recipients.split(",").map((e) => e.trim()).filter(Boolean);
  if (!to.length) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: EMAIL_FROM, to, subject, text }),
  });
}

// ╔══════════════════════════════════════════════════════════════════════╗
// ║  LINE BOT — Customer Engagement (Register Warranty / Repair Request)  ║
// ║  Webhook: POST /functions/v1/api/line-webhook                          ║
// ║  ลูกค้าคุยกับ Bot → เก็บข้อมูล step-by-step → insert customer_requests ║
// ║  (PENDING) → manager อนุมัติในเว็บ → ย้ายเข้า Handover / S.O.          ║
// ╚══════════════════════════════════════════════════════════════════════╝
type ChatState = {
  line_user_id: string; display_name: string; flow: string; step: number;
  data: Record<string, unknown>;
};
const BOT_MENU =
  "สวัสดีค่ะ 🙏 PSP102 Service Maintenance & Support\nเลือกบริการโดยพิมพ์ข้อความ:\n\n1️⃣ พิมพ์ \"ลงทะเบียน\" — ลงทะเบียนรับประกันสินค้า (Warranty)\n2️⃣ พิมพ์ \"แจ้งซ่อม\" — แจ้งปัญหา/ขอรับบริการซ่อม\n\n(พิมพ์ \"ยกเลิก\" เพื่อเริ่มใหม่ได้ทุกเมื่อค่ะ)";
const BOT_PROMPTS: Record<string, string[]> = {
  // index = step (1-based)
  REGISTER: [
    "",
    "📝 เริ่มลงทะเบียนรับประกัน (1/8)\nงานที่ลงทะเบียนเป็น \"ประเภทใด\" คะ?\n\n1️⃣ Project (ส่งมอบโครงการ)\n2️⃣ LBS (LBS & Support)\n3️⃣ EV Charger\n\nพิมพ์ 1, 2 หรือ 3 ค่ะ",
    "(2/8) กรุณาพิมพ์ \"ชื่อโครงการ\" (Project Name) ค่ะ",
    "(3/8) กรุณาพิมพ์ \"เลขสัญญา\" (Contract No.)\nหากไม่ทราบ พิมพ์ \"ไม่มี\" ค่ะ",
    "(4/8) กรุณาพิมพ์ \"ชื่อลูกค้า / บริษัท\" ค่ะ",
    "(5/8) กรุณาพิมพ์ \"ชื่อผู้ติดต่อ พร้อมเบอร์โทร\" เช่น\nคุณสมชาย 081-234-5678",
    "(6/8) 📍 \"สถานที่ตั้งโครงการ\" — พิมพ์ที่อยู่ หรือกดแชร์ตำแหน่ง (เมนู + → Location) ก็ได้ค่ะ",
    "(7/8) กรุณาพิมพ์ \"ระยะเวลารับประกัน\" รูปแบบ ปี-เดือน-วัน เช่น\n2026-01-01 ถึง 2027-01-01",
    "(8/8) 📎 กรุณาส่ง \"ไฟล์เอกสาร Warranty Period\" (รูปภาพ หรือไฟล์ PDF) ส่งได้หลายไฟล์\nเมื่อส่งครบแล้ว พิมพ์ \"เสร็จ\" เพื่อยืนยันค่ะ",
  ],
  REPAIR: [
    "",
    "🔧 เริ่มแจ้งซ่อม (1/6)\nกรุณาพิมพ์ \"เลขงาน (Job No.)\" หรือ \"ชื่อโครงการ\" ที่ต้องการแจ้งซ่อมค่ะ",
    "(2/6) กรุณาพิมพ์ \"ชื่อผู้แจ้ง / บริษัท\" ค่ะ",
    "(3/6) กรุณาพิมพ์ \"เบอร์โทรติดต่อ\" ค่ะ",
    "(4/6) กรุณาพิมพ์ \"อาการ / รายละเอียดปัญหา และจุดที่เสีย\" (เช่น ชั้น/โซน/อาคาร) ค่ะ",
    "(5/6) 🗓️ \"วัน-เวลาที่สะดวกให้เจ้าหน้าที่เข้าตรวจ\" เช่น 15/07/2026 ช่วงเช้า\nหากยังไม่สะดวกระบุ พิมพ์ \"ข้าม\" ค่ะ",
    "(6/6) 📎 กรุณาส่ง \"รูปภาพ/ไฟล์\" ประกอบการแจ้งซ่อม อย่างน้อย 1 รูป\nเมื่อส่งครบแล้ว พิมพ์ \"เสร็จ\" เพื่อยืนยันค่ะ",
  ],
};
const FILE_STEP: Record<string, number> = { REGISTER: 8, REPAIR: 6 };
const REGISTER_TYPES: Record<string, string> = { PROJECT: "Project", LBS: "LBS", EV: "EV Charger" };

async function verifyLineSignature(secret: string, body: string, signature: string): Promise<boolean> {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  let bin = "";
  for (const b of new Uint8Array(mac)) bin += String.fromCharCode(b);
  return btoa(bin) === signature;
}
async function lineReply(token: string, replyToken: string, messages: unknown[]) {
  try {
    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ replyToken, messages }),
    });
  } catch (_) { /* best-effort */ }
}
function botTxt(text: string, quick?: string[]) {
  const m: Record<string, unknown> = { type: "text", text };
  if (quick && quick.length) {
    m.quickReply = { items: quick.map((q) => ({ type: "action", action: { type: "message", label: q.slice(0, 20), text: q } })) };
  }
  return m;
}
async function lineProfileName(token: string, userId: string): Promise<string> {
  try {
    const r = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return "";
    return ((await r.json()) as { displayName?: string }).displayName ?? "";
  } catch (_) { return ""; }
}
async function fetchLineContent(token: string, messageId: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    const r = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const mime = r.headers.get("content-type") ?? "application/octet-stream";
    return { bytes: new Uint8Array(await r.arrayBuffer()), mime };
  } catch (_) { return null; }
}
async function uploadBytes(prefix: string, name: string, bytes: Uint8Array, mime: string): Promise<string> {
  const safe = (name || "file").replace(/[^\w.\-]/g, "_");
  const path = `${prefix}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${safe}`;
  const up = await db.storage.from("attachments").upload(path, bytes, { contentType: mime || "application/octet-stream", upsert: true });
  if (up.error) throw new Error(up.error.message);
  return db.storage.from("attachments").getPublicUrl(path).data.publicUrl;
}
async function getChatState(uid: string): Promise<ChatState | null> {
  const { data } = await db.from("line_chat_states").select("*").eq("line_user_id", uid).single();
  if (!data) return null;
  return { line_user_id: data.line_user_id, display_name: data.display_name ?? "", flow: data.flow ?? "", step: data.step ?? 0, data: (data.data ?? {}) as Record<string, unknown> };
}
async function setChatState(s: ChatState) {
  await db.from("line_chat_states").upsert({
    line_user_id: s.line_user_id, display_name: s.display_name, flow: s.flow, step: s.step,
    data: s.data, updated_at: new Date().toISOString(),
  });
}
async function clearChatState(uid: string) {
  await db.from("line_chat_states").delete().eq("line_user_id", uid);
}
// push a LINE message to a specific customer (best-effort)
async function linePushToCustomer(userId: string, text: string) {
  try {
    const { data: s } = await db.from("settings").select("line_channel_token").eq("id", 1).single();
    if (s?.line_channel_token && userId) await sendLine(s.line_channel_token, userId, text);
  } catch (_) { /* best-effort */ }
}
// แจ้งความคืบหน้างานซ่อมหาลูกค้า — เฉพาะ S.O. ที่เกิดจากคำขอแจ้งซ่อมผ่าน LINE
// (จับคู่จาก customer_requests.result_ref = so_no; S.O. ที่ทีมสร้างเองจะไม่ push)
async function linePushRepairProgress(so_no: string, text: string) {
  if (!so_no) return;
  try {
    const { data } = await db.from("customer_requests")
      .select("line_user_id").eq("kind", "REPAIR").eq("result_ref", so_no).limit(1);
    const cr = (data ?? [])[0];
    if (cr?.line_user_id) await linePushToCustomer(cr.line_user_id, text);
  } catch (_) { /* best-effort */ }
}

async function submitCustomerRequest(state: ChatState, reply: (m: unknown[]) => Promise<void>) {
  const d = state.data as Record<string, unknown>;
  const s = (k: string) => (d[k] as string) ?? "";
  const files = Array.isArray(d.files) ? (d.files as string[]).join("||") : "";
  const isReg = state.flow === "REGISTER";
  const { data: row, error } = await db.from("customer_requests").insert({
    kind: state.flow, register_type: s("register_type") || "PROJECT",
    line_user_id: state.line_user_id, line_display_name: state.display_name,
    project_name: s("project_name"), contract_no: s("contract_no"), location: s("location"),
    lat: typeof d.lat === "number" ? d.lat : null, lng: typeof d.lng === "number" ? d.lng : null,
    customer_name: s("customer_name"), customer_contact: s("customer_contact") || s("customer_name"),
    phone: s("phone"), preferred_time: s("preferred_time"),
    ref_job_no: s("ref_job_no"), warranty_start: s("warranty_start"),
    warranty_end: s("warranty_end"), detail: s("detail"),
    attachment_files: files, status: "PENDING",
  }).select("id").single();
  if (error || !row) { await reply([botTxt("ขออภัยค่ะ บันทึกข้อมูลไม่สำเร็จ กรุณาพิมพ์ \"เสร็จ\" เพื่อลองใหม่อีกครั้ง")]); return; }
  await clearChatState(state.line_user_id);
  const who = state.display_name || state.line_user_id;
  const nFiles = Array.isArray(d.files) ? (d.files as string[]).length : 0;
  await addLog("LINE Bot", `${isReg ? "Customer Register" : "Customer Repair Request"} received from ${who}`);
  await notify(
    isReg ? "🛡️ ลูกค้าลงทะเบียน (PENDING)" : "🛠️ ลูกค้าแจ้งซ่อม (PENDING)",
    (isReg
      ? `${REGISTER_TYPES[s("register_type")] || "Project"} · ${s("project_name") || "-"}\nลูกค้า ${s("customer_name") || "-"} · โทร ${s("phone") || "-"}\nWarranty ${s("warranty_start") || "-"} → ${s("warranty_end") || "-"}`
      : `อ้างอิง ${s("ref_job_no") || s("project_name") || "-"}\nผู้แจ้ง ${s("customer_name") || "-"} · โทร ${s("phone") || "-"}\nอาการ: ${s("detail") || "-"}`)
    + `\n📎 ${nFiles} ไฟล์ · รอตรวจสอบในเมนู ${isReg ? "Customer Register" : "Customer Repair Requests"}`,
  );
  await reply([botTxt(
    (isReg
      ? `✅ ส่งข้อมูลลงทะเบียนรับประกันเรียบร้อยแล้วค่ะ\n\nประเภทงาน: ${REGISTER_TYPES[s("register_type")] || "Project"}\nโครงการ: ${s("project_name") || "-"}\nเลขสัญญา: ${s("contract_no") || "-"}\nWarranty: ${s("warranty_start") || "-"} ถึง ${s("warranty_end") || "-"}\nไฟล์แนบ: ${nFiles} ไฟล์\n\nเจ้าหน้าที่จะตรวจสอบและแจ้งเลขงาน (Job No.) ให้ทราบทาง LINE นี้เมื่ออนุมัติแล้วค่ะ 🙏`
      : `✅ ส่งข้อมูลแจ้งซ่อมเรียบร้อยแล้วค่ะ\n\nอ้างอิง: ${s("ref_job_no") || s("project_name") || "-"}\nอาการ: ${s("detail") || "-"}\nสะดวกให้เข้าตรวจ: ${s("preferred_time") || "ไม่ระบุ"}\nไฟล์แนบ: ${nFiles} ไฟล์\n\nเจ้าหน้าที่จะตรวจสอบและแจ้งผลให้ทราบทาง LINE นี้ค่ะ 🙏`),
  )]);
}

// ผูกบัญชี LINE กับ user ในระบบ ด้วยรหัส 6 หลักที่ออกจากหน้าเว็บ (อายุ 10 นาที)
async function tryStaffLink(uid: string, code: string, reply: (m: unknown[]) => Promise<void>): Promise<boolean> {
  const { data: u } = await db.from("users").select("username, link_code_expires").eq("link_code", code).limit(1);
  const row = (u ?? [])[0];
  if (!row) return false;
  if (row.link_code_expires && new Date(row.link_code_expires).getTime() < Date.now()) {
    await reply([botTxt("รหัสผูกบัญชีหมดอายุแล้ว กรุณาสร้างรหัสใหม่ในเว็บ (Settings → LINE Approval) ค่ะ")]);
    return true;
  }
  await db.from("users").update({ line_user_id: uid, link_code: null, link_code_expires: null }).eq("username", row.username);
  await clearChatState(uid);
  await addLog(row.username, "Linked LINE account");
  await reply([botTxt(`✅ ผูกบัญชี "${row.username}" กับ LINE นี้เรียบร้อยแล้วค่ะ\n\nต่อไปเมื่อมีงานรอพิจารณา ท่านจะได้รับการ์ดอนุมัติที่แชทนี้ พร้อมปุ่มอนุมัติ/ตีกลับ 🙏`)]);
  return true;
}
// กดปุ่มในการ์ด (approve/return) → เริ่มขั้นตอนยืนยัน
async function handleStaffPostback(uid: string, data: string, reply: (m: unknown[]) => Promise<void>) {
  const staff = await staffByLine(uid);
  if (!staff) { await reply([botTxt("บัญชี LINE นี้ยังไม่ได้ผูกกับระบบ กรุณาผูกบัญชีในเว็บ (Settings → LINE Approval) ก่อนค่ะ")]); return; }
  const p = new URLSearchParams(data);
  const act = p.get("act") ?? "", sheet = p.get("sheet") ?? "", id = p.get("id") ?? "";
  if (!sheet || !id) { await reply([botTxt("ข้อมูลรายการไม่ครบ กรุณาลองใหม่ค่ะ")]); return; }
  if (act === "approve") {
    const { data: acc } = await db.from("users").select("approve_pin_hash").eq("username", staff.username).single();
    if (!acc?.approve_pin_hash) { await reply([botTxt("ท่านยังไม่ได้ตั้ง PIN สำหรับอนุมัติ กรุณาตั้ง PIN ในเว็บ (Settings → LINE Approval) ก่อนค่ะ")]); return; }
    await setChatState({ line_user_id: uid, display_name: staff.name, flow: "APPROVE_PIN", step: 1, data: { sheet, id, tries: 0 } });
    await reply([botTxt("🔐 กรุณาพิมพ์ PIN 4-6 หลัก เพื่อยืนยันการอนุมัติ\n(พิมพ์ \"ยกเลิก\" เพื่อยกเลิก)")]);
  } else if (act === "return") {
    await setChatState({ line_user_id: uid, display_name: staff.name, flow: "RETURN_REASON", step: 1, data: { sheet, id } });
    await reply([botTxt("↩️ กรุณาพิมพ์เหตุผลการตีกลับ เพื่อแจ้งผู้ส่งงาน\n(พิมพ์ \"ยกเลิก\" เพื่อยกเลิก)")]);
  }
}
// ขั้นตอนยืนยัน PIN (อนุมัติ) / ระบุเหตุผล (ตีกลับ)
async function handleStaffFlow(uid: string, state: ChatState, text: string, reply: (m: unknown[]) => Promise<void>) {
  const low = text.toLowerCase();
  if (low === "ยกเลิก" || low === "cancel") { await clearChatState(uid); await reply([botTxt("ยกเลิกรายการแล้วค่ะ")]); return; }
  const staff = await staffByLine(uid);
  if (!staff) { await clearChatState(uid); await reply([botTxt("บัญชี LINE นี้ไม่ได้ผูกกับระบบแล้ว")]); return; }
  const sheet = String(state.data.sheet ?? ""), id = String(state.data.id ?? "");
  if (state.flow === "APPROVE_PIN") {
    if (!/^\d{4,6}$/.test(text)) { await reply([botTxt("PIN ต้องเป็นตัวเลข 4-6 หลักค่ะ")]); return; }
    const { data: okPin } = await db.rpc("verify_approve_pin", { p_username: staff.username, p_pin: text });
    if (!okPin) {
      const tries = (Number(state.data.tries) || 0) + 1;
      if (tries >= 3) { await clearChatState(uid); await reply([botTxt("❌ PIN ไม่ถูกต้อง 3 ครั้ง — ยกเลิกรายการเพื่อความปลอดภัย")]); return; }
      state.data.tries = tries; await setChatState(state);
      await reply([botTxt(`❌ PIN ไม่ถูกต้อง (ครั้งที่ ${tries}/3) กรุณาลองใหม่`)]); return;
    }
    const res = await doApprove(sheet, id, staff.username, staff.role);
    await clearChatState(uid);
    await reply([botTxt(res.ok ? `✅ อนุมัติเรียบร้อยแล้วค่ะ\n${res.label} ${res.job_no ?? ""}` : `❌ ${res.error}`)]);
  } else if (state.flow === "RETURN_REASON") {
    if (text.length < 3) { await reply([botTxt("กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษรค่ะ")]); return; }
    const res = await doReturn(sheet, id, text, staff.username);
    await clearChatState(uid);
    await reply([botTxt(res.ok ? `↩️ ตีกลับเรียบร้อยแล้วค่ะ (${res.job_no ?? ""})\nเหตุผล: ${text}` : `❌ ${res.error}`)]);
  }
}

async function handleLineEvent(token: string, ev: Record<string, any>) {
  // คุยเฉพาะแชท 1:1 กับลูกค้า — เงียบในกลุ่ม/ห้อง (กันเด้งเมนูใส่กลุ่มทีมงานที่ใช้เป็น Target แจ้งเตือน)
  if (ev?.source?.type && ev.source.type !== "user") return;
  const uid: string = ev?.source?.userId ?? "";
  if (!uid) return;
  const reply = async (msgs: unknown[]) => { if (ev.replyToken) await lineReply(token, ev.replyToken, msgs); };

  // ── STAFF: กดปุ่มอนุมัติ/ตีกลับ จากการ์ด (postback) ──
  if (ev.type === "postback") { await handleStaffPostback(uid, String(ev.postback?.data ?? ""), reply); return; }

  if (ev.type === "follow") {
    await clearChatState(uid);
    await reply([botTxt(BOT_MENU, ["ลงทะเบียน", "แจ้งซ่อม"])]);
    return;
  }
  if (ev.type !== "message") return;
  const m = ev.message ?? {};
  const state = await getChatState(uid);

  // ── STAFF: อยู่ในขั้นตอนยืนยัน PIN / ระบุเหตุผลตีกลับ (ต้องมาก่อน flow ลูกค้า) ──
  if (m.type === "text" && state && (state.flow === "APPROVE_PIN" || state.flow === "RETURN_REASON")) {
    await handleStaffFlow(uid, state, String(m.text ?? "").trim(), reply);
    return;
  }
  // ── STAFF: ผูกบัญชี — พิมพ์รหัส 6 หลักตอนยังไม่อยู่ใน flow ใด ──
  if (m.type === "text" && (!state || !state.flow) && /^\d{6}$/.test(String(m.text ?? "").trim())) {
    if (await tryStaffLink(uid, String(m.text).trim(), reply)) return;
    // ไม่ตรงรหัสผูกบัญชี → ตกไปที่ flow ลูกค้าตามปกติ
  }

  // ── attachment upload (image / file / video) ──
  if (m.type === "image" || m.type === "file" || m.type === "video") {
    if (!state || !state.flow || state.step !== FILE_STEP[state.flow]) {
      await reply([botTxt("กรุณาเริ่มรายการก่อนส่งไฟล์ค่ะ\n\n" + BOT_MENU, ["ลงทะเบียน", "แจ้งซ่อม"])]);
      return;
    }
    const c = await fetchLineContent(token, String(m.id));
    if (!c) { await reply([botTxt("ขออภัยค่ะ รับไฟล์ไม่สำเร็จ กรุณาส่งใหม่อีกครั้ง")]); return; }
    const files = Array.isArray(state.data.files) ? (state.data.files as string[]) : [];
    const ext = c.mime.includes("pdf") ? "pdf" : c.mime.includes("png") ? "png" : c.mime.includes("jpeg") ? "jpg" : "bin";
    const name = (m.fileName as string) || `${state.flow === "REGISTER" ? "warranty_doc" : "repair_photo"}_${files.length + 1}.${ext}`;
    try {
      const url = await uploadBytes(`CustomerRequests/${uid}`, name, c.bytes, c.mime);
      state.data.files = [...files, `${name}::${url}`];
      await setChatState(state);
      await reply([botTxt(`✅ รับไฟล์แล้ว (${files.length + 1} ไฟล์)\nส่งไฟล์เพิ่มได้ หรือพิมพ์ "เสร็จ" เพื่อยืนยันการส่งข้อมูลค่ะ`, ["เสร็จ"])]);
    } catch (_) {
      await reply([botTxt("ขออภัยค่ะ อัปโหลดไฟล์ไม่สำเร็จ กรุณาส่งใหม่อีกครั้ง")]);
    }
    return;
  }
  // ── LINE location share (REGISTER step 6: สถานที่ตั้งโครงการ) ──
  if (m.type === "location") {
    if (state && state.flow === "REGISTER" && state.step === 6) {
      const addr = [m.title, m.address].filter(Boolean).join(" ") || `${m.latitude},${m.longitude}`;
      state.data = { ...state.data, location: addr, lat: m.latitude, lng: m.longitude };
      state.step = 7;
      await setChatState(state);
      await reply([botTxt(`✅ รับตำแหน่งแล้ว: ${addr}\n\n` + BOT_PROMPTS.REGISTER[7])]);
    } else {
      await reply([botTxt("ขอบคุณค่ะ แต่ขั้นตอนนี้ยังไม่ต้องใช้ตำแหน่ง 📍\nพิมพ์ \"ยกเลิก\" เพื่อเริ่มใหม่ได้ค่ะ")]);
    }
    return;
  }
  if (m.type !== "text") return;
  const text = String(m.text ?? "").trim();
  const low = text.toLowerCase();

  // ── global commands ──
  if (low === "ยกเลิก" || low === "cancel") {
    await clearChatState(uid);
    await reply([botTxt("ยกเลิกรายการแล้วค่ะ 🙏\n\n" + BOT_MENU, ["ลงทะเบียน", "แจ้งซ่อม"])]);
    return;
  }
  const idle = !state || !state.flow; // เลขเมนูลัด (1/2) ใช้ได้เฉพาะตอนยังไม่อยู่ใน flow — กันชนกับคำตอบที่เป็นตัวเลขระหว่างขั้นตอน
  if (low === "ลงทะเบียน" || low === "register" || (idle && (low === "1" || low === "1️⃣"))) {
    const name = await lineProfileName(token, uid);
    await setChatState({ line_user_id: uid, display_name: name, flow: "REGISTER", step: 1, data: {} });
    await reply([botTxt(BOT_PROMPTS.REGISTER[1], ["1. Project", "2. LBS", "3. EV Charger"])]);
    return;
  }
  if (low === "แจ้งซ่อม" || low === "repair" || (idle && (low === "2" || low === "2️⃣"))) {
    const name = await lineProfileName(token, uid);
    await setChatState({ line_user_id: uid, display_name: name, flow: "REPAIR", step: 1, data: {} });
    await reply([botTxt(BOT_PROMPTS.REPAIR[1])]);
    return;
  }
  if (!state || !state.flow) {
    await reply([botTxt(BOT_MENU, ["ลงทะเบียน", "แจ้งซ่อม"])]);
    return;
  }

  // ── step answers ──
  const flow = state.flow, step = state.step;
  const next = async (patch: Record<string, unknown>) => {
    state.data = { ...state.data, ...patch };
    state.step = step + 1;
    await setChatState(state);
    await reply([botTxt(BOT_PROMPTS[flow][state.step])]);
  };
  if (flow === "REGISTER") {
    if (step === 1) {
      // ประเภทงาน → กำหนดกล่องปลายทาง (Project → handovers | LBS/EV → lbs_works)
      const rt = low.startsWith("1") || low.includes("project") || low.includes("โปรเจ") ? "PROJECT"
        : low.startsWith("2") || low.includes("lbs") ? "LBS"
        : low.startsWith("3") || low.includes("ev") || low.includes("อีวี") ? "EV" : "";
      if (!rt) {
        await reply([botTxt("กรุณาเลือกประเภทงานค่ะ\n1️⃣ Project · 2️⃣ LBS · 3️⃣ EV Charger\nพิมพ์ 1, 2 หรือ 3", ["1. Project", "2. LBS", "3. EV Charger"])]);
        return;
      }
      return void await next({ register_type: rt });
    }
    if (step === 2) return void await next({ project_name: text });
    if (step === 3) return void await next({ contract_no: (low === "ไม่มี" || low === "-") ? "" : text });
    if (step === 4) return void await next({ customer_name: text });
    if (step === 5) {
      // แยกเบอร์โทรออกจากชื่อผู้ติดต่อ (เช่น "คุณสมชาย 081-234-5678")
      const ph = text.match(/0[\d\-\s()]{7,14}\d/);
      if (!ph) {
        await reply([botTxt("ไม่พบเบอร์โทรค่ะ กรุณาพิมพ์ \"ชื่อผู้ติดต่อ พร้อมเบอร์โทร\" เช่น\nคุณสมชาย 081-234-5678")]);
        return;
      }
      const contact = text.replace(ph[0], "").replace(/[,|/]/g, " ").trim();
      return void await next({ customer_contact: contact, phone: ph[0].replace(/\s+/g, "") });
    }
    if (step === 6) return void await next({ location: text }); // หรือแชร์ตำแหน่ง (จัดการใน m.type === "location")
    if (step === 7) {
      const ds = text.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
      if (ds.length < 2) {
        await reply([botTxt("รูปแบบวันที่ไม่ถูกต้องค่ะ กรุณาพิมพ์วันเริ่มและวันสิ้นสุด รูปแบบ ปี-เดือน-วัน เช่น\n2026-01-01 ถึง 2027-01-01")]);
        return;
      }
      return void await next({ warranty_start: ds[0], warranty_end: ds[1] });
    }
    if (step === 8) {
      if (low === "เสร็จ" || low === "done" || low === "ส่ง") {
        const files = Array.isArray(state.data.files) ? (state.data.files as string[]) : [];
        if (!files.length) { await reply([botTxt("กรุณาส่งไฟล์เอกสาร Warranty Period อย่างน้อย 1 ไฟล์ก่อนยืนยันค่ะ 📎")]); return; }
        await submitCustomerRequest(state, reply);
        return;
      }
      await reply([botTxt("กรุณาส่งไฟล์เอกสาร Warranty (รูปภาพ/PDF) หรือพิมพ์ \"เสร็จ\" เพื่อยืนยัน / \"ยกเลิก\" เพื่อเริ่มใหม่ค่ะ", ["เสร็จ", "ยกเลิก"])]);
      return;
    }
  }
  if (flow === "REPAIR") {
    if (step === 1) {
      // try to match an existing handover by job_no (exact) or project name (contains)
      let ref = "", proj = text;
      const { data: byJob } = await db.from("handovers").select("job_no, project_name, status").ilike("job_no", text).limit(1);
      let hit = (byJob ?? [])[0];
      if (!hit) {
        const { data: byName } = await db.from("handovers").select("job_no, project_name, status").ilike("project_name", `%${text}%`).limit(1);
        hit = (byName ?? [])[0];
      }
      if (hit && (hit.status === "APPROVED" || hit.status === "COMPLETED")) { ref = hit.job_no; proj = hit.project_name; }
      state.data = { ...state.data, ref_job_no: ref, project_name: proj };
      state.step = 2;
      await setChatState(state);
      const found = ref ? `✅ พบโครงการ: ${proj} (${ref})\n\n` : "";
      await reply([botTxt(found + BOT_PROMPTS.REPAIR[2])]);
      return;
    }
    if (step === 2) return void await next({ customer_name: text });
    if (step === 3) return void await next({ phone: text });
    if (step === 4) return void await next({ detail: text });
    if (step === 5) return void await next({ preferred_time: (low === "ข้าม" || low === "skip") ? "" : text });
    if (step === 6) {
      if (low === "เสร็จ" || low === "done" || low === "ส่ง") {
        const files = Array.isArray(state.data.files) ? (state.data.files as string[]) : [];
        if (!files.length) { await reply([botTxt("กรุณาส่งรูปภาพ/ไฟล์ประกอบการแจ้งซ่อมอย่างน้อย 1 รูปก่อนยืนยันค่ะ 📎")]); return; }
        await submitCustomerRequest(state, reply);
        return;
      }
      await reply([botTxt("กรุณาส่งรูป/ไฟล์ประกอบการแจ้งซ่อม (อย่างน้อย 1 รูป) แล้วพิมพ์ \"เสร็จ\" เพื่อยืนยันค่ะ", ["เสร็จ", "ยกเลิก"])]);
      return;
    }
  }
  // unknown state — reset
  await clearChatState(uid);
  await reply([botTxt(BOT_MENU, ["ลงทะเบียน", "แจ้งซ่อม"])]);
}

async function handleLineWebhook(req: Request): Promise<Response> {
  const body = await req.text();
  const { data: s } = await db.from("settings").select("line_channel_token, line_channel_secret").eq("id", 1).single();
  const token = s?.line_channel_token ?? "", secret = s?.line_channel_secret ?? "";
  // Not configured yet → 200 so LINE's "Verify" button succeeds, but ignore events.
  if (!token || !secret) return new Response("ok", { headers: CORS });
  const okSig = await verifyLineSignature(secret, body, req.headers.get("x-line-signature") ?? "");
  if (!okSig) return new Response("bad signature", { status: 403, headers: CORS });
  let events: Record<string, any>[] = [];
  try { events = JSON.parse(body).events ?? []; } catch (_) { /* verify ping */ }
  for (const ev of events) {
    try { await handleLineEvent(token, ev); } catch (e) { console.error("LINE event error:", e); }
  }
  return new Response("ok", { headers: CORS });
}

// auto-numbering: PREFIX-YYYY-NNN
async function nextNo(table: string, col: string, prefix: string): Promise<string> {
  const yr = today().slice(0, 4);
  const { data } = await db.from(table).select(col).like(col, `${prefix}-${yr}-%`);
  let max = 0;
  for (const r of (data ?? [])) {
    const m = String((r as Record<string, string>)[col] ?? "").match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${yr}-${String(max + 1).padStart(3, "0")}`;
}

// Insert a row whose number column (so_no/sr_no/letter_no) must be unique.
// Relies on a UNIQUE constraint; on a 23505 collision it recomputes and retries,
// so concurrent creates can never share a running number.
async function insertNumbered(
  table: string, col: string, prefix: string,
  build: (no: string) => Record<string, unknown>, retries = 6,
): Promise<{ no: string; row: Record<string, unknown> }> {
  for (let i = 0; i < retries; i++) {
    const no = await nextNo(table, col, prefix);
    const { data, error } = await db.from(table).insert(build(no)).select().single();
    if (!error) return { no, row: data };
    if ((error as { code?: string }).code === "23505") continue; // unique_violation → retry
    throw new Error(error.message);
  }
  throw new Error("ไม่สามารถสร้างเลขที่ไม่ซ้ำได้ กรุณาลองใหม่อีกครั้ง");
}

// Shared running number across several (table,col) sources: the numeric part is
// drawn from the max over ALL sources for the year, so numbers never repeat
// across the group (e.g. S.O. + S.R.); each doc keeps its own prefix.
type NoSource = { table: string; col: string };
const SOSR_SOURCES: NoSource[] = [
  { table: "service_orders", col: "so_no" },
  { table: "service_reports", col: "sr_no" },
];
const LETTER_SOURCES: NoSource[] = [{ table: "letters", col: "letter_no" }];
const LETTER_PREFIX = "SL"; // unified prefix for every Service Letter type
async function nextSharedNo(sources: NoSource[], prefix: string): Promise<string> {
  const yr = today().slice(0, 4);
  let max = 0;
  for (const s of sources) {
    const { data } = await db.from(s.table).select(s.col).like(s.col, `%-${yr}-%`);
    for (const r of (data ?? [])) {
      const m = String((r as Record<string, string>)[s.col] ?? "").match(/(\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return `${prefix}-${yr}-${String(max + 1).padStart(3, "0")}`;
}
async function insertSharedNumbered(
  table: string, sources: NoSource[], prefix: string,
  build: (no: string) => Record<string, unknown>, retries = 6,
): Promise<{ no: string; row: Record<string, unknown> }> {
  for (let i = 0; i < retries; i++) {
    const no = await nextSharedNo(sources, prefix);
    const { data, error } = await db.from(table).insert(build(no)).select().single();
    if (!error) return { no, row: data };
    if ((error as { code?: string }).code === "23505") continue;
    throw new Error(error.message);
  }
  throw new Error("ไม่สามารถสร้างเลขที่ไม่ซ้ำได้ กรุณาลองใหม่อีกครั้ง");
}

// (S.O. status is owned by the Repair Request's manual "Done" — Service Reports
//  no longer derive or change S.O. status, so no recompute is needed.)

// generic single-file upload to Storage → returns public URL
async function uploadOne(prefix: string, name: string, b64: string, mime: string): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const safe = (name || "file").replace(/[^\w.\-]/g, "_");
  const path = `${prefix}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${safe}`;
  const up = await db.storage.from("attachments").upload(path, bytes, { contentType: mime || "application/octet-stream", upsert: true });
  if (up.error) throw new Error(up.error.message);
  return db.storage.from("attachments").getPublicUrl(path).data.publicUrl;
}
// ── Closing issue report (popup ตอนกด Done) ──────────────────────────────
// รับ { flag:'NONE'|'HAS', detail, files:[{name,b64,mime}] } → อัปไฟล์ + คืน patch
type IssuePayload = { flag?: string; detail?: string; files?: { name: string; b64: string; mime: string }[] };
async function buildIssuePatch(folder: string, id: string, issue: IssuePayload | null | undefined):
  Promise<{ patch: Record<string, unknown>; error?: string; has: boolean; detail: string; nFiles: number }> {
  if (!issue || !issue.flag) return { patch: {}, has: false, detail: "", nFiles: 0 };
  const has = issue.flag === "HAS";
  const detail = (issue.detail ?? "").trim();
  if (has && detail.length < 5) return { patch: {}, error: "กรุณาระบุรายละเอียดปัญหาที่พบ", has, detail, nFiles: 0 };
  const patch: Record<string, unknown> = {
    issue_flag: has ? "HAS" : "NONE",
    issue_detail: has ? detail : "",
    issue_files: "",
  };
  let nFiles = 0;
  if (has && Array.isArray(issue.files) && issue.files.length) {
    const urls: string[] = [];
    for (const f of issue.files) {
      try { urls.push(`${f.name}::` + await uploadOne(`Issues/${folder}/${id}`, f.name, f.b64, f.mime)); }
      catch (_) { /* ไฟล์เดียวพังไม่ควรบล็อกการปิดงาน */ }
    }
    patch.issue_files = urls.join("||");
    nFiles = urls.length;
  }
  return { patch, has, detail, nFiles };
}
function dataUrlParts(d: unknown): { b64: string; mime: string } | null {
  const m = String(d ?? "").match(/^data:([^;]+);base64,(.+)$/);
  return m ? { mime: m[1], b64: m[2] } : null;
}

async function requireSession(token: string): Promise<{ username: string; role: string } | null> {
  if (!token) return null;
  const { data } = await db.from("sessions").select("*").eq("token", token).single();
  if (!data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) { await db.from("sessions").delete().eq("token", token); return null; }
  // บัญชีถูกปิด (deactivate) → เตะ session ทันที
  const { data: u } = await db.from("users").select("active").eq("username", data.username).single();
  if (u && u.active === false) { await db.from("sessions").delete().eq("token", token); return null; }
  return { username: data.username, role: data.role };
}
// นับ manager ที่ยัง active อยู่ ยกเว้น username ที่ระบุ — ใช้กันไม่ให้เหลือ manager 0 คน (lockout)
async function otherActiveManagers(excludeUsername: string): Promise<number> {
  const { count } = await db.from("users").select("*", { count: "exact", head: true })
    .eq("role", "manager").eq("active", true).neq("username", excludeUsername);
  return count ?? 0;
}

// ╔══════════════════════════════════════════════════════════════════════╗
// ║  APPROVAL CORE — ใช้ร่วมกันระหว่างเว็บ (session) และ LINE (postback+PIN) ║
// ╚══════════════════════════════════════════════════════════════════════╝
// อนุมัติงาน — บังคับสถานะต้อง SUBMITTED/RESUBMITTED (กันอนุมัติซ้ำ/ข้ามสถานะจากทั้ง 2 ช่องทาง)
async function doApprove(sheet: string, id: string, actorUser: string, actorRole: string):
  Promise<{ ok: boolean; error?: string; label?: string; job_no?: string }> {
  const t = TBL[sheet];
  if (!t) return { ok: false, error: "Bad sheet" };
  const sel = sheet === "LBSWorks" ? "job_no, project_name, work_category, source, status"
    : sheet === "Handovers" ? "job_no, project_name, source, status" : "job_no, project_name, status";
  const { data: rec } = await db.from(t).select(sel).eq("id", id).single();
  const r = (rec ?? {}) as { job_no?: string; project_name?: string; work_category?: string; source?: string; status?: string };
  if (!r.status) return { ok: false, error: "ไม่พบรายการ" };
  if (!["SUBMITTED", "RESUBMITTED"].includes(r.status)) return { ok: false, error: `งานนี้อยู่สถานะ ${r.status} แล้ว (อนุมัติได้เฉพาะที่รอพิจารณา)` };
  if ((sheet === "Handovers" || sheet === "LBSWorks") && r.source === "CUSTOMER" && actorRole !== "manager") return { ok: false, error: "งานลูกค้าต้องให้ Manager อนุมัติ" };
  await db.from(t).update({ status: "APPROVED" }).eq("id", id);
  const label = sheet === "Handovers" ? "Project Handover"
    : sheet === "LBSWorks" ? (r.work_category === "EV" ? "EV Charger Work" : "LBS & Support Work") : sheet;
  await addLog(actorUser, `Approved ${label} ${r.job_no ?? id}`);
  await notify("✅ อนุมัติแล้ว (APPROVED)", `${label} ${r.job_no ?? "-"} · ${r.project_name ?? "-"}\nโดย ${actorUser}`);
  // งานลูกค้า (source=CUSTOMER) → sync คำขอ + แจ้ง Job No. กลับลูกค้า + handover เงา (LBS/EV) + ปักหมุด
  if ((sheet === "Handovers" || sheet === "LBSWorks") && r.source === "CUSTOMER" && r.job_no) {
    const { data: crs } = await db.from("customer_requests").select("*").eq("kind", "REGISTER").eq("result_ref", r.job_no).limit(1);
    const cr = (crs ?? [])[0];
    if (cr) {
      await db.from("customer_requests").update({ status: "APPROVED" }).eq("id", cr.id);
      if (sheet === "LBSWorks") {
        const src = r.work_category === "EV" ? "EV" : "LBS";
        const { data: dup } = await db.from("handovers").select("id").eq("job_no", r.job_no).limit(1);
        if (!dup || !dup.length) {
          const notes = [`Mirror จากการลงทะเบียน Warranty ผ่าน LINE (${src})`];
          if (cr.contract_no) notes.push(`เลขสัญญา: ${cr.contract_no}`);
          await db.from("handovers").insert({
            job_no: r.job_no, project_name: r.project_name ?? cr.project_name, location: cr.location,
            customer_name: cr.customer_name, customer_contact: cr.customer_contact || cr.customer_name,
            phone: cr.phone, email: "", handover_date: today(),
            warranty_type: "FULL", warranty_start: cr.warranty_start, warranty_end: cr.warranty_end,
            warranty_budget: 0, project_manager: actorUser, status: "COMPLETED",
            source: src, attachment_files: cr.attachment_files ?? "", repair_count: 0, comments: notes.join(" · "),
          });
        }
      }
      await linePushToCustomer(cr.line_user_id, `🎉 การลงทะเบียนรับประกันของท่านได้รับการอนุมัติแล้วค่ะ\n\nเลขงาน (Job No.): ${r.job_no}\nโครงการ: ${r.project_name ?? "-"}\n\nกรุณาใช้เลขงานนี้อ้างอิงเมื่อแจ้งซ่อม (พิมพ์ "แจ้งซ่อม" ได้ทุกเมื่อ) ขอบคุณที่ใช้บริการค่ะ 🙏`);
      if (typeof cr.lat === "number" && typeof cr.lng === "number") {
        await db.from("checkins").insert({ kind: "CUSTOMER", ref_no: r.job_no, lat: cr.lat, lng: cr.lng, label: "Customer Register", project: r.project_name ?? "", status: "APPROVED", who: cr.customer_name || "LINE Customer" });
      }
    }
  }
  return { ok: true, label, job_no: r.job_no };
}
async function doReturn(sheet: string, id: string, comments: string, actorUser: string):
  Promise<{ ok: boolean; error?: string; job_no?: string }> {
  const t = TBL[sheet];
  if (t !== "handovers" && t !== "lbs_works") return { ok: false, error: "Bad sheet" };
  const { data: cur } = await db.from(t).select("job_no, source, status").eq("id", id).single();
  if (!cur) return { ok: false, error: "ไม่พบรายการ" };
  if (!["SUBMITTED", "RESUBMITTED"].includes(cur.status)) return { ok: false, error: `งานนี้อยู่สถานะ ${cur.status} แล้ว` };
  await db.from(t).update({ status: "RETURNED", comments: comments ?? "" }).eq("id", id);
  await addLog(actorUser, `Returned ${sheet} ${id}`);
  await notify("↩️ ตีกลับแก้ไข", `${sheet}: ${comments ?? "-"}`, false);
  if (cur.source === "CUSTOMER" && cur.job_no) {
    const { data: crs } = await db.from("customer_requests").select("id, line_user_id").eq("kind", "REGISTER").eq("result_ref", cur.job_no).limit(1);
    const cr = (crs ?? [])[0];
    if (cr) {
      await db.from("customer_requests").update({ status: "REJECTED", reject_reason: comments ?? "", reviewed_by: actorUser, reviewed_at: new Date().toISOString() }).eq("id", cr.id);
      await linePushToCustomer(cr.line_user_id, `❌ ขออภัยค่ะ การลงทะเบียนรับประกันของท่านไม่ผ่านการพิจารณา\n\nเหตุผล: ${comments || "-"}\n\nท่านสามารถแก้ไขข้อมูลและส่งใหม่อีกครั้ง โดยพิมพ์ "ลงทะเบียน" ค่ะ 🙏`);
    }
  }
  return { ok: true, job_no: cur.job_no };
}

// ── LINE approval helpers (staff = section/manager ที่ผูก LINE ส่วนตัว) ──
async function staffByLine(uid: string): Promise<{ username: string; role: string; name: string } | null> {
  if (!uid) return null;
  const { data } = await db.from("users").select("username, role, name, active").eq("line_user_id", uid).single();
  if (!data || data.active === false) return null;
  return { username: data.username, role: data.role, name: data.name ?? "" };
}
async function appUrl(): Promise<string> {
  const { data } = await db.from("settings").select("app_url").eq("id", 1).single();
  return (data?.app_url ?? "").trim().replace(/\/+$/, "");
}
// ส่งการ์ดอนุมัติ (Flex) เข้า LINE ส่วนตัวของ manager ที่ผูกบัญชีแล้ว
async function pushApprovalCard(sheet: string, id: string, label: string, jobNo: string, projectName: string, who: string) {
  try {
    const { data: s } = await db.from("settings").select("line_channel_token, app_url").eq("id", 1).single();
    if (!s?.line_channel_token) return;
    const { data: mgrs } = await db.from("users").select("line_user_id").eq("role", "manager").eq("active", true).not("line_user_id", "is", null);
    const targets = (mgrs ?? []).map((m: { line_user_id?: string }) => m.line_user_id).filter(Boolean) as string[];
    if (!targets.length) return;
    const base = (s.app_url ?? "").trim().replace(/\/+$/, "");
    const reviewUrl = base ? `${base}/?open=${sheet}:${id}` : "https://line.me";
    const flex = approvalFlex(label, jobNo, projectName, who, reviewUrl, sheet, id);
    for (const to of targets) {
      await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.line_channel_token}` },
        body: JSON.stringify({ to, messages: [flex] }),
      });
    }
  } catch (e) { console.error("pushApprovalCard error:", e); }
}
function approvalFlex(label: string, jobNo: string, projectName: string, who: string, reviewUrl: string, sheet: string, id: string) {
  return {
    type: "flex", altText: `📋 งานรออนุมัติ: ${jobNo} — ${projectName}`,
    contents: {
      type: "bubble",
      header: { type: "box", layout: "vertical", backgroundColor: "#1a2744", paddingAll: "14px",
        contents: [{ type: "text", text: "📋 งานรออนุมัติ", color: "#ffffff", weight: "bold", size: "md" },
                   { type: "text", text: label, color: "#f5920b", size: "xs", margin: "sm" }] },
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "14px", contents: [
        { type: "box", layout: "baseline", contents: [{ type: "text", text: "Job", color: "#8a94a6", size: "sm", flex: 2 }, { type: "text", text: jobNo || "-", weight: "bold", size: "sm", flex: 5, wrap: true }] },
        { type: "box", layout: "baseline", contents: [{ type: "text", text: "โครงการ", color: "#8a94a6", size: "sm", flex: 2 }, { type: "text", text: projectName || "-", size: "sm", flex: 5, wrap: true }] },
        { type: "box", layout: "baseline", contents: [{ type: "text", text: "ผู้ส่ง", color: "#8a94a6", size: "sm", flex: 2 }, { type: "text", text: who || "-", size: "sm", flex: 5, wrap: true }] },
      ] },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
        { type: "button", style: "link", height: "sm", action: { type: "uri", label: "🔗 เปิดตรวจสอบรายละเอียด", uri: reviewUrl } },
        { type: "box", layout: "horizontal", spacing: "sm", contents: [
          { type: "button", style: "primary", color: "#28a745", height: "sm", action: { type: "postback", label: "✅ อนุมัติ", data: `act=approve&sheet=${sheet}&id=${id}`, displayText: "ขออนุมัติงานนี้" } },
          { type: "button", style: "primary", color: "#e53e3e", height: "sm", action: { type: "postback", label: "↩️ ตีกลับ", data: `act=return&sheet=${sheet}&id=${id}`, displayText: "ขอตีกลับงานนี้" } },
        ] },
      ] },
    },
  };
}

// ── main handler ──────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // LINE Bot webhook (no session — verified via x-line-signature instead)
  if (new URL(req.url).pathname.endsWith("/line-webhook")) {
    if (req.method !== "POST") return new Response("ok", { headers: CORS });
    return await handleLineWebhook(req);
  }
  if (req.method !== "POST")   return err("Method not allowed");

  let payload: { fn?: string; args?: unknown[]; token?: string };
  try { payload = await req.json(); } catch { return err("Bad JSON"); }
  const fn = payload.fn ?? "";
  const a  = payload.args ?? [];
  const token = payload.token ?? "";

  try {
    // ── public actions (no session needed) ──────────────────────────────
    if (fn === "serverLogin") {
      const [username, password] = a as [string, string];
      const { data, error } = await db.rpc("verify_login", { p_username: username, p_password: password });
      if (error) return err(error.message);
      if (!data || !data.length) return ok({ success: false });
      const u = data[0];
      // บัญชีถูกปิดใช้งาน → ล็อกอินไม่ได้
      const { data: acc } = await db.from("users").select("active").eq("username", u.username).single();
      if (acc && acc.active === false) return ok({ success: false, error: "บัญชีนี้ถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ" });
      const tk = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
      const expires = new Date(Date.now() + SESSION_HOURS * 3600_000);
      await db.from("sessions").insert({ token: tk, username: u.username, role: u.role, expires_at: expires.toISOString() });
      await db.from("users").update({ last_login_at: new Date().toISOString() }).eq("username", u.username);
      await addLog(u.username, "Logged in");
      return ok({ success: true, token: tk, user: u.username, role: u.role, expiresIn: SESSION_HOURS });
    }
    if (fn === "serverValidateSession") {
      const s = await requireSession((a[0] as string) ?? token);
      return ok(s ? { success: true, user: s.username, role: s.role } : { success: false });
    }

    // ── everything below requires a valid session ───────────────────────
    const sess = await requireSession(token);
    if (!sess) return err("SESSION_INVALID");
    const actor = sess.username;

    // Role gate — enforce the permission matrix before any privileged action.
    const need = ROLE_REQUIRED[fn];
    if (need && !need.includes(sess.role)) return err("FORBIDDEN");

    switch (fn) {
      case "serverLogout": {
        await db.from("sessions").delete().eq("token", (a[0] as string) ?? token);
        return ok({ success: true });
      }

      case "serverGetAll": {
        const sheet = a[0] as string;
        const table = TBL[sheet];
        if (!table) return ok([]);
        let q = db.from(table).select("*");
        if (table === "activity_logs" || table === "notifications") q = q.order("created_at", { ascending: false }).limit(200);
        else if (table === "team") q = q.order("psp_id", { ascending: true });
        else q = q.order("created_at", { ascending: false });
        const { data, error } = await q;
        if (error) return err(error.message);
        return ok(data ?? []);
      }

      case "serverAddLog": {
        await addLog((a[0] as string) || actor, (a[1] as string) || "");
        return ok({ success: true });
      }

      case "serverMarkNotificationsRead": {
        await db.from("notifications").update({ unread: false }).eq("unread", true);
        return ok({ success: true });
      }

      case "serverGetSettings": {
        const { data } = await db.from("settings").select("*").eq("id", 1).single();
        return ok(data ?? {});
      }
      case "serverSaveSettings": {
        const d = (a[0] as Record<string, string>) ?? {};
        await db.from("settings").upsert({
          id: 1,
          line_channel_token: d.line_channel_token ?? "",
          line_channel_secret: d.line_channel_secret ?? "",
          line_target_id: d.line_target_id ?? "",
          email_recipients: d.email_recipients ?? "",
          app_url: d.app_url ?? "",
          updated_by: (a[1] as string) || actor,
          updated_at: new Date().toISOString(),
        });
        await addLog((a[1] as string) || actor, "Updated notification settings");
        return ok({ success: true });
      }
      case "serverTestLine": {
        // ส่งข้อความทดสอบไปยัง Target ที่ตั้งไว้ แล้วคืนผลจริงจาก LINE API ให้เห็นสาเหตุที่ล้มเหลว
        const { data: s } = await db.from("settings").select("line_channel_token, line_target_id").eq("id", 1).single();
        if (!s?.line_channel_token) return ok({ success: false, error: "ยังไม่ได้ตั้งค่า LINE Channel Access Token" });
        const r = await sendLine(s.line_channel_token, s.line_target_id ?? "",
          `🔔 ข้อความทดสอบจาก ServiceMS\nโดย: ${(a[0] as string) || actor}\nเวลา: ${bkk()}\nหากเห็นข้อความนี้ในกลุ่ม แปลว่าการแจ้งเตือนพร้อมใช้งานค่ะ`);
        await addLog((a[0] as string) || actor, `Tested LINE notification (${r.mode}) → ${r.ok ? "OK" : "FAIL " + r.status}`);
        if (r.ok) return ok({ success: true, mode: r.mode, target: (s.line_target_id ?? "").trim() });
        // แปลสาเหตุที่พบบ่อยให้อ่านง่าย
        let hint = r.detail;
        if (r.status === 400 && /members|not.*found|invalid.*to/i.test(r.detail)) hint = "Bot ยังไม่ได้อยู่ในกลุ่มนี้ (เชิญ Bot เข้ากลุ่มก่อน) หรือ Target ID ไม่ถูกต้อง";
        else if (r.status === 401 || r.status === 403) hint = "Channel Access Token ไม่ถูกต้องหรือหมดอายุ — ออก token ใหม่";
        else if (r.status === 429) hint = "ส่งเกินโควตาข้อความของ LINE เดือนนี้แล้ว";
        return ok({ success: false, mode: r.mode, status: r.status, error: hint || `HTTP ${r.status}` });
      }

      case "serverUpdatePassword": {
        const [user, pw] = a as [string, string];
        // Only a manager may change someone else's password; others = self only.
        if (sess.role !== "manager" && user !== sess.username) return err("FORBIDDEN");
        if (!pw || String(pw).length < 6) return err("รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร");
        const { data, error } = await db.rpc("set_password", { p_username: user, p_password: pw });
        if (error) return err(error.message);
        await addLog((a[2] as string) || actor, `Changed password for ${user}`);
        return ok({ success: !!data });
      }

      case "serverGetUsers": {
        const { data, error } = await db.from("users")
          .select("username, role, name, active, last_login_at, created_at").order("username");
        if (error) return err(error.message);
        return ok(data ?? []);
      }
      // ── USER MANAGEMENT (manager only) ───────────────────────────────────
      case "serverCreateUser": {
        const d = (a[0] as Record<string, string>) ?? {};
        const username = (d.username ?? "").trim();
        const role = d.role ?? "";
        if (!username) return err("กรุณาระบุ Username");
        if (!["manager", "section", "project"].includes(role)) return err("Role ไม่ถูกต้อง");
        if (!d.password || d.password.length < 6) return err("รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร");
        const { data: created, error } = await db.rpc("create_user",
          { p_username: username, p_password: d.password, p_role: role, p_name: d.name ?? "" });
        if (error) return err(error.message);
        if (created === false) return err(`Username "${username}" มีอยู่แล้ว`);
        await addLog((a[1] as string) || actor, `Created user ${username} (${role})`);
        return ok({ success: true });
      }
      case "serverUpdateUser": {
        // แก้ชื่อ / role — กันไม่ให้ลด manager คนสุดท้ายจนล็อกระบบ
        const [username, d, user] = a as [string, Record<string, string>, string];
        const uname = (username ?? "").trim();
        const { data: cur } = await db.from("users").select("username, role").eq("username", uname).single();
        if (!cur) return err("ไม่พบผู้ใช้");
        const patch: Record<string, unknown> = {};
        if (typeof d.name === "string") patch.name = d.name;
        if (typeof d.role === "string" && d.role !== cur.role) {
          if (!["manager", "section", "project"].includes(d.role)) return err("Role ไม่ถูกต้อง");
          if (cur.role === "manager" && d.role !== "manager" && (await otherActiveManagers(uname)) < 1)
            return err("ต้องมี Manager ที่ใช้งานได้อย่างน้อย 1 คน — เปลี่ยน role ของ Manager คนสุดท้ายไม่ได้");
          patch.role = d.role;
          // เปลี่ยน role → sync session ที่ค้างให้ตรง (หรือเตะออกให้ล็อกอินใหม่)
          await db.from("sessions").delete().eq("username", uname);
        }
        if (!Object.keys(patch).length) return ok({ success: true });
        const { error } = await db.from("users").update(patch).eq("username", uname);
        if (error) return err(error.message);
        await addLog(user || actor, `Updated user ${uname}${patch.role ? ` → role ${patch.role}` : ""}`);
        return ok({ success: true });
      }
      case "serverSetUserActive": {
        const [username, active, user] = a as [string, boolean, string];
        const uname = (username ?? "").trim();
        if (!active && uname === sess.username) return err("ปิดบัญชีตัวเองไม่ได้");
        const { data: cur } = await db.from("users").select("role").eq("username", uname).single();
        if (!cur) return err("ไม่พบผู้ใช้");
        if (!active && cur.role === "manager" && (await otherActiveManagers(uname)) < 1)
          return err("ต้องมี Manager ที่ใช้งานได้อย่างน้อย 1 คน — ปิดบัญชี Manager คนสุดท้ายไม่ได้");
        const { error } = await db.from("users").update({ active }).eq("username", uname);
        if (error) return err(error.message);
        if (!active) await db.from("sessions").delete().eq("username", uname); // เตะ session ทันที
        await addLog(user || actor, `${active ? "Activated" : "Deactivated"} user ${uname}`);
        return ok({ success: true });
      }
      case "serverDeleteUser": {
        const [username, user] = a as [string, string];
        const uname = (username ?? "").trim();
        if (uname === sess.username) return err("ลบบัญชีตัวเองไม่ได้");
        const { data: cur } = await db.from("users").select("role").eq("username", uname).single();
        if (!cur) return err("ไม่พบผู้ใช้");
        if (cur.role === "manager" && (await otherActiveManagers(uname)) < 1)
          return err("ต้องมี Manager ที่ใช้งานได้อย่างน้อย 1 คน — ลบ Manager คนสุดท้ายไม่ได้");
        await db.from("sessions").delete().eq("username", uname);
        const { error } = await db.from("users").delete().eq("username", uname);
        if (error) return err(error.message);
        await addLog(user || actor, `Deleted user ${uname}`);
        return ok({ success: true });
      }
      case "serverCheckLineQuota": {
        const { data: s } = await db.from("settings").select("line_channel_token").eq("id", 1).single();
        if (!s?.line_channel_token) return ok({ success: false, error: "ยังไม่ได้ตั้งค่า LINE Channel Access Token" });
        const q = await lineQuota(s.line_channel_token);
        if (!q) return ok({ success: false, error: "ดึงข้อมูลโควตาไม่สำเร็จ (ตรวจ Token)" });
        return ok({ success: true, ...q });
      }
      // ── LINE approval: ผูกบัญชี LINE ส่วนตัว + ตั้ง PIN (section/manager) ──
      case "serverGetMyLineLink": {
        const { data } = await db.from("users").select("line_user_id, approve_pin_hash").eq("username", actor).single();
        return ok({ linked: !!data?.line_user_id, hasPin: !!data?.approve_pin_hash });
      }
      case "serverGenLinkCode": {
        // สุ่มรหัส 6 หลัก อายุ 10 นาที เก็บบน users row ของผู้ขอ
        const code = String(Math.floor(100000 + Math.random() * 900000));
        const expires = new Date(Date.now() + 10 * 60_000).toISOString();
        await db.from("users").update({ link_code: code, link_code_expires: expires }).eq("username", actor);
        await addLog(actor, "Generated LINE link code");
        return ok({ success: true, code, expiresMin: 10 });
      }
      case "serverUnlinkLine": {
        await db.from("users").update({ line_user_id: null }).eq("username", actor);
        await addLog(actor, "Unlinked LINE account");
        return ok({ success: true });
      }
      case "serverSetApprovePin": {
        const pin = String((a[0] as string) ?? "").trim();
        if (!/^\d{4,6}$/.test(pin)) return err("PIN ต้องเป็นตัวเลข 4-6 หลัก");
        const { data, error } = await db.rpc("set_approve_pin", { p_username: actor, p_pin: pin });
        if (error) return err(error.message);
        await addLog(actor, "Set approval PIN");
        return ok({ success: !!data });
      }

      case "serverResetSheets": {
        const sheets = (a[0] as string[]) ?? [];
        let cleared = 0;
        for (const s of sheets) {
          const t = TBL[s];                       // Users & Settings are never exposed to this action
          if (!t) continue;
          const keyCol = t === "team" ? "psp_id" : "id";
          const { count } = await db.from(t).select("*", { count: "exact", head: true });
          await db.from(t).delete().not(keyCol, "is", null);
          cleared += count ?? 0;
        }
        await addLog((a[1] as string) || actor, `Reset data: ${sheets.join(", ")}`);
        return ok({ success: true, totalCleared: cleared });
      }

      // ── CREATE ─────────────────────────────────────────────────────────
      case "serverCreateHandover": {
        const d = { ...(a[0] as Record<string, unknown>), status: "SUBMITTED", repair_count: 0 };
        const { data, error } = await db.from("handovers").insert(d).select("id, job_no").single();
        if (error) return err(error.message);
        await addLog((a[1] as string) || actor, `Created Handover ${data.job_no}`);
        await notify("📋 Handover ใหม่ (SUBMITTED)", `${data.job_no} · ${d.project_name ?? "-"}\nโดย ${(a[1] as string) || actor}`); // กลุ่ม: แจ้งเตือนธรรมดา
        await pushApprovalCard("Handovers", data.id, "Project Handover", data.job_no, String(d.project_name ?? "-"), String((a[1] as string) || actor)); // manager: การ์ดอนุมัติ (ลิงก์+ปุ่ม)
        return ok({ success: true, id: data.id, job_no: data.job_no });
      }
      case "serverCreateLBS": {
        const raw = a[0] as Record<string, unknown>;
        const d = { ...raw, status: "SUBMITTED", assigned_team: normTeam(raw.assigned_team) };
        const isEV = raw.work_category === "EV";
        const { data, error } = await db.from("lbs_works").insert(d).select("id, job_no").single();
        if (error) return err(error.message);
        await addLog((a[1] as string) || actor, `Created ${isEV ? "EV Charger Work" : "LBS Work"} ${data.job_no}`);
        const lbSched = (d.planned_start || d.planned_end) ? `${d.planned_start ? dmyDash(d.planned_start) : "-"} → ${d.planned_end ? dmyDash(d.planned_end) : "-"}` : "ยังไม่ระบุ";
        const createTitle = isEV ? "🔌 EV ใหม่ (SUBMITTED)" : "⚡ LBS ใหม่ (SUBMITTED)";
        await notify(createTitle, `${data.job_no} · ${d.project_name ?? "-"}\n🗓️ ${lbSched} · โดย ${(a[1] as string) || actor}`); // กลุ่ม: แจ้งเตือนธรรมดา
        await pushApprovalCard("LBSWorks", data.id, isEV ? "EV Charger Work" : "LBS & Support Work", data.job_no, String(d.project_name ?? "-"), String((a[1] as string) || actor)); // manager: การ์ดอนุมัติ
        return ok({ success: true, id: data.id, job_no: data.job_no });
      }
      case "serverGetNextSO": return ok(await nextSharedNo(SOSR_SOURCES, "SO"));
      case "serverGetNextSR": return ok(await nextSharedNo(SOSR_SOURCES, "SR"));
      case "serverGetNextLetter": return ok(await nextSharedNo(LETTER_SOURCES, LETTER_PREFIX));
      case "serverGetNextSM": return ok(await nextSharedNo(LETTER_SOURCES, LETTER_PREFIX));
      case "serverGetNextWarranty": return ok(await nextSharedNo(LETTER_SOURCES, LETTER_PREFIX));
      case "serverCreateLetter": {
        const raw = a[0] as Record<string, unknown>;
        const { no: letter_no, row } = await insertSharedNumbered("letters", LETTER_SOURCES, LETTER_PREFIX,
          (no) => ({ ...raw, letter_no: no, status: (raw.status as string) || "ISSUED" }));
        await addLog((a[1] as string) || actor, `Issued Letter ${letter_no}`);
        await notify("📄 ออกจดหมาย", `${letter_no} — ${raw.subject ?? ""}`, false);
        return ok({ success: true, id: (row as { id?: string }).id, letter_no });
      }

      case "serverCreateSO": {
        const raw = a[0] as Record<string, unknown>;
        // Validate the referenced Handover exists and is APPROVED/COMPLETED.
        if (!raw.ref_job_no) return err("ต้องระบุ Ref Job (Handover) ก่อนสร้าง S.O.");
        const { data: hv } = await db.from("handovers").select("id, repair_count, status").eq("job_no", raw.ref_job_no);
        const handover = (hv ?? []).find((h: { status?: string }) => h.status === "APPROVED" || h.status === "COMPLETED");
        if (!handover) return err("Handover ที่อ้างถึงต้องมีสถานะ APPROVED หรือ COMPLETED");
        const { no: so_no } = await insertSharedNumbered("service_orders", SOSR_SOURCES, "SO",
          (no) => ({ ...raw, so_no: no, status: raw.status || "PENDING", assigned_team: normTeam(raw.assigned_team) }));
        // bump repair_count on the validated handover (drives Top-3 ranking)
        await db.from("handovers").update({ repair_count: (handover.repair_count ?? 0) + 1 }).eq("id", handover.id);
        await addLog((a[1] as string) || actor, `Created Service Order ${so_no}`);
        await notify("🔧 S.O. ใหม่", `${so_no} · ${raw.description ?? "-"}`);
        return ok({ success: true, so_no });
      }
      case "serverCreateSR": {
        const raw = a[0] as Record<string, unknown>;
        const { no: sr_no, row } = await insertSharedNumbered("service_reports", SOSR_SOURCES, "SR",
          (no) => ({ ...raw, sr_no: no, status: raw.status || "IN_PROGRESS" }));
        // Note: S.O. status is owned by the Repair Request (manual Done) — S.R. never changes it.
        await addLog((a[1] as string) || actor, `Created Service Report ${sr_no}`);
        await notify("📝 S.R. ใหม่", `${sr_no} · รวม ฿${raw.cost_total ?? 0}`, false);
        return ok({ success: true, sr_no, id: (row as { id?: string }).id });
      }
      case "serverCompleteSR": {
        const [id, payload, user] = a as [string, Record<string, any>, string];
        const before: string[] = [], after: string[] = [], files: string[] = [];
        for (const p of (payload.before ?? [])) before.push(await uploadOne(`ServiceReports/${id}/before`, p.name, p.b64, p.mime));
        for (const p of (payload.after ?? []))  after.push(await uploadOne(`ServiceReports/${id}/after`, p.name, p.b64, p.mime));
        for (const f of (payload.pdfs ?? []))   files.push(`${f.name}::` + await uploadOne(`ServiceReports/${id}/files`, f.name, f.b64, f.mime));
        let sigT = "", sigC = "";
        const st = dataUrlParts(payload.sig_tech); if (st) sigT = await uploadOne(`ServiceReports/${id}/sig`, "technician.png", st.b64, st.mime);
        const sc = dataUrlParts(payload.sig_cust); if (sc) sigC = await uploadOne(`ServiceReports/${id}/sig`, "customer.png", sc.b64, sc.mime);
        const { data: cur } = await db.from("service_reports").select("before_photos, after_photos, attachment_files, ref_so").eq("id", id).single();
        const join = (ex: string, arr: string[]) => [ex, ...arr].filter(Boolean).join("||");
        const patch: Record<string, unknown> = { status: "DONE", repair_details: payload.repair_details ?? "" };
        if (before.length) patch.before_photos = join(cur?.before_photos ?? "", before);
        if (after.length)  patch.after_photos  = join(cur?.after_photos ?? "", after);
        if (files.length)  patch.attachment_files = join(cur?.attachment_files ?? "", files);
        if (sigT) patch.sig_technician = sigT;
        if (sigC) patch.sig_customer = sigC;
        await db.from("service_reports").update(patch).eq("id", id);
        await addLog(user || actor, `Completed Service Report ${id}`);
        await notify("✅ S.R. เสร็จ", `บันทึก DONE โดย ${user || actor}`, false);
        return ok({ success: true });
      }

      // ── WORKFLOW ─────────────────────────────────────────────────────────
      case "serverApprove": {
        const [sheet, id, user] = a as [string, string, string];
        const res = await doApprove(sheet, id, user || actor, sess.role);
        if (!res.ok) return err(res.error ?? "Approve failed");
        return ok({ success: true });
      }
      case "serverReturn": {
        const [sheet, id, comments, user] = a as [string, string, string, string];
        const res = await doReturn(sheet, id, comments, user || actor);
        if (!res.ok) return err(res.error ?? "Return failed");
        return ok({ success: true });
      }
      case "serverCompleteHandover": {
        const [id, user, issue] = a as [string, string, IssuePayload | null];
        const iss = await buildIssuePatch("Handovers", id, issue);
        if (iss.error) return err(iss.error);
        await db.from("handovers").update({ status: "COMPLETED", ...iss.patch }).eq("id", id);
        const { data: hC } = await db.from("handovers").select("job_no, project_name, project_manager").eq("id", id).single();
        await addLog(user || actor, `Completed Handover ${hC?.job_no ?? id}${iss.has ? " · พบปัญหา" : ""}`);
        // รายละเอียดปัญหาไม่ส่งเข้า LINE — ดูในเว็บ (หน้า detail) และในไฟล์ PDF เท่านั้น
        await notify("✅ Handover เสร็จ (COMPLETED)", `${hC?.job_no ?? id} · ${hC?.project_name ?? "-"}\nโดย ${user || actor}`);
        return ok({ success: true });
      }
      case "serverCompleteLBS": {
        const [id, user, issue] = a as [string, string, IssuePayload | null];
        const { data: lbCur } = await db.from("lbs_works").select("status").eq("id", id).single();
        if (!lbCur) return err("Record not found");
        if (lbCur.status !== "ASSIGNED") return err("ต้องมอบหมายทีม (ASSIGNED) ก่อนจึงปิดงาน LBS ได้");
        const iss = await buildIssuePatch("LBSWorks", id, issue);
        if (iss.error) return err(iss.error);
        await db.from("lbs_works").update({ status: "COMPLETED", ...iss.patch }).eq("id", id);
        const { data: lC } = await db.from("lbs_works").select("job_no, project_name, work_category").eq("id", id).single();
        const lbl = lC?.work_category === "EV" ? "EV" : "LBS";
        await addLog(user || actor, `Completed ${lbl} ${lC?.job_no ?? id}${iss.has ? " · พบปัญหา" : ""}`);
        // รายละเอียดปัญหาไม่ส่งเข้า LINE — ดูในเว็บ (หน้า detail) และในไฟล์ PDF เท่านั้น
        await notify(`✅ ${lbl} เสร็จ (COMPLETED)`, `${lC?.job_no ?? id} · ${lC?.project_name ?? "-"}\nโดย ${user || actor}`);
        return ok({ success: true });
      }
      case "serverAssignTeam": {
        const [soId, teamArr, user] = a as [string, string[], string];
        await db.from("service_orders").update({ assigned_team: normTeam(teamArr), status: "IN_PROGRESS" }).eq("id", soId);
        await addLog(user || actor, `Assigned team to S.O. ${soId}`);
        const { data: soR } = await db.from("service_orders").select("so_no, description, planned_start, planned_finish, ref_job_no").eq("id", soId).single();
        const soNames = await teamNames(teamArr);
        await notify("🔧 มอบหมายซ่อม (ASSIGNED)", `${soR?.so_no ?? soId} · ${soR?.ref_job_no ?? "-"}\n👷 ${soNames}\n🗓️ ${soR?.planned_start ? dmyDash(soR.planned_start) : "-"} → ${soR?.planned_finish ? dmyDash(soR.planned_finish) : "-"}`);
        // ความคืบหน้าหาลูกค้า (เฉพาะงานซ่อมที่แจ้งผ่าน LINE)
        await linePushRepairProgress(soR?.so_no ?? "", `🔧 อัปเดตงานซ่อมของท่านค่ะ\n\nเลขที่ใบสั่งงาน: ${soR?.so_no ?? "-"}\nทีมช่างผู้รับผิดชอบ: ${soNames}\nกำหนดเข้าดำเนินการ: ${soR?.planned_start ? dmyDash(soR.planned_start) : "รอนัดหมาย"}${soR?.planned_finish ? " ถึง " + dmyDash(soR.planned_finish) : ""}\n\nทีมช่างจะเข้าดำเนินการตามกำหนดค่ะ 🙏`);
        return ok({ success: true });
      }
      case "serverAssignLBS": {
        const [lbsId, teamArr, start, end, user] = a as [string, string[], string, string, string];
        await db.from("lbs_works").update({
          assigned_team: normTeam(teamArr), planned_start: start || "", planned_end: end || "", status: "ASSIGNED",
        }).eq("id", lbsId);
        await addLog(user || actor, `Assigned team to LBS ${lbsId}`);
        const { data: lbR } = await db.from("lbs_works").select("job_no, project_name, project_manager").eq("id", lbsId).single();
        const lbNames = await teamNames(teamArr);
        await notify("⚡ มอบหมาย LBS (ASSIGNED)", `${lbR?.job_no ?? lbsId} · ${lbR?.project_name ?? "-"}\n👷 ${lbNames}\n🗓️ ${start ? dmyDash(start) : "-"} → ${end ? dmyDash(end) : "-"}`);
        return ok({ success: true });
      }
      case "serverAddTeamMember": {
        const d = a[0] as Record<string, any>;
        const palette = ["#2d7ff9", "#28a745", "#f5920b", "#7c3aed", "#0891b2", "#e53e3e"];
        const { count } = await db.from("team").select("*", { count: "exact", head: true });
        let photoUrl = "";
        if (d.photo && d.photo.b64) photoUrl = await uploadOne(`Team/${d.psp_id}`, d.photo.name || "photo.jpg", d.photo.b64, d.photo.mime || "image/jpeg");
        const { error } = await db.from("team").insert({
          psp_id: d.psp_id, name: d.name, position: d.position ?? "", phone: d.phone ?? "",
          color: palette[(count ?? 0) % palette.length], active: true, photo: photoUrl,
        });
        if (error) return err(error.message);
        await addLog((a[1] as string) || actor, `Added team member ${d.psp_id}`);
        return ok({ success: true });
      }
      case "serverSetTeamPhoto": {
        const [psp_id, name, b64, mime, user] = a as [string, string, string, string, string];
        const url = await uploadOne(`Team/${psp_id}`, name || "photo.jpg", b64, mime || "image/jpeg");
        await db.from("team").update({ photo: url }).eq("psp_id", psp_id);
        await addLog(user || actor, `Updated photo for ${psp_id}`);
        return ok({ success: true, url });
      }
      case "serverUpdateBudget": {
        const [id, budget, user] = a as [string, number, string];
        await db.from("handovers").update({ warranty_budget: budget }).eq("id", id);
        await addLog(user || actor, `Updated budget ${id} → ฿${budget}`);
        return ok({ success: true });
      }
      case "serverUpdateRecord": {
        const [sheet, id, d, user] = a as [string, string, Record<string, unknown>, string];
        const t = TBL[sheet];
        const patch = { ...d };
        // Immutable keys — editing a running/job number would orphan cross-module links.
        for (const k of ["job_no", "so_no", "sr_no", "letter_no"]) delete (patch as Record<string, unknown>)[k];
        if ("assigned_team" in patch) patch.assigned_team = normTeam(patch.assigned_team);
        // De-assignment guard: ถอย LBS จาก ASSIGNED กลับสถานะก่อนมอบหมาย = ยกเลิกการมอบหมาย
        // → ล้างทีม + วันแผนงาน ให้ Team & Scheduling และ LBS list เคลียร์แผนของบุคคลนั้นสอดคล้องกัน
        let deAssigned = false;
        if (t === "lbs_works" && typeof patch.status === "string"
            && ["SUBMITTED", "RESUBMITTED", "APPROVED", "RETURNED"].includes(patch.status)) {
          const { data: cur } = await db.from("lbs_works").select("status, job_no").eq("id", id).single();
          if (cur?.status === "ASSIGNED") {
            patch.assigned_team = [];
            patch.planned_start = "";
            patch.planned_end = "";
            deAssigned = true;
          }
        }
        const keyCol = t === "team" ? "psp_id" : "id";
        const { error } = await db.from(t).update(patch).eq(keyCol, id);
        if (error) return err(error.message);
        await addLog(user || actor, deAssigned
          ? `Updated ${sheet} ${id} — ยกเลิกมอบหมาย (${patch.status}) ล้างทีม+แผนงาน`
          : `Updated ${sheet} ${id}`);
        if (deAssigned) await notify("↩️ ยกเลิกมอบหมาย LBS", `กลับเป็น ${patch.status} · ล้างทีม/แผนงานแล้ว\nโดย ${user || actor}`, false);
        return ok({ success: true });
      }
      case "serverDelete": {
        const [sheet, id] = a as [string, string];
        const t = TBL[sheet];
        const keyCol = t === "team" ? "psp_id" : "id";
        const { error } = await db.from(t).delete().eq(keyCol, id);
        if (error) return err(error.message);
        return ok({ success: true });
      }

      case "serverResubmit": {
        // Creator edits a RETURNED Handover/LBS (allow-listed fields only) and resubmits.
        const [sheet, id, d, user] = a as [string, string, Record<string, unknown>, string];
        const t = TBL[sheet];
        if (t !== "handovers" && t !== "lbs_works") return err("Bad sheet");
        const { data: cur } = await db.from(t).select("status, job_no").eq("id", id).single();
        if (!cur) return err("Record not found");
        if (cur.status !== "RETURNED") return err("ส่งใหม่ได้เฉพาะรายการที่ถูกตีกลับ (RETURNED) เท่านั้น");
        const EDITABLE: Record<string, string[]> = {
          handovers: ["project_name", "location", "customer_name", "customer_contact", "phone", "email", "handover_date", "warranty_type", "warranty_start", "warranty_end", "warranty_budget", "project_manager", "attachments"],
          lbs_works: ["project_name", "location", "customer_name", "customer_contact", "phone", "email", "work_type", "work_description", "planned_start", "planned_end", "project_manager", "attachments"],
        };
        const patch: Record<string, unknown> = { status: "RESUBMITTED" };
        for (const k of (EDITABLE[t] ?? [])) if (d && k in d) patch[k] = (d as Record<string, unknown>)[k];
        const { error } = await db.from(t).update(patch).eq("id", id);
        if (error) return err(error.message);
        await addLog(user || actor, `Resubmitted ${sheet} ${cur.job_no ?? id}`);
        await notify("🔁 ส่งใหม่ (RESUBMITTED)", `${sheet === "handovers" ? "Handover" : "LBS"} ${cur.job_no ?? id}\nโดย ${user || actor}`); // กลุ่ม: แจ้งเตือนธรรมดา
        await pushApprovalCard(sheet, id, sheet === "handovers" ? "Project Handover" : "LBS & Support Work", String(cur.job_no ?? id), String(patch.project_name ?? "-"), String(user || actor)); // manager: การ์ดอนุมัติ
        return ok({ success: true });
      }

      case "serverAddCheckin": {
        const [kind, ref_no, lat, lng, label, project, status, user] = a as [string, string, number, number, string, string, string, string];
        if (typeof lat !== "number" || typeof lng !== "number") return err("พิกัดไม่ถูกต้อง");
        const { error } = await db.from("checkins").insert({ kind, ref_no, lat, lng, label: label ?? "", project: project ?? "", status: status ?? "", who: user || actor });
        if (error) return err(error.message);
        await addLog(user || actor, `Check-in ${kind} ${ref_no} @ ${lat.toFixed(5)},${lng.toFixed(5)}`);
        return ok({ success: true });
      }
      case "serverPromoteHandover": {
        // When a Warranty letter is issued for an LBS/EV job, mirror it into the
        // Handover list as a real handover record (source = 'LBS' | 'EV').
        const [lbsId, source, user] = a as [string, string, string];
        const { data: w } = await db.from("lbs_works").select("*").eq("id", lbsId).single();
        if (!w) return err("Work not found");
        const src = source === "EV" ? "EV" : "LBS";
        const { data: dup } = await db.from("handovers").select("id").eq("job_no", w.job_no).eq("source", src).limit(1);
        if (dup && dup.length) return ok({ success: true, id: dup[0].id, existed: true });
        const { data: h, error } = await db.from("handovers").insert({
          job_no: w.job_no, project_name: w.project_name, location: w.location,
          customer_name: w.customer_name, customer_contact: w.customer_contact, phone: w.phone, email: w.email,
          project_manager: w.project_manager, status: "COMPLETED", source: src, repair_count: 0,
        }).select("id").single();
        if (error) return err(error.message);
        await addLog(user || actor, `Promoted ${src} ${w.job_no} → Handover`);
        return ok({ success: true, id: h.id });
      }
      case "serverCompleteSO": {
        const [id, user] = a as [string, string];
        const { error } = await db.from("service_orders").update({ status: "DONE" }).eq("id", id);
        if (error) return err(error.message);
        const { data: so } = await db.from("service_orders").select("so_no").eq("id", id).single();
        await addLog(user || actor, `Completed Service Order ${so?.so_no ?? id}`);
        await notify("🔧 S.O. เสร็จ (DONE)", `${so?.so_no ?? id} · โดย ${user || actor}`, false);
        // ความคืบหน้าหาลูกค้า (เฉพาะงานซ่อมที่แจ้งผ่าน LINE)
        await linePushRepairProgress(so?.so_no ?? "", `✅ งานซ่อมของท่านเสร็จสิ้นเรียบร้อยแล้วค่ะ\n\nเลขที่ใบสั่งงาน: ${so?.so_no ?? "-"}\n\nหากพบปัญหาเพิ่มเติม แจ้งได้ทุกเมื่อโดยพิมพ์ "แจ้งซ่อม" ขอบคุณที่ใช้บริการค่ะ 🙏`);
        return ok({ success: true });
      }

      // ── CUSTOMER ENGAGEMENT (LINE Bot) — manager review ──────────────────
      case "serverApproveCustomerRequest": {
        // REGISTER → screen โดย section/manager → handovers (source=CUSTOMER, status=SUBMITTED) → เข้า Job Under Review
        // REPAIR   → manager เท่านั้น → service_orders (status=PENDING) → กล่อง Repair Requests
        const [id, extra, user] = a as [string, Record<string, string> | null, string];
        const { data: cr } = await db.from("customer_requests").select("*").eq("id", id).single();
        if (!cr) return err("Record not found");
        if (cr.status !== "PENDING") return err("รายการนี้ถูกพิจารณาไปแล้ว");
        let resultRef = "";
        if (cr.kind === "REGISTER") {
          // route ตามประเภทงาน: PROJECT → handovers | LBS/EV → lbs_works (work_category)
          const rType = (cr.register_type === "LBS" || cr.register_type === "EV") ? cr.register_type : "PROJECT";
          const destTable = rType === "PROJECT" ? "handovers" : "lbs_works";
          const autoPrefix = rType === "PROJECT" ? "CST" : rType; // CST- / LBS- / EV-
          let job = (extra?.job_no ?? "").trim();
          if (job) {
            const { data: dup } = await db.from(destTable).select("id").eq("job_no", job).limit(1);
            if (dup && dup.length) return err(`Job No. ${job} มีอยู่แล้ว กรุณาใช้เลขอื่น`);
          } else {
            job = await nextNo(destTable, "job_no", autoPrefix);
          }
          const noteParts = [`ลงทะเบียนโดยลูกค้าผ่าน LINE (${cr.line_display_name || cr.line_user_id})`];
          if (cr.contract_no) noteParts.push(`เลขสัญญา: ${cr.contract_no}`);
          if (rType === "PROJECT") {
            const wType = extra?.warranty_type === "PARTIAL_EQUIPMENT" ? "PARTIAL_EQUIPMENT" : "FULL";
            const { error } = await db.from("handovers").insert({
              job_no: job, project_name: cr.project_name, location: cr.location,
              customer_name: cr.customer_name, customer_contact: cr.customer_contact || cr.line_display_name || cr.customer_name,
              phone: cr.phone, email: "", handover_date: (extra?.handover_date ?? "").trim() || today(),
              warranty_type: wType, warranty_start: cr.warranty_start, warranty_end: cr.warranty_end,
              warranty_budget: parseInt(extra?.warranty_budget ?? "0", 10) || 0,
              project_manager: (extra?.project_manager ?? "").trim() || user || actor, status: "SUBMITTED",
              source: "CUSTOMER", attachment_files: cr.attachment_files ?? "", repair_count: 0,
              comments: noteParts.join(" · "),
            });
            if (error) return err(error.message);
          } else {
            // LBS / EV — ตารางนี้ไม่มีคอลัมน์ warranty จึงเก็บช่วงประกันไว้ใน work_description
            const desc = [`ลงทะเบียน Warranty ผ่าน LINE (${REGISTER_TYPES[rType]})`,
              `Warranty: ${cr.warranty_start || "-"} → ${cr.warranty_end || "-"}`, ...noteParts].join("\n");
            const { error } = await db.from("lbs_works").insert({
              job_no: job, project_name: cr.project_name, location: cr.location,
              customer_name: cr.customer_name, customer_contact: cr.customer_contact || cr.line_display_name || cr.customer_name,
              phone: cr.phone, email: "", work_type: "OTHER", work_description: desc,
              status: "SUBMITTED", planned_start: "", planned_end: "",
              project_manager: (extra?.project_manager ?? "").trim() || user || actor,
              attachment_files: cr.attachment_files ?? "", work_category: rType, source: "CUSTOMER",
              assigned_team: [], comments: "",
            });
            if (error) return err(error.message);
          }
          resultRef = job;
          const boxName = rType === "PROJECT" ? "Project Handover" : rType === "EV" ? "EV Charger Work" : "LBS & Support Work";
          // ส่งการ์ดอนุมัติเข้า LINE ส่วนตัว manager (งานลูกค้าอนุมัติขั้นสุดท้ายโดย manager)
          const destTbl = rType === "PROJECT" ? "handovers" : "lbs_works";
          const { data: made } = await db.from(destTbl).select("id").eq("job_no", job).limit(1);
          const madeId = (made ?? [])[0]?.id;
          if (madeId) await pushApprovalCard(rType === "PROJECT" ? "Handovers" : "LBSWorks", madeId, boxName, job, String(cr.project_name ?? "-"), `ลูกค้า ${cr.customer_name ?? "-"}`);
          await addLog(user || actor, `Screened Customer Register (${rType}) → ${job} (SUBMITTED)`);
          await notify("📥 ส่งเข้าพิจารณา (SUBMITTED)", `${REGISTER_TYPES[rType]} ${job} · ${cr.project_name ?? "-"}\nตรวจโดย ${user || actor} → กล่อง ${boxName}`); // กลุ่ม: แจ้งเตือนธรรมดา
          await linePushToCustomer(cr.line_user_id, `📋 ข้อมูลลงทะเบียนรับประกันของท่านผ่านการตรวจสอบเบื้องต้นแล้วค่ะ\n\nประเภทงาน: ${REGISTER_TYPES[rType]}\nโครงการ: ${cr.project_name ?? "-"}\nขณะนี้อยู่ระหว่างรออนุมัติ จะแจ้งเลขงาน (Job No.) ให้ทราบทันทีที่อนุมัติค่ะ 🙏`);
        } else {
          // REPAIR = การอนุมัติขั้นสุดท้าย → เฉพาะ manager
          if (sess.role !== "manager") return err("FORBIDDEN");
          // REPAIR — ต้องอ้างอิง Handover ที่ APPROVED/COMPLETED (เหมือน serverCreateSO)
          const ref = (extra?.ref_job_no || cr.ref_job_no || "").trim();
          if (!ref) return err("กรุณาเลือก Ref Job (Handover) ก่อนอนุมัติแจ้งซ่อม");
          const { data: hv } = await db.from("handovers").select("id, repair_count, status").eq("job_no", ref);
          const handover = (hv ?? []).find((h: { status?: string }) => h.status === "APPROVED" || h.status === "COMPLETED");
          if (!handover) return err("Handover ที่อ้างถึงต้องมีสถานะ APPROVED หรือ COMPLETED");
          const photos = (cr.attachment_files ?? "").split("||").filter(Boolean)
            .map((it: string) => it.split("::")[1] || it).join("||");
          const desc = `[แจ้งซ่อมโดยลูกค้าผ่าน LINE] ${cr.detail ?? ""}\nผู้แจ้ง: ${cr.customer_name ?? "-"} โทร: ${cr.phone ?? "-"}`;
          const { no: so_no } = await insertSharedNumbered("service_orders", SOSR_SOURCES, "SO", (no) => ({
            so_no: no, ref_job_no: ref, request_date: today(),
            planned_start: extra?.planned_start ?? "", planned_finish: extra?.planned_finish ?? "",
            status: "PENDING", description: desc, assigned_team: [], before_photos: photos,
          }));
          await db.from("handovers").update({ repair_count: (handover.repair_count ?? 0) + 1 }).eq("id", handover.id);
          resultRef = so_no;
          await addLog(user || actor, `Approved Customer Repair Request → S.O. ${so_no}`);
          await notify("✅ อนุมัติแจ้งซ่อมลูกค้า", `S.O. ${so_no} · Ref ${ref}\nผู้แจ้ง ${cr.customer_name ?? "-"} · โดย ${user || actor}`);
          await linePushToCustomer(cr.line_user_id, `✅ การแจ้งซ่อมของท่านได้รับการอนุมัติแล้วค่ะ\n\nเลขที่ใบสั่งงาน: ${so_no}\nโครงการอ้างอิง: ${ref}\n\nทีมช่างจะติดต่อนัดหมายเข้าดำเนินการค่ะ 🙏`);
          await db.from("customer_requests").update({ ref_job_no: ref }).eq("id", id);
        }
        // REGISTER = ผ่านชั้น screen → FORWARDED (รออนุมัติขั้นสุดท้ายใน Job Under Review จึงเป็น APPROVED)
        // REPAIR   = อนุมัติจบในชั้นเดียว → APPROVED ทันที
        await db.from("customer_requests").update({
          status: cr.kind === "REGISTER" ? "FORWARDED" : "APPROVED", reviewed_by: user || actor,
          reviewed_at: new Date().toISOString(), result_ref: resultRef,
        }).eq("id", id);
        return ok({ success: true, result_ref: resultRef });
      }
      case "serverRejectCustomerRequest": {
        const [id, reason, user] = a as [string, string, string];
        const { data: cr } = await db.from("customer_requests").select("*").eq("id", id).single();
        if (!cr) return err("Record not found");
        if (cr.status !== "PENDING") return err("รายการนี้ถูกพิจารณาไปแล้ว");
        await db.from("customer_requests").update({
          status: "REJECTED", reject_reason: reason ?? "", reviewed_by: user || actor,
          reviewed_at: new Date().toISOString(),
        }).eq("id", id);
        const isReg = cr.kind === "REGISTER";
        await addLog(user || actor, `Rejected Customer ${isReg ? "Register" : "Repair Request"} (${cr.customer_name || cr.line_display_name || id})`);
        await notify(`❌ ปฏิเสธ${isReg ? "ลงทะเบียน" : "แจ้งซ่อม"}ลูกค้า`, `${cr.customer_name ?? "-"} · เหตุผล: ${reason ?? "-"}\nโดย ${user || actor}`);
        await linePushToCustomer(cr.line_user_id, `❌ ขออภัยค่ะ ${isReg ? "การลงทะเบียนรับประกัน" : "การแจ้งซ่อม"}ของท่านไม่ผ่านการพิจารณา\n\nเหตุผล: ${reason || "-"}\n\nท่านสามารถส่งข้อมูลใหม่อีกครั้ง โดยพิมพ์ "${isReg ? "ลงทะเบียน" : "แจ้งซ่อม"}" ค่ะ 🙏`);
        return ok({ success: true });
      }

      // ── ATTACHMENTS → Supabase Storage ───────────────────────────────────
      case "serverUploadAttachment": {
        const [name, b64, mime, sheet, id] = a as [string, string, string, string, string];
        const t = TBL[sheet];
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const path = `${sheet}/${id}/${Date.now()}_${name.replace(/[^\w.\-]/g, "_")}`;
        const up = await db.storage.from("attachments").upload(path, bytes, { contentType: mime || "application/octet-stream", upsert: true });
        if (up.error) return err(up.error.message);
        const { data: pub } = db.storage.from("attachments").getPublicUrl(path);
        const url = pub.publicUrl;
        const { data: rec } = await db.from(t).select("attachment_files").eq("id", id).single();
        const existing = rec?.attachment_files ?? "";
        const merged = (existing ? existing + "||" : "") + `${name}::${url}`;
        await db.from(t).update({ attachment_files: merged }).eq("id", id);
        return ok({ success: true, url });
      }

      // ── PDF (server builds HTML; frontend prints it) ─────────────────────
      case "serverGeneratePDF": {
        const [type, id] = a as [string, string];
        const html = await buildPdf(type, id);
        if (!html) return err("Record not found");
        return ok({ success: true, html });
      }

      default:
        return err(`Unknown action: ${fn}`);
    }
  } catch (e) {
    return err(String((e as Error).message ?? e));
  }
});

// ── PDF templates (redesigned) ───────────────────────────────────────────────
const LOGO = "data:image/jpeg;base64,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";
const e = (s: unknown) => String(s ?? "—").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const thb = (n: unknown) => "฿" + Number(n ?? 0).toLocaleString("en-US");
const dmy = (s: unknown) => { const m = String(s ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : e(s); };
const dmyDash = (s: unknown) => { const m = String(s ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : e(s); };
const PRECISE_LOGO = "data:image/png;base64,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";
const SIG_DEFAULT = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAB7AXwDASIAAhEBAxEB/8QAHAABAAICAwEAAAAAAAAAAAAAAAYHAwQBBQgC/8QAPBAAAQMEAQIDBQYDBgcAAAAAAAECAwQFBhEHEiETMUEIMlFhgRQVImJxkSNyoRYXQlKCohgzQ3OSseH/xAAYAQEBAQEBAAAAAAAAAAAAAAAAAQMCBP/EADARAQACAQEEBgkFAAAAAAAAAAABAhEDEiExoQQTYZGx0QUUIjJBUXGB8CMzweHx/9oADAMBAAIRAxEAPwD2WAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA6uvv9rob5QWSeod94V6PdBCyJz16Wptz3K1FRjfTqcqIqqiJtV0doAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfMUkcrEfG9r2rtNtXadl0p9AACus85r42w2RaW55HT1Vw6ultBb0+01Lnf5ehm+lf5lQ6pS15xWMixSPZ1m2LYPZ5LrlF6pLbTsarmpK/+JJ8mMT8T1+SIpV8WSc2ckUzkxjHqfjuzSqiJcr21Za97FRfxR06Jpq909/6KSDj/hDFcbuv9or1NWZdk716n3a9P8Z7XbVf4TF22NO/bW1T4mnV1p78/aPPh4o44svuZ5/fK3J7xZvuPDFjY2y26up0Wrqntcj0q5N/8tPLpb9fRFW0gDO9tqcxGFAAcgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2ABHcwzrD8QgWXJsltdqT0bUVDWvd69me8v0QrxfaDsV0kSHB8RzDMJHqrWS0FscynVdessmkRPmaV0r2jMRuFyjaFLT5T7Qd8kVLFxtj2NwKv4ZL7dvGeqfyQb1/9PiLDfaCu0rXXvlWxWaLe3Q2ez+J279kfJ0r23/RDrqYj3rRHPwyLs2h8ySMjYr5HoxqeauXSFPycN5RW0yw3Xm7PZkc3pf8AZZIaffbXo1V/qYo/ZtwOZiJe7rl9/cie9cb7M700vZnT5jY0o425f4LXqL5Zqbf2i7UEOk2vXUsb/wC1OrrM9wejV7avMcegdHrra+5Qord+W06iEUfs38LUzEamE08zkTXVPWVEir+8h1mU4h7NeDRq7IrJhlveiKqRVLGySu18GKquX9jqtNO04rmZ/PqLGTkXAFY1/wDbfGul3kv3pD3/ANxyzO8Cr4VjZmGOzxyorFb95Qr1IqeWuoo7p46yTScd+znFkKPZqOvrLRDbqHy7L4kqIrkTtvSb+GzN/wAOlRk8EbchoMJxKDsslPjNoR87vii1E3u/6Wm9ej6MT+pOzznugys2y5FhnH2MyRV+V49DaVq5XWyGia1jYYFXbIWsjVyvVvfbkTvvyI1WcxZVku4eKuNbtfGK5Wpdbpqioey91arlR0ifpoy2f2YuGbfSMhlxia4StXbqiquE6yP/AF6Xtb+yIbE/s68a9THUMF+tvQi9KUl9qmon6beuvoStui1ieMz28O6JjxHUf3Uci5wrZ+U+SKunpHd1smN7pqdv5XyqnU/6p9Sw+PuMcDwOFGYtjdDQy606p6fEqH/rK/bvpvRDo+BqShl8Wxcmck2lyLtGRXzxY/ltsjF2n6kUz685ZxExXv5vobzVeA6eGx5BbWvmqUavkySDT0VfJFVNfsupG10i0adLcfhjHhlMPRoKTg9oChu9noIcQxS75Pk1TSxSz2ugbuKike3asmqFTob0+v8AXRFc3zvkCnuDbTlWd2LDLrVUz56ax2aH7ZUr5Ixsk6td4aqq9ulrldpdeRdP0fq2vsW9me3yjM/wZh6WBR/DWa2LD8TuFpzrlN95vFCq1tbPdIZqZaeN6IjY2eM1HvbtF16qruyImkN1/LWTZjT9HEuDV10jkXTL1eWrRW9v5mov8SVPJfwoZ36JqVtMY3R8Z3RzMrjVUTzITk3LXG2Nz+BecztFPN6xMm8V7U+Lms6lRO3mvYitNxLk+RyLVcm8jXm6NemnWqyyOt1AierXIxeuRNfFU8yf4rhGIYra323HsctlupXpqSOGnani/wA6r3d5f4lU42dGvGZn6bo5+QkEb2yMa9jkc1ybRU9UOSjeQOacvxmvyKWm4ykrbHjNYyG6XBLoxq+E9GOY+OPp6lXoe1V9G789dyeZZyrgeLWCnvN8yClpYqmBk8EHUjqiVrm7b0xpty7L6rq4iYrnPy3mYTY+ZZI4o3SSPaxjU25zl0iJ81KQj5H5Zzl0jOOuPGWe1vVWw3vJpHQte3aoj2U6J1rvsqeafEyUfBNVkdUlx5azi8ZdMq9X3dDI6jt0f5UjYu3J89pv1QdRWn7lsdkb58uZlJcg5swC2Xb7loLjU5Hed6S3WKmdWzfPfR+Fuvm5CY4ZkFLlOL0GQUdLW0sFdF4rIayBYpmd1TTmr5LtP0XzTaKQ/FbvimLcif3WWDC6yzNbQfbYqunt6R0UyJ7yJIndzk21FVd9115+djnGpNMYrHMAAZKAAAAAAAAAAAAAAAAAAAAABDuSOT8F46ZSrmGQQW19X1eBErHySPRPNUaxFXXpte2yYnm/kzF4Wc4VeV8l4Hc8wxxIYYrHUW+ndVR0DU0sjainZ+J34lc5F05O69lVe2ulpdZMxE/2JlHyRn+XW97uPeN6qBkr9U91yOdlNSLGvuytjYrpJEXzRE15p39DWbxTyHkbnvzzmC8rDJ2fQY9C2ghRv+Xr7ucnz0im3B7QfE9LTMjmuldbEY1Gtgns9TGrETsidKR9kTX0Mqe0JxhM5GW+6XS5PVNoyjstXKv6do/M9GzrUj2aY7cb+/ywN7EuDeMccqkrocZguNx6upa26vdWTq749Um0Rf0RCx442RsaxjUaxqaRqJpET4aKuXmKWrj1YuMORLlKvu+JZ/ska/q+ZzUQwJfueL49W27BsYxWFfKW83V1XIjf+3Tprq+SuMZ0rzObz3z+SLa7IaV3u1rtFKtVdrjR0ECf9SpmbE393KhWjOO+SLyjlyvmG6wxye9S49QQ0LGJ6okjkfIv69lObX7PnGNPUtq7paazIqpF3416r5atVXe9q1zuj/aTY0442z9I88eCMtz5+4xp65bfbr1PkFd0qqU9lo5Kx6qi60isTW/qaU2Z8yZE9zcT4zpbHRv22OuyauSOTv5OWnj29NfBVLRs1mtFlpUpLPa6K3U6eUVJA2Jn7NREN4vWadfdr37/ACFUU/GmaX2lazPuUbvVxuXqlorHE23Qr+VZG7lc36t2SDEOJOOMUqUq7LiNsirEVF+1zRrPPv4+JIrnb+eybg5trXtuzu7N3guDRA+U87veIz0NNZeP8hymSra5Vlt0SOigVOyI9fNFXe/RNJ5k8BzS0VtEzGY+QpCDkbmS7MX7q4cr6WT/AArX1kMEfknvdbkd5791PJU9TUpqD2o7xUNllveF4zTqu3R+D9rkanw0jNL/AOX1L60nwB6b9LiYmK6dY+2fGZTDz/nWI880GF1NW3khuTywPbLJa6KzMo56iPqTrZHM1+0XSrpNd9fHRhwvhm65VXrkGfUzLFRzuZN9yUdQ6WpnciLp1XVu29y6XXQxURPl3Q9DAun6Q1tKmxScdsbp/OZh1uN2GzY3aYrTYbZSW2hi9yCmiRjEX1XSear6qvdTZS30CXJbklFTJWrGkS1KRN8VWb309Wt6+WzZB45mZnMqh1fxdx/cM0kzK4Ypbay+ydHVV1EayKqsajWu6XKrUciIidWt9k+BMGta1qNaiIiJpET0OQJtM8QABBD+UsHbnGMzWBt6rLJTVs7FuT6KNniVkCJp0LnOTsippOpO6a13TsdXx9wrx1hFSlbabAyouKLtK+vetTUIv5XP30/6UQsQGka2pFdiLTj5GAAGYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGhoABpAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf//Z";
const LBANNER = "data:image/png;base64,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";
const urls = (s: unknown) => String(s ?? "").split("||").map((x) => x.trim()).filter(Boolean);
const namedUrls = (s: unknown) => urls(s).map((it) => { const p = it.split("::"); return { name: p[0] || "file", url: p[1] || p[0] }; });

function photoGrid(list: string[]): string {
  if (!list.length) return `<div class="empty">— ไม่มีรูปภาพ —</div>`;
  return `<div class="pg">${list.map((u) => `<div class="pi"><img src="${e(u)}"></div>`).join("")}</div>`;
}
function sigBlock(label: string, url: string): string {
  const img = url ? `<img src="${e(url)}" class="sig-img">` : "";
  return `<div class="sigbox">${img}<div class="sigline"></div><div class="siglbl">${label}</div></div>`;
}

function pdfShell(docType: string, docNo: string, accent: string, inner: string, sigs?: string): string {
  return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>${docType} ${docNo}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI','Sarabun','TH Sarabun New',sans-serif}
  body{padding:0;color:#1e293b;font-size:12.5px;line-height:1.5}
  .wrap{padding:26px 30px}
  .topbar{height:6px;background:linear-gradient(90deg,${accent},#1a2744)}
  .hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1a2744;padding:16px 0 12px;margin-bottom:4px}
  .brand{display:flex;align-items:center;gap:12px}
  .logo{width:46px;height:46px;border-radius:11px;background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 4px 10px rgba(26,39,68,.25)}.logo img{width:100%;height:100%;object-fit:contain}
  .brand h1{font-size:19px;color:#1a2744;letter-spacing:-.3px}.brand .co{font-size:10.5px;color:#64748b;margin-top:1px}
  .docbox{text-align:right}
  .docbox .dt{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:${accent};font-weight:800}
  .docbox .dn{font-family:'Courier New',monospace;font-size:16px;font-weight:700;color:#1a2744}
  .docbox .dd{font-size:10px;color:#94a3b8;margin-top:2px}
  .ttl{text-align:center;font-size:15px;font-weight:800;letter-spacing:.5px;color:#1a2744;margin:14px 0 16px}
  .sec{display:flex;align-items:center;gap:8px;font-size:11.5px;font-weight:700;color:#fff;background:linear-gradient(90deg,${accent},#1a2744);padding:6px 12px;border-radius:6px;margin:16px 0 9px}
  table.info{width:100%;border-collapse:collapse;margin-bottom:4px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden}
  table.info td{padding:8px 11px;border:1px solid #e8edf3;font-size:12px;vertical-align:top}
  table.info td.k{background:#f6f8fb;font-weight:600;color:#64748b;width:20%;white-space:nowrap}
  .badge{display:inline-block;padding:3px 12px;border-radius:20px;font-size:10.5px;font-weight:800;letter-spacing:.4px;background:#e7f6ec;color:#15803d}
  .money{font-family:'Courier New',monospace;font-weight:700}
  .cost-tot{font-size:15px;color:#15803d}
  .box{border:1px solid #e2e8f0;border-radius:8px;padding:11px 13px;font-size:12px;line-height:1.7;white-space:pre-wrap;min-height:40px;background:#fcfdfe}
  .pg{display:grid;grid-template-columns:1fr 1fr;gap:9px}
  .pi{border:1px solid #e2e8f0;border-radius:7px;overflow:hidden;height:185px;background:#f8fafc}
  .pi img{width:100%;height:100%;object-fit:cover}
  .empty{font-size:11.5px;color:#94a3b8;font-style:italic;padding:10px;text-align:center;border:1px dashed #e2e8f0;border-radius:7px}
  .files{list-style:none;font-size:12px}.files li{padding:7px 11px;border:1px solid #e8edf3;border-radius:6px;margin-bottom:5px;background:#fcfdfe}
  .sigrow{display:flex;gap:40px;margin-top:34px}
  .sigbox{flex:1;text-align:center;position:relative}
  .sig-img{position:absolute;left:50%;transform:translateX(-50%);bottom:24px;max-height:64px;max-width:80%}
  .sigline{border-top:1px solid #334155;margin:54px 10px 6px}.siglbl{font-size:11px;color:#475569;font-weight:600}
  .foot{margin-top:26px;text-align:center;font-size:9.5px;color:#94a3b8;border-top:1px solid #eef2f7;padding-top:9px}
  @media print{@page{size:A4;margin:0}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.pi{height:165px}.sec{break-after:avoid}.pg,.pi,.sigrow{break-inside:avoid}}
</style></head><body>
<div class="topbar"></div>
<div class="wrap">
  <div class="hdr">
    <div class="brand"><div class="logo"><img src="${LOGO}" alt="ServiceMS"></div><div><h1>ServiceMS</h1><div class="co">PSP102 — Precise System and Project Co., Ltd.</div></div></div>
    <div class="docbox"><div class="dt">${docType}</div><div class="dn">${e(docNo)}</div><div class="dd">Printed: ${bkk()}</div></div>
  </div>
  <div class="ttl">${docType.toUpperCase()}</div>
  ${inner}
  <div class="sigrow">${sigs ?? (sigBlock("ผู้ปฏิบัติงาน / Technician", "") + sigBlock("ลูกค้า/ผู้รับมอบงาน / Customer", ""))}</div>
  <div class="foot">Generated by ServiceMS · ${bkk()} · By Mr.Siradanai Sirisunthorn</div>
</div>
</body></html>`;
}


function smLetter(lt: Record<string, any>): string {
  const sig = (lt.sig_image && String(lt.sig_image).length > 30) ? lt.sig_image : SIG_DEFAULT;
  const techs = String(lt.tech_list ?? "").split("\n").map((ln) => ln.trim()).filter(Boolean).map((ln, i) => {
    const parts = ln.split(/\s*[|,\t]\s*/);
    const nm = e(parts[0] ?? ""); const ph = e(parts[1] ?? "");
    return `<div class="tech"><div class="nm">${i + 1}. ${nm}</div><div class="tph">${ph ? "เบอร์ " + ph : ""}</div></div>`;
  }).join("");
  const recip = e(lt.recipient ?? "").replace(/\n/g, "<br>");
  return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>${e(lt.letter_no)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{margin:0}
  body{font-family:'Sarabun','TH Sarabun New','IBM Plex Sans Thai','Segoe UI',sans-serif;color:#1a2026;font-size:15.5px;line-height:1.85}
  .ph{left:0;right:0;padding:18px 54px 8px;background:#fff}
  .ph .top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
  .ph img.logo{height:52px;object-fit:contain}
  .addr{text-align:right;font-size:11.5px;line-height:1.5}
  .addr b{font-size:12.5px;color:#16233f}
  .pf{left:0;right:0;background:#fff}
  .pf .contact{text-align:center;font-size:12px;color:#16233f;padding:8px 40px 4px;line-height:1.45}
  .pf .contact .en{font-weight:700}
  .pf .banner{display:block;width:100%;height:7mm;object-fit:cover}
  .sheet{width:100%;border-collapse:collapse}
  .sheet>tbody>tr>td{padding:0 54px}
  .hsp{height:0}.fsp{height:0}
  .norow{display:flex;justify-content:space-between;align-items:baseline;margin-top:6px;font-weight:700;color:#c0392b;font-size:16px}
  .recip{margin-top:14px;line-height:1.7}
  .frow{display:flex;gap:10px;margin-top:6px}
  .frow .k{font-weight:700;min-width:62px;flex:0 0 auto}
  .frow .v{flex:1}
  .para{margin-top:14px;text-indent:48px;text-align:justify}
  .techs{margin-top:8px}
  .tech{display:flex;gap:14px;margin:2px 0 2px 48px}
  .tech .nm{min-width:320px}
  .ack{margin-top:16px;text-indent:48px}
  .close{margin-top:14px;text-align:center}
  .close .ty{margin-bottom:2px}
  .close img.sig{height:66px;object-fit:contain;display:block;margin:2px auto}
  .close .signer{font-weight:700}
  @media print{
    @page{size:A4;margin:0}
    body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .ph{position:fixed;top:0}
    .pf{position:fixed;bottom:0}
    thead .hsp{height:34mm}
    tfoot .fsp{height:20mm}
    tr,td{break-inside:avoid}
  }
</style></head><body>
  <div class="ph"><div class="top"><img class="logo" src="${PRECISE_LOGO}"><div class="addr"><b>Precise System and Project Co., Ltd.</b><br>1/333 Moo 9, Chaengwattana Road<br>Bangpood, Pakkred<br>Nonthaburi 1120 Thailand<br>T : +66(0)2 584 2367<br>F : +66(0)2 584 2339</div></div></div>
  <table class="sheet">
    <thead><tr><td><div class="hsp"></div></td></tr></thead>
    <tbody><tr><td>
      <div class="norow"><span class="no">No. ${e(lt.letter_no)}</span><span class="dt">${dmyDash(lt.letter_date)}</span></div>
      <div class="recip">${recip}</div>
      <div class="frow"><div class="k">เรื่อง</div><div class="v">${e(lt.subject)}${lt.site ? "<br>" + e(lt.site) : ""}</div></div>
      <div class="frow"><div class="k">เรียน</div><div class="v">${e(lt.attention)}</div></div>
      ${lt.reference ? `<div class="frow"><div class="k">อ้างถึง</div><div class="v">${e(lt.reference)}</div></div>` : ""}
      <div class="para">${e(lt.body)}</div>
      ${lt.body2 ? `<div class="para">${e(lt.body2)}</div>` : ""}
      <div class="techs">${techs}</div>
      <div class="ack">จึงเรียนมาเพื่อโปรดทราบ</div>
      <div class="close">
        <div class="ty">ขอแสดงความนับถือ</div>
        <img class="sig" src="${sig}">
        <div class="signer">( ${e(lt.signer_name)} )</div>
        <div class="dept">${e(lt.signer_position)}</div>
      </div>
    </td></tr></tbody>
    <tfoot><tr><td><div class="fsp"></div></td></tr></tfoot>
  </table>
  <div class="pf"><div class="contact"><span class="en">Service &amp; Maintenance Section</span>, Precise System and Project Co., Ltd., Email: psp102.service@precise.co.th</div><img class="banner" src="${LBANNER}"></div>
</body></html>`;
}
// Warranty Official Letter — same header/footer shell as the Service letter,
// with a warranty-period / warranty-type block instead of the technician list.
function warrantyLetter(lt: Record<string, any>): string {
  const sig = (lt.sig_image && String(lt.sig_image).length > 30) ? lt.sig_image : SIG_DEFAULT;
  const recip = e(lt.recipient ?? "").replace(/\n/g, "<br>");
  const period = (lt.warranty_start || lt.warranty_end)
    ? `${lt.warranty_start ? dmyDash(lt.warranty_start) : "-"} ถึง ${lt.warranty_end ? dmyDash(lt.warranty_end) : "-"}`
    : "-";
  return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>${e(lt.letter_no)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{margin:0}
  body{font-family:'Sarabun','TH Sarabun New','IBM Plex Sans Thai','Segoe UI',sans-serif;color:#1a2026;font-size:15.5px;line-height:1.85}
  .ph{left:0;right:0;padding:18px 54px 8px;background:#fff}
  .ph .top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
  .ph img.logo{height:52px;object-fit:contain}
  .addr{text-align:right;font-size:11.5px;line-height:1.5}
  .addr b{font-size:12.5px;color:#16233f}
  .pf{left:0;right:0;background:#fff}
  .pf .contact{text-align:center;font-size:12px;color:#16233f;padding:8px 40px 4px;line-height:1.45}
  .pf .contact .en{font-weight:700}
  .pf .banner{display:block;width:100%;height:7mm;object-fit:cover}
  .sheet{width:100%;border-collapse:collapse}
  .sheet>tbody>tr>td{padding:0 54px}
  .hsp{height:0}.fsp{height:0}
  .norow{display:flex;justify-content:space-between;align-items:baseline;margin-top:6px;font-weight:700;color:#1a4d8f;font-size:16px}
  .recip{margin-top:14px;line-height:1.7}
  .frow{display:flex;gap:10px;margin-top:6px}
  .frow .k{font-weight:700;min-width:62px;flex:0 0 auto}
  .frow .v{flex:1}
  .para{margin-top:14px;text-indent:48px;text-align:justify}
  .wbox{margin-top:16px;border:1px solid #d7e0ea;border-radius:8px;padding:12px 16px;background:#f7fafd}
  .wrow{display:flex;gap:10px;margin:3px 0}
  .wrow .wk{font-weight:700;min-width:150px;color:#16233f}
  .wrow .wv{flex:1}
  .wdetail{margin-top:8px;white-space:pre-wrap;text-align:justify;border-top:1px dashed #cbd5e1;padding-top:8px}
  .ack{margin-top:16px;text-indent:48px}
  .close{margin-top:14px;text-align:center}
  .close .ty{margin-bottom:2px}
  .close img.sig{height:66px;object-fit:contain;display:block;margin:2px auto}
  .close .signer{font-weight:700}
  @media print{
    @page{size:A4;margin:0}
    body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .ph{position:fixed;top:0}
    .pf{position:fixed;bottom:0}
    thead .hsp{height:34mm}
    tfoot .fsp{height:20mm}
    tr,td{break-inside:avoid}
  }
</style></head><body>
  <div class="ph"><div class="top"><img class="logo" src="${PRECISE_LOGO}"><div class="addr"><b>Precise System and Project Co., Ltd.</b><br>1/333 Moo 9, Chaengwattana Road<br>Bangpood, Pakkred<br>Nonthaburi 1120 Thailand<br>T : +66(0)2 584 2367<br>F : +66(0)2 584 2339</div></div></div>
  <table class="sheet">
    <thead><tr><td><div class="hsp"></div></td></tr></thead>
    <tbody><tr><td>
      <div class="norow"><span class="no">No. ${e(lt.letter_no)}</span><span class="dt">${dmyDash(lt.letter_date)}</span></div>
      <div class="recip">${recip}</div>
      <div class="frow"><div class="k">เรื่อง</div><div class="v">${e(lt.subject)}${lt.site ? "<br>" + e(lt.site) : ""}</div></div>
      <div class="frow"><div class="k">เรียน</div><div class="v">${e(lt.attention)}</div></div>
      ${lt.reference ? `<div class="frow"><div class="k">อ้างถึง</div><div class="v">${e(lt.reference)}</div></div>` : ""}
      <div class="para">${e(lt.body)}</div>
      ${lt.body2 ? `<div class="para">${e(lt.body2)}</div>` : ""}
      <div class="wbox">
        <div class="wrow"><span class="wk">ประเภทการรับประกัน</span><span class="wv">${e(lt.warranty_type || "-")}</span></div>
        <div class="wrow"><span class="wk">ระยะเวลารับประกัน</span><span class="wv">${period}</span></div>
        ${lt.warranty_detail ? `<div class="wdetail">${e(lt.warranty_detail).replace(/\n/g, "<br>")}</div>` : ""}
      </div>
      <div class="ack">จึงเรียนมาเพื่อโปรดทราบ</div>
      <div class="close">
        <div class="ty">ขอแสดงความนับถือ</div>
        <img class="sig" src="${sig}">
        <div class="signer">( ${e(lt.signer_name)} )</div>
        <div class="dept">${e(lt.signer_position)}</div>
      </div>
    </td></tr></tbody>
    <tfoot><tr><td><div class="fsp"></div></td></tr></tfoot>
  </table>
  <div class="pf"><div class="contact"><span class="en">Service &amp; Maintenance Section</span>, Precise System and Project Co., Ltd., Email: psp102.service@precise.co.th</div><img class="banner" src="${LBANNER}"></div>
</body></html>`;
}
// บล็อกรายงานผลการดำเนินงาน (ปัญหาที่พบตอนปิดงาน) — ใช้ใน PDF ของ Handover / LBS / EV
const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|heic)$/i;
function issuePdfBlock(rec: Record<string, any>): string {
  if (!rec || !rec.issue_flag) return "";
  if (rec.issue_flag !== "HAS") {
    return `<div class="sec">✅ รายงานผลการดำเนินงาน / Closing Report</div>
      <div class="box">ไม่พบปัญหาระหว่างดำเนินงาน — No issues reported.</div>`;
  }
  let h = `<div class="sec">⚠️ ปัญหาที่พบ / Issues Found</div><div class="box">${e(rec.issue_detail)}</div>`;
  const files = namedUrls(rec.issue_files);
  if (files.length) {
    const imgs = files.filter((f) => IMG_RE.test(f.name)).map((f) => f.url);
    const docs = files.filter((f) => !IMG_RE.test(f.name));
    if (imgs.length) h += `<div class="sec">📷 ภาพประกอบปัญหา / Issue Photos</div>${photoGrid(imgs)}`;
    if (docs.length) h += `<div class="sec">📎 เอกสารประกอบปัญหา / Issue Files</div><ul class="files">${docs.map((f) => `<li>📄 ${e(f.name)}</li>`).join("")}</ul>`;
  }
  return h;
}

async function buildPdf(type: string, id: string): Promise<string | null> {
  if (type === "Handover") {
    const { data: h } = await db.from("handovers").select("*").eq("id", id).single();
    if (!h) return null;
    const inner = `
      <div class="sec">📄 ข้อมูลโครงการ / Project Information</div>
      <table class="info">
        <tr><td class="k">Job No.</td><td>${e(h.job_no)}</td><td class="k">Status</td><td><span class="badge">${e(h.status)}</span></td></tr>
        <tr><td class="k">Project</td><td colspan="3">${e(h.project_name)}</td></tr>
        <tr><td class="k">Location</td><td>${e(h.location)}</td><td class="k">Project Manager</td><td>${e(h.project_manager)}</td></tr>
        <tr><td class="k">Handover Date</td><td>${dmy(h.handover_date)}</td><td class="k">Repair Count</td><td>${e(h.repair_count)} ครั้ง</td></tr>
      </table>
      <div class="sec">👥 ข้อมูลลูกค้า / Customer</div>
      <table class="info">
        <tr><td class="k">Customer</td><td>${e(h.customer_name)}</td><td class="k">Contact</td><td>${e(h.customer_contact)}</td></tr>
        <tr><td class="k">Phone</td><td>${e(h.phone)}</td><td class="k">Email</td><td>${e(h.email)}</td></tr>
      </table>
      <div class="sec">🔒 การรับประกัน / Warranty</div>
      <table class="info">
        <tr><td class="k">Type</td><td>${e(h.warranty_type)}</td><td class="k">Budget</td><td class="money">${thb(h.warranty_budget)}</td></tr>
        <tr><td class="k">Start</td><td>${dmy(h.warranty_start)}</td><td class="k">End</td><td>${dmy(h.warranty_end)}</td></tr>
      </table>` + issuePdfBlock(h);
    const sigs = sigBlock("ผู้ส่งมอบ / Prepared", "") + sigBlock("ผู้รับมอบ / Received", "");
    return pdfShell("Project Handover", h.job_no, "#1a4d8f", inner, sigs);
  }

  // LBS / EV Charger work sheet — เดิมไม่มี template (ปุ่ม 📄 ในหน้า LBS/EV จึง error)
  if (type === "LBS") {
    const { data: l } = await db.from("lbs_works").select("*").eq("id", id).single();
    if (!l) return null;
    const isEV = l.work_category === "EV";
    const team = await teamNames(l.assigned_team);
    let inner = `
      <div class="sec">${isEV ? "🔌" : "⚡"} ข้อมูลงาน / Work Information</div>
      <table class="info">
        <tr><td class="k">Job No.</td><td>${e(l.job_no)}</td><td class="k">Status</td><td><span class="badge">${e(l.status)}</span></td></tr>
        <tr><td class="k">Project</td><td colspan="3">${e(l.project_name)}</td></tr>
        <tr><td class="k">Location</td><td>${e(l.location)}</td><td class="k">Project Manager</td><td>${e(l.project_manager)}</td></tr>
        <tr><td class="k">Work Type</td><td>${e(String(l.work_type ?? "").replace(/_/g, " "))}</td><td class="k">${isEV ? "Charger Brand" : "Category"}</td><td>${e(isEV ? (l.charger_brand || "—") : (l.work_category || "LBS"))}</td></tr>
        <tr><td class="k">Planned Start</td><td>${dmy(l.planned_start)}</td><td class="k">Planned End</td><td>${dmy(l.planned_end)}</td></tr>
        <tr><td class="k">Team</td><td colspan="3">${e(team)}</td></tr>
      </table>
      <div class="sec">👥 ข้อมูลลูกค้า / Customer</div>
      <table class="info">
        <tr><td class="k">Customer</td><td>${e(l.customer_name)}</td><td class="k">Contact</td><td>${e(l.customer_contact)}</td></tr>
        <tr><td class="k">Phone</td><td>${e(l.phone)}</td><td class="k">Email</td><td>${e(l.email)}</td></tr>
      </table>`;
    if (l.work_description) inner += `<div class="sec">📝 รายละเอียดงาน / Description</div><div class="box">${e(l.work_description)}</div>`;
    inner += issuePdfBlock(l);
    const sigs = sigBlock("ผู้ปฏิบัติงาน / Performed", "") + sigBlock("ผู้รับมอบงาน / Received", "");
    return pdfShell(isEV ? "EV Charger Work" : "LBS & Support Work", l.job_no, isEV ? "#0f766e" : "#b45309", inner, sigs);
  }

  if (type === "ServiceOrder") {
    const { data: so } = await db.from("service_orders").select("*").eq("id", id).single();
    if (!so) return null;
    const team = normTeam(so.assigned_team).join(", ") || "—";
    const inner = `
      <div class="sec">🔧 ใบสั่งซ่อม / Service Order</div>
      <table class="info">
        <tr><td class="k">S.O. No.</td><td>${e(so.so_no)}</td><td class="k">Status</td><td><span class="badge">${e(so.status)}</span></td></tr>
        <tr><td class="k">Ref Job</td><td>${e(so.ref_job_no)}</td><td class="k">Request Date</td><td>${dmy(so.request_date)}</td></tr>
        <tr><td class="k">Planned Start</td><td>${dmy(so.planned_start)}</td><td class="k">Planned Finish</td><td>${dmy(so.planned_finish)}</td></tr>
        <tr><td class="k">Team</td><td colspan="3">${e(team)}</td></tr>
      </table>
      <div class="sec">📝 รายละเอียด / Description</div>
      <div class="box">${e(so.description)}</div>`;
    return pdfShell("Service Order", so.so_no, "#b45309", inner);
  }

  if (type === "ServiceReport") {
    const { data: sr } = await db.from("service_reports").select("*").eq("id", id).single();
    if (!sr) return null;
    const files = namedUrls(sr.attachment_files);
    let inner = `
      <div class="sec">📋 รายงานการซ่อม / Service Report</div>
      <table class="info">
        <tr><td class="k">S.R. No.</td><td>${e(sr.sr_no)}</td><td class="k">Status</td><td><span class="badge">${e(sr.status)}</span></td></tr>
        <tr><td class="k">Ref S.O.</td><td>${e(sr.ref_so)}</td><td class="k">Damaged Type</td><td>${e(sr.damaged_type)}</td></tr>
        <tr><td class="k">Damaged Items</td><td colspan="3">${e(sr.damaged_items)}</td></tr>
        <tr><td class="k">Supplier Serial</td><td colspan="3">${e(sr.supplier_serial)}</td></tr>
      </table>`;
    if (sr.repair_details) inner += `<div class="sec">🛠️ รายละเอียดการซ่อม / Repair Details</div><div class="box">${e(sr.repair_details)}</div>`;
    inner += `
      <div class="sec">💰 ค่าใช้จ่าย / Cost Breakdown</div>
      <table class="info">
        <tr><td class="k">Labor</td><td class="money">${thb(sr.cost_labor)}</td><td class="k">Material</td><td class="money">${thb(sr.cost_material)}</td></tr>
        <tr><td class="k">Total</td><td colspan="3" class="money cost-tot">${thb(sr.cost_total)}</td></tr>
      </table>`;
    const before = urls(sr.before_photos), after = urls(sr.after_photos);
    if (before.length || after.length) {
      inner += `<div class="sec">📷 ภาพก่อนซ่อม / Before</div>${photoGrid(before)}`;
      inner += `<div class="sec">📸 ภาพหลังซ่อม / After</div>${photoGrid(after)}`;
    }
    if (files.length) {
      inner += `<div class="sec">📎 เอกสารแนบ / Attachments</div><ul class="files">${files.map((f) => `<li>📄 ${e(f.name)}</li>`).join("")}</ul>`;
    }
    const sigs = sigBlock("ผู้ปฏิบัติงาน / Technician", sr.sig_technician || "") + sigBlock("ลูกค้า/ผู้รับมอบงาน / Customer", sr.sig_customer || "");
    return pdfShell("Service Report", sr.sr_no, "#0f766e", inner, sigs);
  }

  if (type === "Letter") {
    const { data: lt } = await db.from("letters").select("*").eq("id", id).single();
    if (!lt) return null;
    if (lt.category === "SM") return smLetter(lt);
    if (lt.category === "WARRANTY") return warrantyLetter(lt);
    const row = (k: string, v: string) => v ? `<div class="lrow"><div class="lk">${k}</div><div class="lc">:</div><div class="lv">${e(v)}</div></div>` : "";
    const typeLabel = lt.letter_type === "INTERNAL" ? "หนังสือภายใน / Internal Memo" : "หนังสือภายนอก / Official Letter";
    const inner = `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>Letter ${e(lt.letter_no)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{margin:0}
  body{font-family:'Sarabun','TH Sarabun New','IBM Plex Sans Thai','Segoe UI',sans-serif;color:#16202e;font-size:15px;line-height:1.75}
  .ph{left:0;right:0;background:#fff}
  .topbar{height:6px;background:linear-gradient(90deg,#1a4d8f,#16233f)}
  .lh{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #16233f;margin:0 46px;padding:12px 0}
  .co{display:flex;gap:13px;align-items:center}
  .lg{width:54px;height:54px;border-radius:11px;overflow:hidden;background:#fff;border:1px solid #e2e8f0;flex:0 0 auto}
  .lg img{width:100%;height:100%;object-fit:contain}
  .cn{font-weight:700;font-size:18px;color:#16233f;letter-spacing:.3px}
  .ca{font-size:11.5px;color:#64748b;margin-top:2px}
  .ltype{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#1a4d8f;font-weight:700;margin-top:4px}
  .meta{text-align:right;font-size:13.5px;min-width:185px}
  .meta .mrow{margin-bottom:3px}
  .meta b{color:#16233f}
  .meta .no{font-family:'Courier New',monospace;font-weight:700;font-size:15px;color:#1a4d8f}
  .pf{left:0;right:0;background:#fff}
  .pf .foot{text-align:center;font-size:12px;color:#16233f;border-top:1px solid #eef2f7;padding:7px 40px;line-height:1.45}
  .pf .foot .en{font-weight:700}
  .sheet{width:100%;border-collapse:collapse}
  .sheet>tbody>tr>td{padding:0 46px}
  .hsp{height:0}.fsp{height:0}
  .subj{margin:6px 0;font-weight:700;font-size:15.5px}
  .lrow{display:flex;gap:6px;margin:5px 0}
  .lk{font-weight:700;min-width:96px}.lc{width:8px}.lv{flex:1}
  .body{margin:20px 0;white-space:pre-wrap;text-align:justify;text-indent:48px}
  .close{margin-top:30px;margin-left:auto;width:300px;text-align:center}
  .close .ty{margin-bottom:60px}
  .close .nm{font-weight:700}
  .close .ps{font-size:13.5px;color:#475569}
  .cc{margin-top:34px;font-size:13px;color:#475569;border-top:1px dashed #cbd5e1;padding-top:8px}
  @media print{
    @page{size:A4;margin:0}
    body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .ph{position:fixed;top:0}
    .pf{position:fixed;bottom:0}
    thead .hsp{height:28mm}
    tfoot .fsp{height:15mm}
    tr,td{break-inside:avoid}
  }
</style></head><body>
  <div class="ph"><div class="topbar"></div><div class="lh"><div class="co"><div class="lg"><img src="${LOGO}"></div><div><div class="cn">Precise System and Project Co., Ltd.</div><div class="ca">ServiceMS · PSP102 Service Maintenance &amp; Support</div><div class="ltype">${typeLabel}</div></div></div><div class="meta"><div class="mrow"><b>เลขที่</b> <span class="no">${e(lt.letter_no)}</span></div><div class="mrow"><b>วันที่</b> ${dmy(lt.letter_date)}</div></div></div></div>
  <table class="sheet">
    <thead><tr><td><div class="hsp"></div></td></tr></thead>
    <tbody><tr><td>
      <div class="subj">เรื่อง&nbsp;&nbsp;&nbsp;${e(lt.subject)}</div>
      ${row("เรียน", lt.recipient + (lt.recipient_org ? "  (" + lt.recipient_org + ")" : ""))}
      ${row("อ้างถึง", lt.reference)}
      ${row("สิ่งที่ส่งมาด้วย", lt.enclosure)}
      ${lt.ref_job ? row("อ้างอิงโครงการ", lt.ref_job) : ""}
      <div class="body">${e(lt.body)}</div>
      <div class="close">
        <div class="ty">ขอแสดงความนับถือ</div>
        <div class="nm">${e(lt.signer_name || "")}</div>
        <div class="ps">${e(lt.signer_position || "")}</div>
      </div>
      ${lt.cc ? `<div class="cc"><b>สำเนาเรียน</b> ${e(lt.cc)}</div>` : ""}
    </td></tr></tbody>
    <tfoot><tr><td><div class="fsp"></div></td></tr></tfoot>
  </table>
  <div class="pf"><div class="foot"><span class="en">Service &amp; Maintenance Section</span>, Precise System and Project Co., Ltd., Email: psp102.service@precise.co.th</div></div>
</body></html>`;
    return inner;
  }
  return null;
}
