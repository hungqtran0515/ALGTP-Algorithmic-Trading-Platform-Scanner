// =========================
// ALGTP SERVER (CLEAN BUILD)
// - No duplicate PORT
// - No duplicate functions
// - No raw HTML/CSS outside template strings
// - Works on Render + Custom domain
// =========================

// =========================
// ALGTP SERVER (CLEAN BUILD)
// - Clerk Google/Facebook (primary)
// - Twilio OTP (fallback)
// - Trial/Paid gate (users.json)
// - Works on Render
// =========================

// dotenv OPTIONAL on Render (Render already provides ENV)
try {
  require("dotenv").config();
} catch (_) {}

const express = require("express");
const axios = require("axios");
const twilio = require("twilio");
const fs = require("fs");
const path = require("path");

// IMPORTANT: install with terminal (NOT inside code):
// npm i @clerk/express
const { clerkMiddleware, getAuth } = require("@clerk/express");

const app = express();
app.use(express.json());

// If you are behind Render/Proxy and later use secure cookies:
// app.set("trust proxy", 1);

// =========================
// BASIC
// =========================
const PORT = Number(process.env.PORT || 3000);

// =========================
// AUTH (CLERK) — GOOGLE / FACEBOOK
// =========================
const CLERK_PUBLISHABLE_KEY = String(process.env.CLERK_PUBLISHABLE_KEY || "").trim();
const CLERK_SECRET_KEY = String(process.env.CLERK_SECRET_KEY || "").trim();

const hasClerk = Boolean(CLERK_PUBLISHABLE_KEY && CLERK_SECRET_KEY);

if (!hasClerk) {
  console.log("⚠️ Clerk disabled. Missing CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY");
} else {
  console.log("✅ Clerk enabled (Google / Facebook)");
  // Must be AFTER express.json()
  app.use(clerkMiddleware());
}

// =========================
// OTP (Twilio) ENV — FALLBACK
// =========================
const TWILIO_ACCOUNT_SID = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = String(process.env.TWILIO_AUTH_TOKEN || "").trim();

const TWILIO_FROM = String(process.env.TWILIO_FROM || "")
  .trim()
  .replace(/[^\d+]/g, "");

const OTP_TTL_SEC = Math.max(60, Number(process.env.OTP_TTL_SEC || 300));
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "false").toLowerCase() === "true";

function isE164(s) {
  return /^\+\d{10,15}$/.test(String(s || ""));
}

const hasTwilio = Boolean(
  TWILIO_ACCOUNT_SID &&
    TWILIO_AUTH_TOKEN &&
    TWILIO_FROM &&
    isE164(TWILIO_FROM)
);

if (!hasTwilio) {
  const miss = [];
  if (!TWILIO_ACCOUNT_SID) miss.push("TWILIO_ACCOUNT_SID");
  if (!TWILIO_AUTH_TOKEN) miss.push("TWILIO_AUTH_TOKEN");
  if (!TWILIO_FROM) miss.push("TWILIO_FROM");
  if (TWILIO_FROM && !isE164(TWILIO_FROM)) miss.push("TWILIO_FROM(not E.164)");
  console.log("⚠️ Twilio disabled. Missing/invalid:", miss.join(", ") || "(unknown)");
} else {
  console.log("✅ Twilio enabled. FROM =", TWILIO_FROM);
}

const tw = hasTwilio ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

// =========================
// OTP STORE + HELPERS (RAM)
// =========================
const otpStore = new Map(); // phone -> { otp, expMs }

function nowMs() {
  return Date.now();
}

function cleanupOtp() {
  const t = nowMs();
  for (const [phone, rec] of otpStore.entries()) {
    if (!rec || rec.expMs <= t) otpStore.delete(phone);
  }
}

// =========================
// COOKIE HELPERS (NO LIB)
// =========================
function parseCookie(req) {
  const raw = req.headers?.cookie || "";
  const out = {};
  raw.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function setCookie(res, name, value, maxAgeSec) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Number(maxAgeSec || 0))}`,
    "HttpOnly",
  ];
  if (COOKIE_SECURE) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

// =========================
// PHONE NORMALIZE (US -> E.164)
// =========================
function normalizePhone(input) {
  let s = String(input || "").trim();
  if (!s) return null;

  s = s.replace(/[^\d+]/g, "");

  if (s.startsWith("+")) {
    const d = s.slice(1).replace(/\D/g, "");
    if (d.length === 11 && d.startsWith("1")) return "+" + d;
    if (d.length === 10) return "+1" + d;
    return null;
  }

  const d = s.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  if (d.length === 10) return "+1" + d;

  return null;
}

// =========================
// HTML HELPERS (LOGIN + PAYWALL)
// =========================
function fmtDate(ms) {
  try {
    return new Date(ms).toLocaleString("en-US");
  } catch {
    return "-";
  }
}

// Clerk login page (Google/Facebook)
function renderLoginPageClerk() {
  if (!CLERK_PUBLISHABLE_KEY) return "<h2>Clerk not configured</h2>";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>ALGTP Login</title>

  <script async crossorigin="anonymous"
    data-clerk-publishable-key="${CLERK_PUBLISHABLE_KEY}"
    src="https://js.clerk.com/v4/clerk.browser.js">
  </script>

  <style>
    :root{color-scheme:dark}
    body{margin:0;background:#0b0d12;color:#e6e8ef;font-family:system-ui}
    .box{max-width:560px;margin:10vh auto;padding:24px;border-radius:18px;border:1px solid rgba(255,255,255,.14);background:rgba(18,24,43,.55)}
    .muted{opacity:.8;font-size:12px;margin-top:10px;text-align:center}
  </style>
</head>
<body>
  <div class="box">
    <h2 style="text-align:center;margin:0 0 14px;">🔐 Login with Google / Facebook</h2>
    <div id="clerk-signin"></div>
    <div class="muted">After sign-in you will be redirected to /ui</div>
  </div>

  <script>
    window.addEventListener("load", async () => {
      await Clerk.load();
      Clerk.mountSignIn(document.getElementById("clerk-signin"), {
        afterSignInUrl: "/ui",
        afterSignUpUrl: "/ui"
      });
    });
  </script>
</body>
</html>`;
}

// OTP login page (fallback)
function renderLoginPage(msg = "") {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>ALGTP Login</title>
  <style>
    :root{color-scheme:dark}
    body{margin:0;background:#0b0d12;color:#e6e8ef;font-family:system-ui}
    .box{max-width:560px;margin:10vh auto;padding:24px;border-radius:18px;border:1px solid rgba(255,255,255,.14);background:rgba(18,24,43,.55)}
    input,button{width:100%;box-sizing:border-box;background:#121622;border:1px solid rgba(255,255,255,.12);color:#e6e8ef;border-radius:12px;padding:12px;font-size:14px}
    button{cursor:pointer;margin-top:10px;font-weight:600}
    .err{margin-top:10px;color:#ffb4b4;font-size:13px}
    .mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;opacity:.75;text-align:center;margin-bottom:8px}
  </style>
</head>
<body>
  <div class="box">
    <h2 style="margin:0 0 10px;text-align:center;">🔐 Login (SMS OTP)</h2>
    <div class="mono">Format: 12199868683 · 2199868683 · +12199868683</div>
    ${msg ? `<div class="err">${msg}</div>` : ""}

    <input id="phone" placeholder="Phone number" />
    <button onclick="startOtp()">Send OTP</button>

    <input id="otp" placeholder="OTP 6 digits" style="margin-top:12px;" />
    <button onclick="verifyOtp()">Verify</button>
  </div>

  <script>
    async function startOtp(){
      const phone=document.getElementById("phone").value.trim();
      const r=await fetch("/auth/start",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({phone})
      });
      const d=await r.json();
      if(!d.ok) alert(d.error||"failed");
      else alert("OTP sent");
    }
    async function verifyOtp(){
      const phone=document.getElementById("phone").value.trim();
      const otp=document.getElementById("otp").value.trim();
      const r=await fetch("/auth/verify",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({phone,otp})
      });
      const d=await r.json();
      if(!d.ok) alert(d.error||"failed");
      else location.href="/ui";
    }
  </script>
</body>
</html>`;
}

function renderPaywallPage(access) {
  const until = access?.until || access?.user?.paid_end || access?.user?.trial_end || 0;

  return `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ALGTP Paywall</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0b0d12;color:#e6e8ef;font-family:system-ui;padding:24px}
.box{max-width:720px;margin:8vh auto;padding:18px;border-radius:14px;border:1px solid rgba(255,255,255,.14);background:rgba(18,24,43,.55)}
.btn{display:inline-block;background:#121622;border:1px solid rgba(255,255,255,.16);color:#e6e8ef;border-radius:10px;padding:10px 12px;text-decoration:none}
.btn:hover{border-color:rgba(255,255,255,.28)}
.muted{opacity:.85;line-height:1.7}
</style></head><body>
<div class="box">
  <h2 style="margin:0 0 8px;">⛔ Access Locked</h2>
  <div class="muted">
    Reason: <b>${access?.reason || "EXPIRED"}</b><br/>
    Expired at: <b>${fmtDate(until)}</b>
  </div>
  <div style="margin-top:14px;">
    <a class="btn" href="/pricing">View Pricing</a>
    <a class="btn" href="/login" style="margin-left:8px;">Login</a>
  </div>
</div>
</body></html>`;
}

// =========================
// TRIAL + PAID STORE (users.json)
// NOTE: currently keyed by "phone OR clerk userId"
// =========================
const USERS_FILE = process.env.USERS_FILE || path.join(__dirname, "users.json");
const TRIAL_DAYS = Math.max(1, Number(process.env.TRIAL_DAYS || 14));
const PAID_DAYS = Math.max(1, Number(process.env.PAID_DAYS || 30));

const STRIPE_PAYMENT_LINK =
  process.env.STRIPE_PAYMENT_LINK ||
  "https://buy.stripe.com/aFa6oI5yy6Mn2KP49bco000";

function dayMs(d) {
  return d * 24 * 60 * 60 * 1000;
}

function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return {};
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const obj = JSON.parse(raw || "{}");
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function saveUsers(obj) {
  const tmp = USERS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, USERS_FILE);
}

function ensureUserTrial(key) {
  const users = loadUsers();
  const now = Date.now();

  if (!users[key]) {
    users[key] = {
      trial_start: now,
      trial_end: now + dayMs(TRIAL_DAYS),
      paid_start: 0,
      paid_end: 0,
      source: "TRIAL",
      updated_at: now,
    };
    saveUsers(users);
  }
  return users[key];
}

function grantPaid30Days(key, source = "STRIPE") {
  const users = loadUsers();
  const now = Date.now();

  if (!users[key]) {
    users[key] = {
      trial_start: now,
      trial_end: now + dayMs(TRIAL_DAYS),
      paid_start: now,
      paid_end: now + dayMs(PAID_DAYS),
      source,
      updated_at: now,
    };
  } else {
    const curPaidEnd = Number(users[key].paid_end || 0);
    const base = curPaidEnd > now ? curPaidEnd : now;
    users[key].paid_start = users[key].paid_start || now;
    users[key].paid_end = base + dayMs(PAID_DAYS);
    users[key].source = source;
    users[key].updated_at = now;
  }

  saveUsers(users);
  return users[key];
}

function getAccess(key) {
  const users = loadUsers();
  const now = Date.now();
  const u = users[key] || null;
  if (!u) return { ok: false, reason: "NO_USER" };

  if (Number(u.paid_end || 0) > now) return { ok: true, tier: "PAID", until: u.paid_end, user: u };
  if (Number(u.trial_end || 0) > now) return { ok: true, tier: "TRIAL", until: u.trial_end, user: u };

  return { ok: false, reason: "EXPIRED", user: u, until: u.trial_end || u.paid_end || 0 };
}

// =========================
// PUBLIC ROUTES
// =========================
app.get("/", (req, res) => res.redirect(302, "/ui"));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "ALGTP™ – Server running ✅",
    ui: "/ui",
    examples: ["/login", "/list?group=topGappers&limit=80", "/scan?symbols=NVDA,TSLA,AAPL"],
  });
});

app.get("/login", (req, res) => {
  if (hasClerk) return res.type("html").send(renderLoginPageClerk());
  return res.type("html").send(renderLoginPage());
});

// =========================
// AUTH ROUTES (OTP) — fallback
// =========================
app.post("/auth/start", async (req, res) => {
  try {
    cleanupOtp();
    if (!hasTwilio || !tw) return res.status(500).json({ ok: false, error: "Twilio env missing/invalid" });

    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ ok: false, error: "Invalid phone" });

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    otpStore.set(phone, { otp, expMs: nowMs() + OTP_TTL_SEC * 1000 });

    await tw.messages.create({
      from: TWILIO_FROM,
      to: phone,
      body: `ALGTP OTP: ${otp} (exp ${Math.round(OTP_TTL_SEC / 60)}m)`,
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "send_failed", detail: String(e?.message || e) });
  }
});

app.post("/auth/verify", (req, res) => {
  cleanupOtp();

  const phone = normalizePhone(req.body?.phone);
  const otp = String(req.body?.otp || "").trim();

  if (!phone) return res.status(400).json({ ok: false, error: "Invalid phone" });
  if (!/^\d{6}$/.test(otp)) return res.status(400).json({ ok: false, error: "OTP must be 6 digits" });

  const rec = otpStore.get(phone);
  if (!rec) return res.status(401).json({ ok: false, error: "OTP expired/not found" });
  if (rec.expMs <= nowMs()) {
    otpStore.delete(phone);
    return res.status(401).json({ ok: false, error: "OTP expired" });
  }
  if (rec.otp !== otp) return res.status(401).json({ ok: false, error: "OTP wrong" });

  otpStore.delete(phone);

  ensureUserTrial(phone);
  setCookie(res, "algtp_phone", phone, 7 * 24 * 3600);

  res.json({ ok: true });
});

// Logout (GET so <a href="/logout"> works)
app.get("/logout", (req, res) => {
  setCookie(res, "algtp_phone", "", 0);
  res.redirect(302, "/login");
});

// Keep POST too (optional)
app.post("/logout", (req, res) => {
  setCookie(res, "algtp_phone", "", 0);
  res.json({ ok: true });
});

// =========================
// PRICING + STRIPE
// NOTE: currently keyed by OTP phone cookie.
// If you want Clerk-only payments, we will switch key to userId later.
// =========================
app.get("/pricing", (req, res) => {
  const cookies = parseCookie(req);
  const phone = cookies.algtp_phone || "";

  res.type("html").send(`<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ALGTP Pricing</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0b0d12;color:#e6e8ef;font-family:system-ui;padding:24px}
.box{max-width:720px;margin:8vh auto;padding:18px;border-radius:14px;border:1px solid rgba(255,255,255,.14);background:rgba(18,24,43,.55)}
.btn{display:inline-block;background:#121622;border:1px solid rgba(255,255,255,.16);color:#e6e8ef;border-radius:10px;padding:10px 12px;text-decoration:none}
.btn:hover{border-color:rgba(255,255,255,.28)}
.muted{opacity:.85;line-height:1.7}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;opacity:.75}
</style></head><body>
<div class="box">
  <h2 style="margin:0 0 8px;">ALGTP Plan</h2>
  <div class="muted">
    Plan <b>${PAID_DAYS} days</b> (Stripe).<br/>
    Login phone: <span class="mono">${phone || "-"}</span><br/>
    *OTP login is required for payment mapping in this version.
  </div>
  <div style="margin-top:14px;">
    <a class="btn" href="/pay/stripe">Pay with Stripe</a>
    <a class="btn" href="/ui" style="margin-left:8px;">Back</a>
  </div>
</div>
</body></html>`);
});

app.get("/pay/stripe", (req, res) => {
  const cookies = parseCookie(req);
  const phone = cookies.algtp_phone;

  if (!phone) return res.status(401).type("html").send(renderLoginPage("Please login (OTP) first"));

  const url = STRIPE_PAYMENT_LINK + "?client_reference_id=" + encodeURIComponent(phone);
  return res.redirect(302, url);
});

// ⚠️ WARNING: minimal webhook (NO signature verify) — keep only for testing
app.post("/webhook/stripe", (req, res) => {
  try {
    const evt = req.body;
    const session = evt?.data?.object;
    const phone = normalizePhone(session?.client_reference_id);

    if (!phone) return res.status(200).json({ ok: true, skipped: "no_phone" });

    grantPaid30Days(phone, "STRIPE");
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// =========================
// GUARD: protect /ui* /list /scan
// =========================
app.use((req, res, next) => {
  const p = req.path || "";
  const needsGate = p === "/ui" || p.startsWith("/ui/") || p === "/list" || p === "/scan";
  if (!needsGate) return next();

  // 1) Clerk session (primary)
  if (hasClerk) {
    const { userId } = getAuth(req);
    if (userId) {
      ensureUserTrial(userId);
      const access = getAccess(userId);
      if (access.ok) return next();
      return res.status(402).type("html").send(renderPaywallPage(access));
    }
  }

  // 2) OTP cookie (fallback)
  const cookies = parseCookie(req);
  const phone = cookies.algtp_phone;

  if (!phone) {
    // If Clerk enabled -> go to Clerk login, else OTP login
    return res.redirect(302, "/login");
  }

  ensureUserTrial(phone);
  const access = getAccess(phone);
  if (access.ok) return next();

  return res.status(402).type("html").send(renderPaywallPage(access));
});

// =========================
// PLACEHOLDER UI/LIST/SCAN
// =========================
app.get("/ui", (req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ALGTP UI</title>
<style>:root{color-scheme:dark}body{margin:0;background:#0b0d12;color:#e6e8ef;font-family:system-ui;padding:24px}</style>
</head><body>
<h2>✅ ALGTP UI is working</h2>
<p>Replace UI inside <b>app.get("/ui", ...)</b>.</p>
<p><a href="/logout" style="color:#9ad">Logout</a></p>
</body></html>`);
});

app.get("/list", (req, res) => {
  res.json({ ok: true, note: "Replace /list with your real logic" });
});

app.get("/scan", (req, res) => {
  res.json({ ok: true, note: "Replace /scan with your real logic", example: "/scan?symbols=NVDA,TSLA,AAPL" });
});

// =========================
// START
// =========================
app.listen(PORT, () => {
  console.log(`✅ ALGTP™ Server running on port ${PORT}`);
  console.log(`🚀 UI: /ui`);
  console.log(`🔐 Login: /login`);
  console.log(`🔎 Scan: /scan?symbols=NVDA,TSLA,AAPL`);
});
