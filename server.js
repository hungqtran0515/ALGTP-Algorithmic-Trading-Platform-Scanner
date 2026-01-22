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
      const ownerId = uuid();
      const exp = nowMs() + 3650 * 24 * 60 * 60 * 1000;
      db.prepare(
        `INSERT INTO users (id, phone, email, pin_hash, pin_lookup, role, plan, plan_expires_at, status, phone_verified, created_at)
         VALUES (?, ?, ?, NULL, NULL, 'owner', 'vip', ?, 'active', 1, ?)`
      ).run(ownerId, ownerPhone, ownerEmail, exp, nowMs());
      owner = db.prepare("SELECT * FROM users WHERE id=?").get(ownerId);
      audit("owner_created", ownerId, {});
    }

    const { sessionId } = createOrRefreshSession({
      userId: owner.id,
      deviceId,
      userPlan: "vip",
    });

    setSessionCookie(res, sessionId);
    audit("owner_unlock", owner.id, { deviceId });

    ipClear(ip);
    return res.json({ ok: true, role: "owner", plan: owner.plan, plan_expires_at: owner.plan_expires_at });
  }

  // Normal PIN lookup using pin_lookup
  const lookup = pinLookup(code);
  const c = db
    .prepare("SELECT * FROM users WHERE pin_lookup=? AND status='active' LIMIT 1")
    .get(lookup);

  if (!c || !c.pin_hash) return res.status(401).json({ ok: false, error: "INVALID_CODE" });

  const ok = await bcrypt.compare(code, c.pin_hash);
  if (!ok) return res.status(401).json({ ok: false, error: "INVALID_CODE" });

  const { sessionId, kicked } = createOrRefreshSession({
    userId: c.id,
    deviceId,
    userPlan: c.plan,
  });

  setSessionCookie(res, sessionId);
  audit("pin_unlock_ok", c.id, { deviceId, kicked });

  ipClear(ip);
  return res.json({
    ok: true,
    role: c.role,
    plan: c.plan,
    plan_expires_at: c.plan_expires_at,
    kicked,
    expired: isExpired(c),
  });
});

// Set/change PIN (must be logged in) + CSRF guard
app.post("/auth/pin/set", requireAuth, requireSameOrigin, async (req, res) => {
  const pin = normalizePin(req.body.pin);
  if (!is8CharCode(pin)) return res.status(400).json({ ok: false, error: "PIN_MUST_BE_8" });

  const hash = await bcrypt.hash(pin, 10);
  const lookup = pinLookup(pin);
  db.prepare("UPDATE users SET pin_hash=?, pin_lookup=? WHERE id=?").run(hash, lookup, req.user_db.id);

  audit("pin_set", req.user_db.id, {});
  res.json({ ok: true });
});

// Auth info
app.get("/auth/me", requireAuth, (req, res) => {
  const u = req.user_db;
  res.json({
    ok: true,
    id: u.id,
    phone: u.phone,
    email: u.email,
    role: u.role,
    plan: u.plan,
    plan_expires_at: Number(u.plan_expires_at || 0),
    expired: isExpired(u),
    devices_allowed: planMaxDevices(u.plan),
  });
});

// Logout + CSRF guard
app.post("/auth/logout", requireSameOrigin, (req, res) => {
  const sid = req.cookies.algtp_sess;
  if (sid) {
    try {
      db.prepare("DELETE FROM sessions WHERE id=?").run(sid);
    } catch {}
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

// -----------------------------------------------------------------------------
// Admin: grant plan (manual) — owner only
// -----------------------------------------------------------------------------
function extendPlan(userId, plan, days) {
  const now = nowMs();
  const u = db.prepare("SELECT plan_expires_at FROM users WHERE id=?").get(userId);
  const base = u?.plan_expires_at && Number(u.plan_expires_at) > now ? Number(u.plan_expires_at) : now;
  const exp = base + Number(days) * 24 * 60 * 60 * 1000;

  db.prepare("UPDATE users SET plan=?, plan_expires_at=? WHERE id=?").run(plan, exp, userId);
  return exp;
}

app.post("/admin/grant_me", requireAuth, requireOwner, requireSameOrigin, (req, res) => {
  const plan = String(req.body.plan || "pro").toLowerCase();
  const days = Math.max(1, Number(req.body.days || 30));
  if (!["pro", "vip"].includes(plan)) return res.status(400).json({ ok: false, error: "BAD_PLAN" });

  const exp = extendPlan(req.user_db.id, plan, days);
  audit("grant_me", req.user_db.id, { plan, days, new_exp: exp });

  res.json({ ok: true, plan, plan_expires_at: exp });
});

app.post("/admin/grant_user", requireAuth, requireOwner, requireSameOrigin, (req, res) => {
  const userId = String(req.body.user_id || "").trim();
  const plan = String(req.body.plan || "pro").toLowerCase();
  const days = Math.max(1, Number(req.body.days || 30));
  if (!userId) return res.status(400).json({ ok: false, error: "MISSING_USER_ID" });
  if (!["pro", "vip"].includes(plan)) return res.status(400).json({ ok: false, error: "BAD_PLAN" });

  const u = db.prepare("SELECT id FROM users WHERE id=?").get(userId);
  if (!u) return res.status(404).json({ ok: false, error: "USER_NOT_FOUND" });

  const exp = extendPlan(userId, plan, days);
  audit("grant_user", req.user_db.id, { target: userId, plan, days, new_exp: exp });

  res.json({ ok: true, user_id: userId, plan, plan_expires_at: exp });
});

// -----------------------------------------------------------------------------
// Example paid API (blocked when expired)
// -----------------------------------------------------------------------------
app.post("/api/scan_demo", requireAuth, blockExpiredAPI, (req, res) => {
  res.json({ ok: true, message: "Scan executed (demo).", at: new Date().toISOString() });
});

// -----------------------------------------------------------------------------
// Cleanup job (sessions / audit / otps)
// -----------------------------------------------------------------------------
function cleanup() {
  const now = nowMs();
  try {
    db.prepare("DELETE FROM sessions WHERE last_seen < ?").run(now - 90 * 24 * 60 * 60 * 1000);
  } catch {}
  try {
    db.prepare("DELETE FROM otps WHERE exp < ?").run(now - 60 * 60 * 1000);
  } catch {}
  try {
    db.prepare("DELETE FROM audit_log WHERE at < ?").run(now - 180 * 24 * 60 * 60 * 1000);
  } catch {}
}
cleanup();
setInterval(cleanup, 12 * 60 * 60 * 1000);

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`ALGTP™ SaaS server running on http://localhost:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Trial days: ${TRIAL_DAYS}`);
  console.log(`Owner code set: ${OWNER_CODE ? "YES" : "NO"}`);
});
