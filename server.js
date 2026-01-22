/**
 * server.js — ALGTP™ SaaS Scanner (OTP + PIN + Plans + Device Limits + Trial Expiry Hard Block)
 * ---------------------------------------------------------------------------
 * ✅ 1-box UX: enter PHONE (OTP) or 8-char PIN code
 * ✅ Register requires: phone + email
 * ✅ Auth methods:
 *    - Phone OTP (request + verify)
 *    - PIN unlock (8 chars) after user sets PIN
 *    - Owner master code (8 chars) for admin
 * ✅ Plans: trial/pro/vip with plan_expires_at
 *    - Trial = 14 days
 *    - Expired => HARD BLOCK UI (/app*) -> /billing
 *    - Expired => API returns 402 PLAN_EXPIRED
 * ✅ Soft device limit (Option C):
 *    - trial: 1 device
 *    - pro:   2 devices
 *    - vip:   3 devices
 *    - exceed limit => kick oldest sessions
 * ✅ Cookie stores ONLY session_id (httpOnly)
 *
 * Dependencies:
 *   npm i express dotenv better-sqlite3 cookie-parser bcryptjs nodemailer
 * Optional SMS provider: Twilio (recommended) -> npm i twilio
 *
 * ENV (.env):
 *   NODE_ENV=development
 *   PORT=3000
 *   SESSION_SECRET=replace_with_long_random
 *   DB_PATH=./algtp.db
 *   OWNER_CODE=AB12CD34            # 8 chars
 *   TRIAL_DAYS=14
 *
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=587
 *   SMTP_USER=you@gmail.com
 *   SMTP_PASS=app_password
 *   EMAIL_FROM="ALGTP <you@gmail.com>"
 *
 *   TWILIO_ACCOUNT_SID=...
 *   TWILIO_AUTH_TOKEN=...
 *   TWILIO_FROM=+1xxxxxxxxxx
 */

require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const nodemailer = require("nodemailer");

// Optional Twilio
let twilioClient = null;
try {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    // eslint-disable-next-line global-require
    const twilio = require("twilio");
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
} catch {
  twilioClient = null;
}

// -----------------------------------------------------------------------------
// App basics
// -----------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";

const SESSION_SECRET = String(process.env.SESSION_SECRET || "");
const DB_PATH = String(process.env.DB_PATH || "./algtp.db");

const OWNER_CODE = String(process.env.OWNER_CODE || "").trim().toUpperCase();
const TRIAL_DAYS = Math.max(1, Number(process.env.TRIAL_DAYS || 14));

// Validate secrets
if (!SESSION_SECRET || SESSION_SECRET.length < 24) {
  console.warn("[WARN] SESSION_SECRET is missing/too short. Please set a long random secret.");
}
function is8CharCode(s) {
  return typeof s === "string" && s.length === 8;
}
if (OWNER_CODE && !is8CharCode(OWNER_CODE)) {
  throw new Error("OWNER_CODE must be exactly 8 chars.");
}

// -----------------------------------------------------------------------------
// SQLite init
// -----------------------------------------------------------------------------
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  pin_hash TEXT,
  pin_lookup TEXT,                           -- NEW: fast lookup (HMAC of PIN)
  role TEXT NOT NULL DEFAULT 'user',         -- 'user' | 'owner'
  plan TEXT NOT NULL DEFAULT 'trial',        -- 'trial' | 'pro' | 'vip'
  plan_expires_at INTEGER NOT NULL,          -- epoch ms
  status TEXT NOT NULL DEFAULT 'active',     -- 'active' | 'blocked'
  phone_verified INTEGER NOT NULL DEFAULT 0, -- 0|1
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_pin_lookup ON users(pin_lookup);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_lastseen ON sessions(user_id, last_seen);
CREATE INDEX IF NOT EXISTS idx_sessions_user_device ON sessions(user_id, device_id);

CREATE TABLE IF NOT EXISTS otps (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  exp INTEGER NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otps_phone ON otps(phone);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  user_id TEXT,
  detail TEXT
);
`);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function nowMs() {
  return Date.now();
}
function uuid() {
  return crypto.randomUUID();
}
function normalizePhone(phoneRaw) {
  const s = String(phoneRaw || "").trim();
  if (!s) return "";
  if (s.startsWith("+")) return "+" + s.slice(1).replace(/\D/g, "");
  return s.replace(/\D/g, "");
}
function normalizeEmail(emailRaw) {
  return String(emailRaw || "").trim().toLowerCase();
}
function normalizePin(pinRaw) {
  return String(pinRaw || "").trim().toUpperCase();
}
function isLikelyEmail(s) {
  return typeof s === "string" && s.includes("@") && s.includes(".");
}
function isLikelyPhone(s) {
  const p = normalizePhone(s);
  const digits = p.startsWith("+") ? p.slice(1) : p;
  return digits.length >= 10 && digits.length <= 15;
}
function planMaxDevices(plan) {
  const p = String(plan || "trial").toLowerCase();
  if (p === "vip") return 3;
  if (p === "pro") return 2;
  return 1;
}
function isExpired(user) {
  const exp = Number(user?.plan_expires_at || 0);
  return !exp || nowMs() >= exp;
}
function audit(kind, userId, detailObj) {
  try {
    db.prepare("INSERT INTO audit_log (id, at, kind, user_id, detail) VALUES (?,?,?,?,?)").run(
      uuid(),
      nowMs(),
      String(kind),
      userId || null,
      detailObj ? JSON.stringify(detailObj) : null
    );
  } catch {}
}

// NEW: fast PIN lookup (HMAC)
function pinLookup(pin) {
  const key = SESSION_SECRET || "dev_insecure_secret_change_me";
  return crypto.createHmac("sha256", key).update(String(pin)).digest("hex");
}

// Cookie
function setSessionCookie(res, sessionId) {
  res.cookie("algtp_sess", sessionId, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax", // keep lax to work nicely with redirects/checkout
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
}
function clearSessionCookie(res) {
  res.clearCookie("algtp_sess", { path: "/" });
}

// -----------------------------------------------------------------------------
// Minimal CSRF guard for browser (Same-Origin)
// -----------------------------------------------------------------------------
function requireSameOrigin(req, res, next) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin) return next(); // allow non-browser clients
  try {
    const o = new URL(origin);
    if (o.host !== host) return res.status(403).json({ ok: false, error: "CSRF_BLOCKED" });
  } catch {
    // if origin malformed, block
    return res.status(403).json({ ok: false, error: "CSRF_BLOCKED" });
  }
  return next();
}

// -----------------------------------------------------------------------------
// Soft brute-force protections (simple + effective)
// -----------------------------------------------------------------------------
const ipGate = new Map(); // ip -> {count, until}
function ipHit(ip, maxFails = 8, lockMs = 5 * 60 * 1000) {
  const now = nowMs();
  const a = ipGate.get(ip) || { count: 0, until: 0 };
  if (a.until && now < a.until) return { blocked: true, waitMs: a.until - now };
  a.count += 1;
  if (a.count >= maxFails) {
    a.until = now + lockMs;
    a.count = 0;
  }
  ipGate.set(ip, a);
  return { blocked: false };
}
function ipClear(ip) {
  ipGate.delete(ip);
}

// OTP rate limit per phone
const otpGate = new Map(); // phone -> {count, resetAt}
function otpCanSend(phone, limit = 3, windowMs = 10 * 60 * 1000) {
  const now = nowMs();
  const g = otpGate.get(phone) || { count: 0, resetAt: now + windowMs };
  if (now > g.resetAt) {
    g.count = 0;
    g.resetAt = now + windowMs;
  }
  if (g.count >= limit) return { ok: false, waitMs: g.resetAt - now };
  g.count += 1;
  otpGate.set(phone, g);
  return { ok: true };
}

// -----------------------------------------------------------------------------
// Sessions (Option C) create/refresh + enforce device limit by plan
// -----------------------------------------------------------------------------
function createOrRefreshSession({ userId, deviceId, userPlan }) {
  const now = nowMs();

  const existing = db
    .prepare("SELECT id FROM sessions WHERE user_id=? AND device_id=? LIMIT 1")
    .get(userId, deviceId);

  let sessionId;
  if (existing?.id) {
    sessionId = existing.id;
    db.prepare("UPDATE sessions SET last_seen=? WHERE id=?").run(now, sessionId);
  } else {
    sessionId = uuid();
    db.prepare(
      "INSERT INTO sessions (id, user_id, device_id, created_at, last_seen) VALUES (?,?,?,?,?)"
    ).run(sessionId, userId, deviceId, now, now);
  }

  const max = planMaxDevices(userPlan);
  const rows = db
    .prepare("SELECT id FROM sessions WHERE user_id=? ORDER BY last_seen DESC")
    .all(userId);

  let kicked = false;
  if (rows.length > max) {
    kicked = true;
    const toDelete = rows.slice(max).map((r) => r.id);
    const del = db.prepare("DELETE FROM sessions WHERE id=?");
    const tx = db.transaction((ids) => ids.forEach((id) => del.run(id)));
    tx(toDelete);
  }

  return { sessionId, kicked };
}

// -----------------------------------------------------------------------------
// Auth middleware
// -----------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const sid = req.cookies.algtp_sess;
  if (!sid) return res.status(401).redirect("/");

  const s = db.prepare("SELECT * FROM sessions WHERE id=?").get(sid);
  if (!s) return res.status(401).redirect("/");

  const u = db.prepare("SELECT * FROM users WHERE id=?").get(s.user_id);
  if (!u) return res.status(401).redirect("/");
  if (u.status !== "active") return res.status(403).send("Account blocked.");

  try {
    db.prepare("UPDATE sessions SET last_seen=? WHERE id=?").run(nowMs(), sid);
  } catch {}

  req.user_db = u;
  req.session = s;
  next();
}

function requireOwner(req, res, next) {
  if (!req.user_db || req.user_db.role !== "owner") return res.status(403).send("Forbidden");
  next();
}

// HARD BLOCK UI: expired -> /billing
function blockExpiredUI(req, res, next) {
  if (isExpired(req.user_db)) return res.redirect("/billing");
  next();
}

// HARD BLOCK API: expired -> 402
function blockExpiredAPI(req, res, next) {
  if (isExpired(req.user_db)) {
    return res.status(402).json({
      ok: false,
      error: "PLAN_EXPIRED",
      plan: req.user_db.plan,
      plan_expires_at: req.user_db.plan_expires_at,
    });
  }
  next();
}

// -----------------------------------------------------------------------------
// Email
// -----------------------------------------------------------------------------
async function sendEmail(to, subject, html) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.EMAIL_FROM || user;

  if (!host || !user || !pass) {
    console.log("[EMAIL DEV FALLBACK]", { to, subject, html: html?.slice(0, 200) });
    return;
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  await transporter.sendMail({ from, to, subject, html });
}

// -----------------------------------------------------------------------------
// SMS OTP send
// -----------------------------------------------------------------------------
async function sendOtpSms(phone, code) {
  const from = process.env.TWILIO_FROM;
  if (twilioClient && from) {
    await twilioClient.messages.create({
      to: phone.startsWith("+") ? phone : `+${phone}`,
      from,
      body: `ALGTP OTP: ${code} (expires in 5 minutes)`,
    });
    return;
  }
  console.log(`[OTP DEV FALLBACK] phone=${phone} code=${code}`);
}

// -----------------------------------------------------------------------------
// Pages (simple HTML)
// -----------------------------------------------------------------------------
function pageLoginHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>ALGTP™ Secure Access</title>
  <style>
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto;background:#0b0f19;color:#e8eefc;display:flex;min-height:100vh;align-items:center;justify-content:center}
    .card{width:min(520px,92vw);background:linear-gradient(180deg,#111a2e,#0b0f19);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:20px 18px;box-shadow:0 10px 30px rgba(0,0,0,.45)}
    h1{font-size:18px;margin:0 0 12px}
    .muted{color:rgba(232,238,252,.7);font-size:13px;margin:0 0 14px}
    input,button{width:100%;font-size:15px;border-radius:14px;border:1px solid rgba(255,255,255,.12);padding:12px 14px;background:rgba(255,255,255,.04);color:#e8eefc;outline:none}
    button{margin-top:10px;background:linear-gradient(90deg,#5b7cfa,#a855f7);border:none;font-weight:700;cursor:pointer}
    .row{display:flex;gap:10px;margin-top:10px}
    .row button{width:auto;flex:1}
    .msg{margin-top:10px;font-size:13px;color:#ffb4b4;min-height:18px}
    .ok{color:#b6ffcb}
    .small{font-size:12px;color:rgba(232,238,252,.65)}
    a{color:#9db3ff}
  </style>
</head>
<body>
  <div class="card">
    <h1>🔐 ALGTP™ Secure Access</h1>
    <p class="muted">One box. Enter <b>phone</b> (OTP) or <b>8-char PIN</b>. New users register with phone + email.</p>

    <div class="small">Device ID is stored locally to manage device limits by plan.</div>

    <form id="boxForm">
      <input id="box" placeholder="Phone number OR 8-char PIN code" autocomplete="one-time-code" />
      <button type="submit">Continue</button>
      <div class="msg" id="msg"></div>
    </form>

    <div class="row">
      <button id="btnRegister" type="button">Register (phone + email)</button>
      <button id="btnLogout" type="button">Logout</button>
    </div>

    <div style="margin-top:10px" class="small">
      After OTP verify, set your 8-char PIN for fast login.
      <br/>Need billing? <a href="/billing">Go to billing</a>
    </div>
  </div>

<script>
function getDeviceId(){
  let id = localStorage.getItem("algtp_device_id");
  if(!id){
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    localStorage.setItem("algtp_device_id", id);
  }
  return id;
}
function normPhone(s){
  s = String(s||"").trim();
  if(!s) return "";
  if(s.startsWith("+")) return "+" + s.slice(1).replace(/\\D/g,"");
  return s.replace(/\\D/g,"");
}
const msgEl = document.getElementById("msg");
function setMsg(t, ok=false){
  msgEl.textContent = t || "";
  msgEl.className = "msg " + (ok ? "ok" : "");
}
document.getElementById("boxForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  setMsg("");
  const raw = document.getElementById("box").value.trim();
  const device_id = getDeviceId();

  if(raw.length === 8){
    const r = await fetch("/auth/unlock", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ code: raw.toUpperCase(), device_id })
    });
    const j = await r.json().catch(()=> ({}));
    if(r.ok && j.ok){
      setMsg("Unlocked. Redirecting...", true);
      location.href = "/app";
    } else setMsg(j.error || "Unlock failed");
    return;
  }

  const p = normPhone(raw);
  const digits = p.startsWith("+") ? p.slice(1) : p;
  if(digits.length >= 10 && digits.length <= 15){
    const r = await fetch("/auth/otp/request", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ phone: p, device_id })
    });
    const j = await r.json().catch(()=> ({}));
    if(r.ok && j.ok){
      const otp = prompt("Enter OTP sent to your phone:");
      if(!otp) return;
      const r2 = await fetch("/auth/otp/verify",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ phone: p, otp: String(otp).trim(), device_id })
      });
      const j2 = await r2.json().catch(()=> ({}));
      if(r2.ok && j2.ok){
        setMsg("Verified. Redirecting...", true);
        location.href = "/app";
      } else setMsg(j2.error || "OTP verify failed");
    } else setMsg(j.error || "OTP request failed");
    return;
  }

  setMsg("Enter phone number (to receive OTP) OR 8-char PIN code.");
});

document.getElementById("btnRegister").addEventListener("click", async ()=>{
  setMsg("");
  const device_id = getDeviceId();
  const phone = prompt("Enter phone (required):");
  if(!phone) return;
  const email = prompt("Enter email (required):");
  if(!email) return;

  const r = await fetch("/auth/register", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ phone, email, device_id })
  });
  const j = await r.json().catch(()=> ({}));
  if(r.ok && j.ok) setMsg("Registered. Now request OTP by entering your phone in the box.", true);
  else setMsg(j.error || "Register failed");
});

document.getElementById("btnLogout").addEventListener("click", async ()=>{
  await fetch("/auth/logout", { method:"POST" }).catch(()=>{});
  setMsg("Logged out.", true);
});
</script>
</body>
</html>`;
}

function pageAppHtml(u) {
  const now = Date.now();
  const exp = Number(u.plan_expires_at || 0);
  const daysLeft = exp ? Math.max(0, Math.ceil((exp - now) / (24 * 60 * 60 * 1000))) : 0;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>ALGTP™ App</title>
  <style>
    body{margin:0;font-family:system-ui;background:#0b0f19;color:#e8eefc;padding:16px}
    .card{max-width:760px;margin:0 auto;background:#111a2e;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:16px}
    .row{display:flex;gap:10px;flex-wrap:wrap}
    .pill{padding:6px 10px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);font-size:12px}
    button{padding:10px 12px;border-radius:14px;border:none;background:linear-gradient(90deg,#5b7cfa,#a855f7);color:#fff;font-weight:700;cursor:pointer}
    input{padding:10px 12px;border-radius:14px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#fff;outline:none}
    .msg{margin-top:10px;font-size:13px}
    a{color:#9db3ff}
  </style>
</head>
<body>
  <div class="card">
    <h2 style="margin:0 0 10px">🚀 ALGTP™ App</h2>
    <div class="row" style="margin-bottom:12px">
      <div class="pill">Plan: <b>${u.plan}</b></div>
      <div class="pill">Expires: <b>${new Date(exp).toLocaleString()}</b></div>
      <div class="pill">Days left: <b>${daysLeft}</b></div>
      <div class="pill">Devices allowed: <b>${planMaxDevices(u.plan)}</b></div>
    </div>

    <div style="margin:10px 0 6px">Set / change your fast PIN (8 chars):</div>
    <div class="row">
      <input id="pin" maxlength="8" placeholder="AB12CD34" />
      <button id="setPin">Save PIN</button>
      <button id="billing">Billing</button>
      <button id="logout">Logout</button>
    </div>
    <div class="msg" id="msg"></div>

    <hr style="border:0;border-top:1px solid rgba(255,255,255,.08);margin:14px 0"/>

    <div>
      <div style="margin-bottom:8px">Example paid API call (blocked when expired):</div>
      <button id="scanBtn">Run Scan (demo)</button>
      <div class="msg" id="scanMsg"></div>
    </div>

    <div style="margin-top:12px;font-size:12px;color:rgba(232,238,252,.65)">
      Note: When trial expires, you will be redirected to <a href="/billing">/billing</a>.
    </div>
  </div>

<script>
const msg = (t, ok=false) => {
  const el = document.getElementById("msg");
  el.textContent = t || "";
  el.style.color = ok ? "#b6ffcb" : "#ffb4b4";
};

document.getElementById("setPin").addEventListener("click", async ()=>{
  const pin = String(document.getElementById("pin").value || "").trim().toUpperCase();
  if(pin.length !== 8) return msg("PIN must be exactly 8 chars.");
  const r = await fetch("/auth/pin/set", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ pin })
  });
  const j = await r.json().catch(()=> ({}));
  if(r.ok && j.ok) msg("PIN saved.", true);
  else msg(j.error || "Failed");
});

document.getElementById("billing").addEventListener("click", ()=> location.href="/billing");
document.getElementById("logout").addEventListener("click", async ()=>{
  await fetch("/auth/logout", { method:"POST" }).catch(()=>{});
  location.href="/";
});

document.getElementById("scanBtn").addEventListener("click", async ()=>{
  const el = document.getElementById("scanMsg");
  el.textContent = "";
  const r = await fetch("/api/scan_demo", { method:"POST" });
  const j = await r.json().catch(()=> ({}));
  if(r.status === 402){
    location.href="/billing";
    return;
  }
  el.textContent = JSON.stringify(j);
});
</script>
</body>
</html>`;
}

function pageBillingHtml(u) {
  const now = nowMs();
  const exp = Number(u.plan_expires_at || 0);
  const expired = now >= exp;
  const daysLeft = exp ? Math.max(0, Math.ceil((exp - now) / (24 * 60 * 60 * 1000))) : 0;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>ALGTP™ Billing</title>
  <style>
    body{margin:0;font-family:system-ui;background:#0b0f19;color:#e8eefc;padding:16px}
    .card{max-width:760px;margin:0 auto;background:#111a2e;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:16px}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .pill{padding:6px 10px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);font-size:12px}
    button{padding:10px 12px;border-radius:14px;border:none;background:linear-gradient(90deg,#5b7cfa,#a855f7);color:#fff;font-weight:800;cursor:pointer}
    input,select{padding:10px 12px;border-radius:14px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#fff;outline:none}
    .warn{color:#ffb4b4}
    .ok{color:#b6ffcb}
    a{color:#9db3ff}
  </style>
</head>
<body>
  <div class="card">
    <h2 style="margin:0 0 10px">💳 ALGTP™ Billing</h2>

    <div class="row" style="margin-bottom:12px">
      <div class="pill">Plan: <b>${u.plan}</b></div>
      <div class="pill">Expires: <b>${new Date(exp).toLocaleString()}</b></div>
      <div class="pill">Days left: <b>${daysLeft}</b></div>
      <div class="pill">Status: <b class="${expired ? "warn" : "ok"}">${expired ? "EXPIRED" : "ACTIVE"}</b></div>
    </div>

    <div class="${expired ? "warn" : ""}" style="margin-bottom:12px">
      ${expired ? "Your access has expired. Upgrade to continue using the app." : "Upgrade any time to extend access."}
    </div>

    <div class="row" style="margin-bottom:8px">
      <button onclick="location.href='/app'">Go App</button>
      <button onclick="location.href='/'">Login</button>
      <button id="logout">Logout</button>
    </div>

    <hr style="border:0;border-top:1px solid rgba(255,255,255,.08);margin:14px 0"/>

    <div style="margin-bottom:8px">Admin-only quick grant (for manual payments / testing):</div>
    <div class="row">
      <select id="plan">
        <option value="pro">pro</option>
        <option value="vip">vip</option>
      </select>
      <input id="days" type="number" min="1" value="30" style="width:120px"/>
      <button id="grant">Grant to ME</button>
    </div>
    <div id="msg" style="margin-top:10px;font-size:13px"></div>

    <div style="margin-top:14px;font-size:12px;color:rgba(232,238,252,.65)">
      In production, replace this with your Stripe/Whop checkout buttons and webhook that calls the same logic as /admin/grant.
    </div>
  </div>

<script>
const msg = (t, ok=false) => {
  const el = document.getElementById("msg");
  el.textContent = t || "";
  el.style.color = ok ? "#b6ffcb" : "#ffb4b4";
};

document.getElementById("logout").addEventListener("click", async ()=>{
  await fetch("/auth/logout", { method:"POST" }).catch(()=>{});
  location.href="/";
});

document.getElementById("grant").addEventListener("click", async ()=>{
  const plan = document.getElementById("plan").value;
  const days = Number(document.getElementById("days").value || 30);

  const r = await fetch("/admin/grant_me", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ plan, days })
  });

  const j = await r.json().catch(()=> ({}));
  if(r.ok && j.ok){
    msg("Granted. Refreshing...", true);
    setTimeout(()=> location.reload(), 600);
  } else msg(j.error || "Grant failed");
});
</script>
</body>
</html>`;
}

// -----------------------------------------------------------------------------
// Routes: Pages
// -----------------------------------------------------------------------------
app.get("/", (req, res) => res.type("html").send(pageLoginHtml()));

app.get("/app", requireAuth, blockExpiredUI, (req, res) => {
  res.type("html").send(pageAppHtml(req.user_db));
});
app.get("/app/*", requireAuth, blockExpiredUI, (req, res) => {
  res.type("html").send(pageAppHtml(req.user_db));
});

app.get("/billing", requireAuth, (req, res) => {
  res.type("html").send(pageBillingHtml(req.user_db));
});

// -----------------------------------------------------------------------------
// Auth Routes
// -----------------------------------------------------------------------------
function getIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

// Register
app.post("/auth/register", (req, res) => {
  const ip = getIp(req);
  const gate = ipHit(ip, 10, 5 * 60 * 1000);
  if (gate.blocked) return res.status(429).json({ ok: false, error: "TOO_MANY_TRIES" });

  const phone = normalizePhone(req.body.phone);
  const email = normalizeEmail(req.body.email);

  if (!phone || !isLikelyPhone(phone)) return res.status(400).json({ ok: false, error: "BAD_PHONE" });
  if (!email || !isLikelyEmail(email)) return res.status(400).json({ ok: false, error: "BAD_EMAIL" });

  const userId = uuid();
  const exp = nowMs() + TRIAL_DAYS * 24 * 60 * 60 * 1000;

  try {
    db.prepare(
      `INSERT INTO users (id, phone, email, pin_hash, pin_lookup, role, plan, plan_expires_at, status, phone_verified, created_at)
       VALUES (?, ?, ?, NULL, NULL, 'user', 'trial', ?, 'active', 0, ?)`
    ).run(userId, phone, email, exp, nowMs());

    audit("register", userId, { phone, email, trial_days: TRIAL_DAYS, plan_expires_at: exp });

    sendEmail(email, "Welcome to ALGTP™ Trial", `<div>
      <h3>Welcome to ALGTP™</h3>
      <p>Your trial is active for <b>${TRIAL_DAYS} days</b>.</p>
      <p>Verify phone via OTP to access.</p>
    </div>`).catch(() => {});

    ipClear(ip);
    return res.json({ ok: true, user_id: userId, plan: "trial", plan_expires_at: exp });
  } catch {
    return res.status(409).json({ ok: false, error: "PHONE_OR_EMAIL_ALREADY_USED" });
  }
});

// OTP request
app.post("/auth/otp/request", async (req, res) => {
  const ip = getIp(req);
  const gate = ipHit(ip, 12, 5 * 60 * 1000);
  if (gate.blocked) return res.status(429).json({ ok: false, error: "TOO_MANY_TRIES" });

  const phone = normalizePhone(req.body.phone);
  const deviceId = String(req.body.device_id || "").trim();
  if (!deviceId) return res.status(400).json({ ok: false, error: "MISSING_DEVICE" });
  if (!phone || !isLikelyPhone(phone)) return res.status(400).json({ ok: false, error: "BAD_PHONE" });

  const u = db.prepare("SELECT * FROM users WHERE phone=?").get(phone);
  if (!u) return res.status(404).json({ ok: false, error: "USER_NOT_FOUND" });
  if (u.status !== "active") return res.status(403).json({ ok: false, error: "BLOCKED" });

  // allow OTP even if expired (so they can login to billing)
  const gate2 = otpCanSend(phone);
  if (!gate2.ok) return res.status(429).json({ ok: false, error: "OTP_RATE_LIMIT", wait_ms: gate2.waitMs });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = await bcrypt.hash(code, 10);
  const exp = nowMs() + 5 * 60 * 1000;

  db.prepare("DELETE FROM otps WHERE phone=?").run(phone);
  db.prepare("INSERT INTO otps (id, phone, code_hash, exp, tries, created_at) VALUES (?,?,?,?,0,?)").run(
    uuid(),
    phone,
    codeHash,
    exp,
    nowMs()
  );

  audit("otp_request", u.id, { phone, deviceId });

  try {
    await sendOtpSms(phone, code);
  } catch (e) {
    console.log("OTP send error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "OTP_SEND_FAILED" });
  }

  ipClear(ip);
  return res.json({ ok: true });
});

// OTP verify
app.post("/auth/otp/verify", async (req, res) => {
  const ip = getIp(req);
  const gate = ipHit(ip, 12, 5 * 60 * 1000);
  if (gate.blocked) return res.status(429).json({ ok: false, error: "TOO_MANY_TRIES" });

  const phone = normalizePhone(req.body.phone);
  const otp = String(req.body.otp || "").trim();
  const deviceId = String(req.body.device_id || "").trim();
  if (!deviceId) return res.status(400).json({ ok: false, error: "MISSING_DEVICE" });

  if (!phone || !isLikelyPhone(phone)) return res.status(400).json({ ok: false, error: "BAD_PHONE" });
  if (!otp || otp.length < 4) return res.status(400).json({ ok: false, error: "BAD_OTP" });

  const u = db.prepare("SELECT * FROM users WHERE phone=?").get(phone);
  if (!u) return res.status(404).json({ ok: false, error: "USER_NOT_FOUND" });
  if (u.status !== "active") return res.status(403).json({ ok: false, error: "BLOCKED" });

  const rec = db.prepare("SELECT * FROM otps WHERE phone=?").get(phone);
  if (!rec) return res.status(401).json({ ok: false, error: "OTP_NOT_FOUND" });
  if (nowMs() >= Number(rec.exp)) {
    db.prepare("DELETE FROM otps WHERE phone=?").run(phone);
    return res.status(401).json({ ok: false, error: "OTP_EXPIRED" });
  }
  if (Number(rec.tries) >= 5) return res.status(429).json({ ok: false, error: "OTP_TOO_MANY_TRIES" });

  const ok = await bcrypt.compare(otp, rec.code_hash);
  if (!ok) {
    db.prepare("UPDATE otps SET tries=tries+1 WHERE id=?").run(rec.id);
    return res.status(401).json({ ok: false, error: "OTP_INVALID" });
  }

  db.prepare("DELETE FROM otps WHERE phone=?").run(phone);
  if (!u.phone_verified) db.prepare("UPDATE users SET phone_verified=1 WHERE id=?").run(u.id);

  const { sessionId, kicked } = createOrRefreshSession({
    userId: u.id,
    deviceId,
    userPlan: u.plan,
  });

  setSessionCookie(res, sessionId);
  audit("otp_verify_ok", u.id, { deviceId, kicked });

  ipClear(ip);
  return res.json({
    ok: true,
    plan: u.plan,
    plan_expires_at: u.plan_expires_at,
    kicked,
    expired: isExpired(u),
  });
});

// PIN unlock (FAST)
app.post("/auth/unlock", async (req, res) => {
  const ip = getIp(req);
  const gate = ipHit(ip, 10, 5 * 60 * 1000);
  if (gate.blocked) return res.status(429).json({ ok: false, error: "TOO_MANY_TRIES" });

  const code = normalizePin(req.body.code);
  const deviceId = String(req.body.device_id || "").trim();
  if (!deviceId) return res.status(400).json({ ok: false, error: "MISSING_DEVICE" });
  if (!is8CharCode(code)) return res.status(400).json({ ok: false, error: "CODE_MUST_BE_8" });

  // Owner master code
  if (OWNER_CODE && code === OWNER_CODE) {
    const ownerPhone = "+10000000000";
    const ownerEmail = "owner@algtp.local";
    let owner = db.prepare("SELECT * FROM users WHERE role='owner' LIMIT 1").get();

    if (!owner) {
a/**
 * server.js — ALGTP™ – Algorithmic Trading Platform Scanner (FULL + Multi-Page UI + Alerts + Auto Refresh + Scan Symbols)
 *
 * Features:
 * - Single list (no S05/S04 sections)
 * - Groups: topGainers | topLosers | topGappers
 * - Filters: cap=all|small|mid|big, minGap (for gappers)
 * - Adds: Float + MarketCap (auto-detect if present in snapshot)
 * - UI Pages:
 *    /ui            (dashboard)
 *    /ui/gainers    (preset)
 *    /ui/losers     (preset)
 *    /ui/gappers    (preset + minGap=10)
 *    /ui/smallcap   (preset cap=small)
 *    /ui/midcap     (preset cap=mid)
 *    /ui/bigcap     (preset cap=big)
 *
 * - Alerts (UI):
 *    Sound + Desktop notifications (anti-spam per symbol per session)
 * - Auto Refresh (UI):
 *    Toggle + interval seconds, refreshes current mode (Group scan or Symbols scan)
 * - Symbols Scan:
 *    GET /scan?symbols=NVDA,TSLA,AAPL
 */

require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ---------------- ENV ----------------
const PORT = Number(process.env.PORT || 3000);

const MASSIVE_API_KEY = String(process.env.MASSIVE_API_KEY || "").trim();
const MASSIVE_AUTH_TYPE = String(process.env.MASSIVE_AUTH_TYPE || "query").trim();
const MASSIVE_QUERY_KEYNAME = String(process.env.MASSIVE_QUERY_KEYNAME || "apiKey").trim();

const MASSIVE_MOVER_URL = String(
  process.env.MASSIVE_MOVER_URL || "https://api.massive.com/v2/snapshot/locale/us/markets/stocks"
).trim();

const MASSIVE_TICKER_SNAPSHOT_URL = String(
  process.env.MASSIVE_TICKER_SNAPSHOT_URL || "https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers"
).trim();

const INCLUDE_OTC = String(process.env.INCLUDE_OTC || "false").toLowerCase() === "true";
const SNAP_CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.SNAP_CONCURRENCY || 4)));
const DEBUG = String(process.env.DEBUG || "true").toLowerCase() === "true";

// ---------------- helpers ----------------
function envMissing() {
  const miss = [];
  if (!MASSIVE_API_KEY) miss.push("MASSIVE_API_KEY");
  if (!MASSIVE_MOVER_URL) miss.push("MASSIVE_MOVER_URL");
  if (!MASSIVE_TICKER_SNAPSHOT_URL) miss.push("MASSIVE_TICKER_SNAPSHOT_URL");
  return miss;
}

function auth(params = {}, headers = {}) {
  const t = String(MASSIVE_AUTH_TYPE).toLowerCase();

  if (t === "query") params[MASSIVE_QUERY_KEYNAME || "apiKey"] = MASSIVE_API_KEY;
  else if (t === "xapi") headers["x-api-key"] = MASSIVE_API_KEY;
  else if (t === "bearer") headers["authorization"] = `Bearer ${MASSIVE_API_KEY}`;
  else params[MASSIVE_QUERY_KEYNAME || "apiKey"] = MASSIVE_API_KEY;

  headers["user-agent"] =
    headers["user-agent"] ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

  return { params, headers };
}

function parseSymbols(input) {
  return String(input || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function n(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}
function round2(x) {
  const v = n(x);
  return v === null ? null : Number(v.toFixed(2));
}
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return out;
}

// ---------------- scoring (icon + alerts) ----------------
function demandScore(row) {
  const gap = Math.abs(n(row?.gapPct) ?? 0);
  const pc = Math.abs(n(row?.pricePct) ?? 0);

  let s = 0;
  if (gap >= 20) s += 1;
  if (gap >= 40) s += 1;
  if (gap >= 60) s += 1;
  if (pc >= 10) s += 1;
  if (pc >= 20) s += 1;

  return clamp(s, 0, 5);
}
function signalIcon(d) {
  if (d >= 5) return "🚀";
  if (d >= 4) return "🔥";
  if (d >= 3) return "👀";
  return "⛔️";
}

// ---------------- axios safe ----------------
function axiosFail(e) {
  if (!e || !e.isAxiosError) return { kind: "unknown", message: String(e?.message || e) };

  const code = e.code || null;
  const msg = e.message || "axios error";
  const url = e.config?.url || null;

  if (!e.response) return { kind: "network", code, message: msg, url };

  const status = e.response.status;
  const data = e.response.data;
  const bodyPreview = typeof data === "string" ? data.slice(0, 800) : JSON.stringify(data).slice(0, 800);
  return { kind: "http", status, message: msg, url, bodyPreview };
}

async function safeGet(url, { params, headers }) {
  try {
    const r = await axios.get(url, {
      params,
      headers,
      timeout: 25000,
      validateStatus: () => true,
    });
    return { ok: r.status < 400, status: r.status, data: r.data, url };
  } catch (e) {
    return { ok: false, status: null, data: null, url, errorDetail: axiosFail(e) };
  }
}

// ---------------- Massive calls ----------------
async function fetchMovers(direction = "gainers") {
  const d = String(direction || "gainers").toLowerCase().trim();
  const directionSafe = d === "losers" ? "losers" : "gainers";

  const base = MASSIVE_MOVER_URL.replace(/\/+$/, "");
  const url = `${base}/${directionSafe}`;

  const params = {};
  const headers = {};
  if (INCLUDE_OTC) params["include_otc"] = "true";
  const a = auth(params, headers);

  const r = await safeGet(url, { params: a.params, headers: a.headers });

  const rows = Array.isArray(r.data?.tickers)
    ? r.data.tickers
    : Array.isArray(r.data?.results)
    ? r.data.results
    : Array.isArray(r.data?.data)
    ? r.data.data
    : null;

  return {
    ok: r.ok && Array.isArray(rows),
    url,
    status: r.status,
    rows: Array.isArray(rows) ? rows : [],
    sample: Array.isArray(rows) ? rows[0] : r.data,
    errorDetail: r.errorDetail,
  };
}

async function fetchTickerSnapshot(ticker) {
  const base = MASSIVE_TICKER_SNAPSHOT_URL.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(String(ticker || "").trim().toUpperCase())}`;

  const params = {};
  const headers = {};
  const a = auth(params, headers);

  const r = await safeGet(url, { params: a.params, headers: a.headers });
  return { ok: r.ok, url, status: r.status, data: r.data, errorDetail: r.errorDetail };
}

// ---------------- auto-detect fields ----------------
function findFirstNumberByKeys(obj, candidateKeys, maxNodes = 6000) {
  if (!obj || typeof obj !== "object") return { value: null, path: null, keyMatched: null };

  const wanted = new Set(candidateKeys.map((k) => String(k).toLowerCase()));
  const q = [{ v: obj, path: "root" }];
  let visited = 0;

  while (q.length && visited < maxNodes) {
    const { v, path } = q.shift();
    visited++;

    if (!v || typeof v !== "object") continue;

    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const item = v[i];
        if (item && typeof item === "object") q.push({ v: item, path: `${path}[${i}]` });
      }
      continue;
    }

    for (const k of Object.keys(v)) {
      const keyLower = String(k).toLowerCase();
      const val = v[k];

      if (wanted.has(keyLower)) {
        const num = n(val);
        if (num !== null) return { value: num, path: `${path}.${k}`, keyMatched: k };
      }

      if (val && typeof val === "object") q.push({ v: val, path: `${path}.${k}` });
    }
  }

  return { value: null, path: null, keyMatched: null };
}

function capCategory(marketCap) {
  const mc = n(marketCap);
  if (mc === null) return null;
  if (mc < 2_000_000_000) return "small";
  if (mc < 10_000_000_000) return "mid";
  return "big";
}

function floatCategory(floatShares) {
  const fs = n(floatShares);
  if (fs === null) return null;
  if (fs < 10_000_000) return "nano";
  if (fs < 20_000_000) return "low";
  if (fs < 50_000_000) return "mid";
  return "high";
}

function normalizeSnapshotAuto(ticker, snap) {
  const root = snap?.results ?? snap ?? {};
  const day = root?.day ?? root?.todays ?? root?.today ?? null;
  const prev = root?.prevDay ?? root?.previousDay ?? root?.prev ?? null;

  const lastTradePrice =
    n(root?.lastTrade?.p) ??
    n(root?.lastTrade?.price) ??
    n(root?.last?.p) ??
    n(root?.last) ??
    n(root?.price) ??
    null;

  const dayClose = n(day?.c ?? day?.close ?? root?.close ?? root?.dayClose) ?? null;
  const prevClose = n(prev?.c ?? prev?.close ?? root?.prevClose ?? root?.previousClose) ?? null;

  let price = lastTradePrice ?? dayClose ?? null;
  let open = n(day?.o ?? day?.open ?? root?.open) ?? null;
  let volume = n(day?.v ?? day?.volume ?? root?.volume ?? root?.dayVolume) ?? null;

  let pricePct =
    n(root?.todaysChangePerc) ??
    n(root?.todaysChangePercent) ??
    n(root?.changePerc) ??
    n(root?.changePercent) ??
    null;

  if (price === null) {
    const fp = findFirstNumberByKeys(root, ["price", "last", "lastprice", "last_price", "p", "c", "close"]);
    price = fp.value;
  }

  if (open === null) {
    const fo = findFirstNumberByKeys(root, ["open", "o"]);
    open = fo.value;
  }

  let prevC = prevClose;
  if (prevC === null) {
    const fpc = findFirstNumberByKeys(root, ["prevclose", "previousclose", "prev_close", "pc", "prevc"]);
    prevC = fpc.value;
  }

  if (volume === null) {
    const fv = findFirstNumberByKeys(root, ["volume", "v", "dayvolume", "day_volume"]);
    volume = fv.value;
  }

  if (pricePct === null) {
    const fchg = findFirstNumberByKeys(root, [
      "todayschangeperc",
      "todayschangepercent",
      "changepct",
      "changepercent",
      "pctchange",
      "percentchange",
    ]);
    pricePct = fchg.value;
  }

  if (pricePct === null && price !== null && prevC !== null && prevC > 0) {
    pricePct = ((price - prevC) / prevC) * 100;
  }

  const gapPct = open !== null && prevC !== null && prevC > 0 ? ((open - prevC) / prevC) * 100 : null;

  // Float
  let floatShares =
    n(root?.float) ??
    n(root?.freeFloat) ??
    n(root?.sharesFloat) ??
    n(root?.floatShares) ??
    null;

  if (floatShares === null) {
    const ff = findFirstNumberByKeys(root, [
      "float",
      "freefloat",
      "free_float",
      "sharesfloat",
      "floatshares",
      "publicfloat",
      "public_float",
    ]);
    floatShares = ff.value;
  }

  // Market cap
  let marketCap =
    n(root?.marketCap) ??
    n(root?.marketcap) ??
    n(root?.mktcap) ??
    n(root?.market_cap) ??
    n(root?.marketCapitalization) ??
    null;

  if (marketCap === null) {
    const mc = findFirstNumberByKeys(root, [
      "marketcap",
      "marketCap",
      "mktcap",
      "market_cap",
      "marketcapitalization",
      "marketCapitalization",
      "cap",
      "capitalization",
    ]);
    marketCap = mc.value;
  }

  return {
    symbol: String(ticker || "").trim().toUpperCase(),
    price: price !== null ? round2(price) : null,
    pricePct: pricePct !== null ? round2(pricePct) : null,
    gapPct: gapPct !== null ? round2(gapPct) : null,
    volume: volume !== null ? Math.round(volume) : null,

    floatShares: floatShares !== null ? Math.round(floatShares) : null,
    floatM: floatShares !== null ? round2(floatShares / 1_000_000) : null,
    floatCat: floatCategory(floatShares),

    marketCap: marketCap !== null ? Math.round(marketCap) : null,
    marketCapB: marketCap !== null ? round2(marketCap / 1_000_000_000) : null,
    cap: capCategory(marketCap),
  };
}

// ---------------- group + sorting ----------------
function groupToDirection(group) {
  if (group === "topLosers") return "losers";
  return "gainers";
}

function sortRowsByGroup(rows, group) {
  if (group === "topGappers") {
    rows.sort((a, b) => Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0));
    return;
  }
  rows.sort((a, b) => Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0));
}

function capPass(row, cap) {
  const c = String(cap || "all").toLowerCase();
  if (c === "all") return true;
  if (!row.cap) return false;
  return row.cap === c;
}

// ---------------- UI ----------------
function renderUI(preset = {}) {
  const presetGroup = preset.group || "topGainers";
  const presetCap = preset.cap || "all";
  const presetLimit = preset.limit || 50;
  const presetMinGap = preset.minGap ?? "";
  const presetSymbols = preset.symbols ?? "NVDA,TSLA,AAPL";
  const active = (path) => (preset.path === path ? "opacity:1" : "opacity:.65");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>ALGTP™ – Algorithmic Trading Platform Scanner</title>
  <style>
    :root { color-scheme: dark; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b0d12; color:#e6e8ef;}
    header { padding:16px 18px; border-bottom:1px solid rgba(255,255,255,.08); position:sticky; top:0; background:rgba(11,13,18,.92); backdrop-filter: blur(10px); z-index:20; }
    h1 { margin:0; font-size:16px; }
    .sub { margin-top:6px; font-size:12px; color:#a7adc2; }
    .wrap { max-width:1400px; margin:0 auto; }
    .panel { padding:14px 18px; border-bottom:1px solid rgba(255,255,255,.06); }
    .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    select, input, button { background:#121622; border:1px solid rgba(255,255,255,.12); color:#e6e8ef; border-radius:10px; padding:10px 12px; font-size:13px; outline:none; }
    input { min-width:220px; }
    button { cursor:pointer; }
    button:hover { border-color: rgba(255,255,255,.22); }
    .hint { font-size:12px; color:#a7adc2; margin-top:8px; }
    .badge { display:inline-flex; align-items:center; gap:8px; padding:6px 10px; border-radius:999px; background:#121622; border:1px solid rgba(255,255,255,.12); font-size:12px; color:#c8cde0; }
    .grid { padding:14px 18px; }
    .card { border:1px solid rgba(255,255,255,.10); border-radius:14px; overflow:hidden; }
    .cardHead { padding:10px 12px; display:flex; align-items:center; justify-content:space-between; background:#121622; border-bottom:1px solid rgba(255,255,255,.08); }
    .title { font-size:13px; font-weight:600; }
    .meta { font-size:12px; color:#a7adc2; }
    table { width:100%; border-collapse:collapse; }
    th, td { padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.06); font-size:13px; }
    th { text-align:left; color:#a7adc2; font-weight:600; }
    tr:hover td { background: rgba(255,255,255,.03); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .right { text-align:right; }
    .err { white-space:pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size:12px; color:#ffb4b4; background:#1a0f12; border:1px solid rgba(255,128,128,.25); border-radius:12px; padding:10px 12px; margin-top:12px; display:none; }
    .nav { display:flex; gap:10px; flex-wrap:wrap; margin-top:10px; }
    .nav a { text-decoration:none; color:#c8cde0; background:#121622; border:1px solid rgba(255,255,255,.12); padding:8px 10px; border-radius:999px; font-size:12px; }
    .nav a:hover { border-color: rgba(255,255,255,.22); }
    .watermark{ position: fixed; bottom: 12px; right: 16px; font-size: 11px; color: rgba(230,232,239,.35); letter-spacing: .3px; pointer-events: none; user-select: none; z-index: 9999; }
    .pill { display:inline-flex; align-items:center; gap:8px; padding:8px 10px; border-radius:999px; background:#121622; border:1px solid rgba(255,255,255,.12); font-size:12px; color:#c8cde0; }
    .pill input[type="checkbox"]{ transform: translateY(1px); }
    .symLink { color:#e6e8ef; text-decoration:none; border-bottom:1px dashed rgba(255,255,255,.25); cursor:pointer; }
    .symLink:hover { border-bottom-color: rgba(255,255,255,.55); }

    /* Modal */
    .modalBack { position:fixed; inset:0; background: rgba(0,0,0,.65); display:none; align-items:center; justify-content:center; z-index:50; }
    .modal { width:min(1100px, 94vw); height:min(720px, 88vh); background:#0b0d12; border:1px solid rgba(255,255,255,.16); border-radius:16px; overflow:hidden; box-shadow: 0 18px 70px rgba(0,0,0,.55); }
    .modalTop { display:flex; gap:10px; align-items:center; justify-content:space-between; padding:10px 12px; background:#121622; border-bottom:1px solid rgba(255,255,255,.10); }
    .modalTitle { font-weight:700; font-size:13px; }
    .modalTools { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .modalClose { cursor:pointer; border:1px solid rgba(255,255,255,.18); background:#121622; color:#e6e8ef; border-radius:10px; padding:8px 10px; }
    .modalClose:hover { border-color: rgba(255,255,255,.28); }
    .chartBox { width:100%; height: calc(100% - 52px); }
  </style>
</head>
<body>
<header>
  <div class="wrap">
    <h1>ALGTP™ – Algorithmic Trading Platform Scanner</h1>
    <div class="sub">Gainers • Losers • Gappers • Small/Mid/Big Cap • Alerts • Auto Refresh • Scan Symbols • Click ticker for chart</div>

    <div class="nav">
      <a href="/ui" style="${active("/ui")}">Dashboard</a>
      <a href="/ui/gainers" style="${active("/ui/gainers")}">Gainers</a>
      <a href="/ui/losers" style="${active("/ui/losers")}">Losers</a>
      <a href="/ui/gappers" style="${active("/ui/gappers")}">Gappers</a>
      <a href="/ui/smallcap" style="${active("/ui/smallcap")}">Small Cap</a>
      <a href="/ui/midcap" style="${active("/ui/midcap")}">Mid Cap</a>
      <a href="/ui/bigcap" style="${active("/ui/bigcap")}">Big Cap</a>
    </div>
  </div>
</header>

<div class="panel">
  <div class="wrap">
    <div class="row">
      <select id="mode">
        <option value="group" selected>Mode: Group</option>
        <option value="symbols">Mode: Symbols</option>
      </select>

      <input id="symbols" placeholder="Symbols (comma-separated): NVDA,TSLA,AAPL" />

      <select id="group">
        <option value="topGainers">Top Gainers</option>
        <option value="topLosers">Top Losers</option>
        <option value="topGappers">Top Gappers</option>
      </select>

      <select id="cap">
        <option value="all">Cap: All</option>
        <option value="small">Cap: Small (&lt;2B)</option>
        <option value="mid">Cap: Mid (2B–10B)</option>
        <option value="big">Cap: Big (&gt;10B)</option>
      </select>

      <select id="limit">
        <option>20</option><option>30</option><option>50</option><option>100</option><option>150</option>
      </select>

      <input id="minGap" placeholder="minGap% (only for Gappers, ex: 10)" />

      <button id="runBtn">Run</button>
      <button id="notifyBtn">Enable Notifications</button>

      <span class="badge" id="statusBadge">Idle</span>
    </div>

    <div class="row" style="margin-top:10px;">
      <span class="pill"><input id="alertsOn" type="checkbox" checked /> Alerts</span>
      <span class="pill"><input id="soundOn" type="checkbox" checked /> Sound</span>
      <span class="pill"><input id="desktopOn" type="checkbox" checked /> Desktop</span>

      <input id="alertScore" placeholder="Alert score >= (default 4)" style="min-width:180px;" />
      <input id="alertGap" placeholder="Alert gap% >= (default 20)" style="min-width:180px;" />
      <input id="alertPrice" placeholder="Alert price% >= (default 20)" style="min-width:200px;" />

      <button id="clearAlertsBtn">Clear Alert Memory</button>
    </div>

    <div class="row" style="margin-top:10px;">
      <span class="pill"><input id="autoOn" type="checkbox" /> Auto Refresh</span>
      <input id="autoSec" placeholder="Refresh seconds (default 30)" style="min-width:200px;" />
      <span class="badge" id="countdownBadge">-</span>
      <button id="applyAutoBtn">Apply</button>
      <button id="stopAutoBtn">Stop</button>
    </div>

    <div class="hint">
      Click any ticker to open a TradingView chart. If a symbol does not load, switch exchange in the chart (NASDAQ/NYSE/AMEX).
    </div>

    <div class="err" id="errBox"></div>
  </div>
</div>

<div class="grid">
  <div class="wrap" id="out"></div>
</div>

<div class="watermark">Powered by ALGTP™</div>

<!-- Chart Modal -->
<div class="modalBack" id="modalBack" aria-hidden="true">
  <div class="modal" role="dialog" aria-modal="true">
    <div class="modalTop">
      <div class="modalTitle" id="modalTitle">Chart</div>
      <div class="modalTools">
        <select id="exSel">
          <option value="NASDAQ">NASDAQ</option>
          <option value="NYSE">NYSE</option>
          <option value="AMEX">AMEX</option>
        </select>
        <select id="tfSel">
          <option value="1">1m</option>
          <option value="5" selected>5m</option>
          <option value="15">15m</option>
          <option value="60">1h</option>
          <option value="240">4h</option>
          <option value="D">1D</option>
          <option value="W">1W</option>
        </select>
        <button class="modalClose" id="closeBtn">Close</button>
      </div>
    </div>
    <div class="chartBox" id="chartBox"></div>
  </div>
</div>

<script src="https://s3.tradingview.com/tv.js"></script>

<script>
const PRESET = ${JSON.stringify({
    group: presetGroup,
    cap: presetCap,
    limit: presetLimit,
    minGap: presetMinGap,
    symbols: presetSymbols,
  })};

const byId = (id) => document.getElementById(id);
const out = byId("out");
const errBox = byId("errBox");
const statusBadge = byId("statusBadge");
const countdownBadge = byId("countdownBadge");

function setStatus(t){ statusBadge.textContent = t; }
function showError(obj){
  errBox.style.display = "block";
  errBox.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}
function clearError(){ errBox.style.display = "none"; errBox.textContent = ""; }

function fmtNum(x, digits=2){
  if (x === null || x === undefined) return "-";
  const nn = Number(x);
  if (!Number.isFinite(nn)) return "-";
  return nn.toFixed(digits);
}
function fmtInt(x){
  if (x === null || x === undefined) return "-";
  const nn = Number(x);
  if (!Number.isFinite(nn)) return "-";
  return Math.round(nn).toLocaleString();
}

// -------- Alerts --------
const alerted = new Set();
function toNumOrDefault(val, def){
  const v = Number(String(val ?? "").trim());
  return Number.isFinite(v) ? v : def;
}
function beep(){
  try{
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.value = 0.05;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(()=>{ o.stop(); ctx.close(); }, 160);
  }catch(e){}
}
function pushNotification(title, body){
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try{ new Notification(title, { body }); }catch(e){}
}
function getAlertCfg(){
  return {
    alertsOn: byId("alertsOn").checked,
    soundOn: byId("soundOn").checked,
    desktopOn: byId("desktopOn").checked,
    scoreTh: toNumOrDefault(byId("alertScore").value, 4),
    gapTh: toNumOrDefault(byId("alertGap").value, 20),
    priceTh: toNumOrDefault(byId("alertPrice").value, 20),
  };
}
function shouldAlertRow(r, cfg){
  if (!cfg.alertsOn) return false;
  if (!r || !r.symbol) return false;
  if (alerted.has(r.symbol)) return false;
  const score = Number(r.demandScore ?? 0);
  const gap = Number(r.gapPct ?? 0);
  const pc = Number(r.pricePct ?? 0);
  return (score >= cfg.scoreTh) || (gap >= cfg.gapTh) || (pc >= cfg.priceTh);
}
function fireAlert(r, cfg){
  alerted.add(r.symbol);
  const parts = [];
  if (r.pricePct != null) parts.push(\`Price%: \${r.pricePct}%\`);
  if (r.gapPct != null) parts.push(\`Gap%: \${r.gapPct}%\`);
  if (r.floatM != null) parts.push(\`Float(M): \${r.floatM}\`);
  if (r.marketCapB != null) parts.push(\`MCap(B): \${r.marketCapB}\`);
  const body = parts.join(" | ") || "Signal";
  if (cfg.soundOn) beep();
  if (cfg.desktopOn) pushNotification(\`\${r.signalIcon || ""} \${r.symbol}\`, body);
}
function runAlerts(data){
  const cfg = getAlertCfg();
  const rows = Array.isArray(data.results) ? data.results : [];
  for (const r of rows){
    if (shouldAlertRow(r, cfg)) fireAlert(r, cfg);
  }
}
async function enableNotifications(){
  if (!("Notification" in window)){
    alert("Notifications are not supported in this browser.");
    return;
  }
  const p = await Notification.requestPermission();
  if (p === "granted") {
    try { new Notification("ALGTP™ Alerts enabled", { body: "Desktop notifications are ON." }); } catch(e){}
  } else {
    alert("Notification permission not granted.");
  }
}

// -------- Chart Modal (click ticker) --------
const modalBack = byId("modalBack");
const modalTitle = byId("modalTitle");
const chartBox = byId("chartBox");
const exSel = byId("exSel");
const tfSel = byId("tfSel");
let currentSymbol = null;

function openModal(){
  modalBack.style.display = "flex";
  modalBack.setAttribute("aria-hidden", "false");
}
function closeModal(){
  modalBack.style.display = "none";
  modalBack.setAttribute("aria-hidden", "true");
  chartBox.innerHTML = "";
  currentSymbol = null;
}
function buildTvSymbol(sym){
  const ex = exSel.value || "NASDAQ";
  return ex + ":" + sym;
}
function renderChart(sym){
  if (!window.TradingView || !window.TradingView.widget){
    alert("TradingView library failed to load.");
    return;
  }
  chartBox.innerHTML = '<div id="tv_chart" style="width:100%;height:100%;"></div>';
  const tvSymbol = buildTvSymbol(sym);
  const interval = tfSel.value || "5";

  try{
    new TradingView.widget({
      autosize: true,
      symbol: tvSymbol,
      interval: interval,
      timezone: "America/New_York",
      theme: "dark",
      style: "1",
      locale: "en",
      enable_publishing: false,
      allow_symbol_change: true,
      container_id: "tv_chart"
    });
  }catch(e){
    alert(String(e?.message || e));
  }
}
function openChart(sym){
  currentSymbol = sym;
  modalTitle.textContent = "Chart — " + sym;
  openModal();
  renderChart(sym);
}

byId("closeBtn").addEventListener("click", closeModal);
modalBack.addEventListener("click", (e)=>{ if (e.target === modalBack) closeModal(); });
document.addEventListener("keydown", (e)=>{ if (e.key === "Escape") closeModal(); });

exSel.addEventListener("change", ()=>{ if (currentSymbol) renderChart(currentSymbol); });
tfSel.addEventListener("change", ()=>{ if (currentSymbol) renderChart(currentSymbol); });

// -------- Render Table --------
function renderList(data){
  const rows = Array.isArray(data.results) ? data.results : [];
  const titleRight = data.mode === "symbols"
    ? \`Symbols • \${rows.length} rows\`
    : \`\${data.group} • cap=\${data.cap} • \${rows.length} rows\`;

  out.innerHTML = \`
    <div class="card">
      <div class="cardHead">
        <div class="title">\${data.mode === "symbols" ? "Scan Symbols" : "Scan Group"}</div>
        <div class="meta">\${titleRight}</div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Icon</th>
            <th>Symbol</th>
            <th class="right">Price</th>
            <th class="right">Price%</th>
            <th class="right">Gap%</th>
            <th class="right">Vol</th>
            <th class="right">Float(M)</th>
            <th>FloatCat</th>
            <th class="right">MCap(B)</th>
            <th>Cap</th>
            <th class="right">Score</th>
          </tr>
        </thead>
        <tbody>
          \${rows.map(r => \`
            <tr>
              <td>\${r.signalIcon || ""}</td>
              <td class="mono">
                <a class="symLink" href="javascript:void(0)" onclick="openChart('\${String(r.symbol||"").replace(/'/g,"") }')">\${r.symbol || ""}</a>
              </td>
              <td class="right mono">\${fmtNum(r.price)}</td>
              <td class="right mono">\${fmtNum(r.pricePct)}%</td>
              <td class="right mono">\${fmtNum(r.gapPct)}%</td>
              <td class="right mono">\${fmtInt(r.volume)}</td>
              <td class="right mono">\${fmtNum(r.floatM)}</td>
              <td>\${r.floatCat || "-"}</td>
              <td class="right mono">\${fmtNum(r.marketCapB)}</td>
              <td>\${r.cap || "-"}</td>
              <td class="right mono">\${r.demandScore ?? "-"}</td>
            </tr>
          \`).join("")}
        </tbody>
      </table>
    </div>
  \`;
}

// -------- Auto Refresh --------
let autoTimer = null;
let countdownTimer = null;
let countdown = 0;

function stopAuto(){
  if (autoTimer) clearInterval(autoTimer);
  if (countdownTimer) clearInterval(countdownTimer);
  autoTimer = null;
  countdownTimer = null;
  countdown = 0;
  countdownBadge.textContent = "-";
  byId("autoOn").checked = false;
}

function startAuto(seconds){
  stopAuto();
  byId("autoOn").checked = true;

  countdown = seconds;
  countdownBadge.textContent = \`Next refresh in \${countdown}s\`;

  countdownTimer = setInterval(()=>{
    countdown -= 1;
    if (countdown <= 0) countdown = seconds;
    countdownBadge.textContent = \`Next refresh in \${countdown}s\`;
  }, 1000);

  autoTimer = setInterval(()=>{ run(); }, seconds * 1000);
}

function applyAuto(){
  const on = byId("autoOn").checked;
  const sec = toNumOrDefault(byId("autoSec").value, 30);
  const safeSec = Math.max(5, Math.min(3600, sec));
  if (!on) { stopAuto(); return; }
  startAuto(safeSec);
}

// -------- Run (Mode aware) --------
async function run(){
  clearError();
  out.innerHTML = "";
  setStatus("Loading...");

  const mode = byId("mode").value;
  let url = "";

  if (mode === "symbols"){
    const symbols = byId("symbols").value.trim() || "NVDA,TSLA,AAPL";
    url = \`/scan?symbols=\${encodeURIComponent(symbols)}\`;
  } else {
    const group = byId("group").value;
    const cap = byId("cap").value;
    const limit = byId("limit").value;
    const minGap = byId("minGap").value.trim();

    url = \`/list?group=\${encodeURIComponent(group)}&cap=\${encodeURIComponent(cap)}&limit=\${encodeURIComponent(limit)}\`;
    if (minGap) url += \`&minGap=\${encodeURIComponent(minGap)}\`;
  }

  try{
    const r = await fetch(url);
    const data = await r.json();
    if (!data.ok){
      setStatus("Error");
      showError(data);
      return;
    }
    setStatus(\`OK (\${data.results.length} rows)\`);
    renderList(data);
    runAlerts(data);

    if (data.snapshotErrors && data.snapshotErrors.length){
      showError({ snapshotErrors: data.snapshotErrors });
    }
  }catch(e){
    setStatus("Error");
    showError(String(e?.message || e));
  }
}

function setPreset(){
  byId("group").value = PRESET.group;
  byId("cap").value = PRESET.cap;
  byId("limit").value = String(PRESET.limit);
  byId("minGap").value = PRESET.minGap ?? "";
  byId("symbols").value = PRESET.symbols ?? "NVDA,TSLA,AAPL";

  byId("alertScore").value = "4";
  byId("alertGap").value = "20";
  byId("alertPrice").value = "20";

  byId("autoSec").value = "30";
  countdownBadge.textContent = "-";
}

byId("runBtn").addEventListener("click", run);
byId("notifyBtn").addEventListener("click", enableNotifications);
byId("clearAlertsBtn").addEventListener("click", ()=>{
  alerted.clear();
  alert("Alert memory cleared.");
});

byId("applyAutoBtn").addEventListener("click", applyAuto);
byId("stopAutoBtn").addEventListener("click", stopAuto);

byId("mode").addEventListener("change", ()=>{ stopAuto(); });

setPreset();
run();
</script>
</body>
</html>`;
}

// ---------------- UI routes ----------------
app.get("/ui", (req, res) => res.type("html").send(renderUI({ path: "/ui", group: "topGainers", cap: "all", limit: 50 })));
app.get("/ui/gainers", (req, res) =>
  res.type("html").send(renderUI({ path: "/ui/gainers", group: "topGainers", cap: "all", limit: 50 }))
);
app.get("/ui/losers", (req, res) =>
  res.type("html").send(renderUI({ path: "/ui/losers", group: "topLosers", cap: "all", limit: 50 }))
);
app.get("/ui/gappers", (req, res) =>
  res.type("html").send(renderUI({ path: "/ui/gappers", group: "topGappers", cap: "all", limit: 80, minGap: 10 }))
);
app.get("/ui/smallcap", (req, res) =>
  res.type("html").send(renderUI({ path: "/ui/smallcap", group: "topGainers", cap: "small", limit: 80 }))
);
app.get("/ui/midcap", (req, res) =>
  res.type("html").send(renderUI({ path: "/ui/midcap", group: "topGainers", cap: "mid", limit: 80 }))
);
app.get("/ui/bigcap", (req, res) =>
  res.type("html").send(renderUI({ path: "/ui/bigcap", group: "topGainers", cap: "big", limit: 80 }))
);

// ---------------- API routes ----------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "ALGTP™ – Algorithmic Trading Platform Scanner running ✅",
    ui: "/ui",
    pages: ["/ui", "/ui/gainers", "/ui/losers", "/ui/gappers", "/ui/smallcap", "/ui/midcap", "/ui/bigcap"],
    examples: ["/list?group=topGappers&limit=80&cap=all&minGap=10", "/scan?symbols=NVDA,TSLA,AAPL"],
  });
});

app.get("/api", (req, res) => {
  res.json({
    ok: true,
    envMissing: envMissing(),
    config: {
      port: PORT,
      authType: MASSIVE_AUTH_TYPE,
      queryKeyName: MASSIVE_QUERY_KEYNAME,
      moverUrl: MASSIVE_MOVER_URL,
      tickerSnapshotUrl: MASSIVE_TICKER_SNAPSHOT_URL,
      includeOtc: INCLUDE_OTC,
      snapConcurrency: SNAP_CONCURRENCY,
      debug: DEBUG,
    },
  });
});

app.get("/env", (req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(MASSIVE_API_KEY),
    authType: MASSIVE_AUTH_TYPE,
    queryKeyName: MASSIVE_QUERY_KEYNAME,
    moverBase: MASSIVE_MOVER_URL,
    tickerBase: MASSIVE_TICKER_SNAPSHOT_URL,
  });
});

// Symbols scan endpoint (for TSLA/NVDA anytime)
app.get("/scan", async (req, res) => {
  try {
    const miss = envMissing();
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const symbols = parseSymbols(req.query.symbols || "NVDA,TSLA,AAPL").slice(0, 100);

    const snaps = await mapPool(symbols, SNAP_CONCURRENCY, async (t) => {
      const r = await fetchTickerSnapshot(t);
      return { ticker: t, ...r };
    });

    const good = snaps.filter((x) => x.ok);
    const bad = snaps.filter((x) => !x.ok);

    let rows = good.map((x) => normalizeSnapshotAuto(x.ticker, x.data));
    rows = rows.map((r) => {
      const d = demandScore(r);
      return { ...r, demandScore: d, signalIcon: signalIcon(d) };
    });

    rows.sort(
      (a, b) =>
        (b.demandScore ?? 0) - (a.demandScore ?? 0) ||
        Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0)
    );

    res.json({
      ok: true,
      mode: "symbols",
      results: rows,
      snapshotErrors: DEBUG
        ? bad.slice(0, 10).map((x) => ({ ticker: x.ticker, status: x.status, url: x.url, errorDetail: x.errorDetail }))
        : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Scan failed", detail: String(e?.message || e) });
  }
});

// Group list endpoint
app.get("/list", async (req, res) => {
  try {
    const miss = envMissing();
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const group = String(req.query.group || "topGainers").trim();
    const cap = String(req.query.cap || "all").trim().toLowerCase();
    const limit = clamp(Number(req.query.limit || 50), 5, 200);
    const minGap = n(req.query.minGap);

    const direction = groupToDirection(group);
    const movers = await fetchMovers(direction);
    if (!movers.ok) return res.status(500).json({ ok: false, error: "Movers failed", moverDebug: movers });

    const tickers = movers.rows
      .map((x) => String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase())
      .filter(Boolean)
      .slice(0, limit);

    const snaps = await mapPool(tickers, SNAP_CONCURRENCY, async (t) => {
      const r = await fetchTickerSnapshot(t);
      return { ticker: t, ...r };
    });

    const good = snaps.filter((x) => x.ok);
    const bad = snaps.filter((x) => !x.ok);

    let rows = good.map((x) => normalizeSnapshotAuto(x.ticker, x.data));
    rows = rows.map((r) => {
      const d = demandScore(r);
      return { ...r, demandScore: d, signalIcon: signalIcon(d) };
    });

    rows = rows.filter((r) => capPass(r, cap));

    if (minGap !== null && Number.isFinite(minGap)) {
      rows = rows.filter((r) => (r.gapPct ?? 0) >= minGap);
    }

    sortRowsByGroup(rows, group);

    res.json({
      ok: true,
      mode: "group",
      group,
      cap,
      limitRequested: limit,
      results: rows,
      snapshotErrors: DEBUG
        ? bad.slice(0, 10).map((x) => ({ ticker: x.ticker, status: x.status, url: x.url, errorDetail: x.errorDetail }))
        : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "List failed", detail: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ ALGTP™ Scanner running http://localhost:${PORT}`);
  console.log(`🚀 UI: http://localhost:${PORT}/ui`);
  console.log(`🔎 Symbols scan: /scan?symbols=NVDA,TSLA,AAPL`);
});
