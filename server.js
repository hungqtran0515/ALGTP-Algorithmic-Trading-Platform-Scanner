require("dotenv").config();
const express = require("express");
const axios = require("axios");
const WebSocket = require("ws");
const { clerkMiddleware, getAuth } = require("@clerk/express");

const app = express();
app.use(express.json());
app.use(clerkMiddleware());

// =====================
// CONFIG
// =====================
const PORT = Number(process.env.PORT || 3000);

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 3);
const PAID_DAYS = Number(process.env.PAID_DAYS || 30);

const MASSIVE_API_KEY = String(process.env.MASSIVE_API_KEY || "").trim();
const MASSIVE_WS_URL = String(process.env.MASSIVE_WS_URL || "wss://socket.massive.com/stocks").trim();
const ENABLE_HALT_WS = String(process.env.ENABLE_HALT_WS || "true").toLowerCase() === "true";

const WS_DEFAULT_SUBS = String(process.env.WS_DEFAULT_SUBS || "AM.AAPL,AM.MSFT,LULD.*").trim();
const WS_MAX_TRADES_PER_SYMBOL = Math.max(50, Math.min(2000, Number(process.env.WS_MAX_TRADES_PER_SYMBOL || 200)));

if (!MASSIVE_API_KEY) {
  console.error("❌ Missing MASSIVE_API_KEY in .env");
  process.exit(1);
}

// =====================
// TRIAL / PAYWALL (DEV store)
// =====================
const users = Object.create(null);

function msDays(d) {
  return d * 24 * 60 * 60 * 1000;
}

function ensureUserTrial(userId) {
  if (!userId) return;
  if (!users[userId]) {
    users[userId] = {
      userId,
      createdAt: Date.now(),
      trialEndsAt: Date.now() + msDays(TRIAL_DAYS),
      paidUntil: null,
      source: "TRIAL",
    };
  }
}

function grantPaid30Days(userId, source = "STRIPE") {
  if (!userId) return;
  ensureUserTrial(userId);
  const now = Date.now();
  const base = users[userId].paidUntil && users[userId].paidUntil > now ? users[userId].paidUntil : now;
  users[userId].paidUntil = base + msDays(PAID_DAYS);
  users[userId].source = source;
}

function getAccess(userId) {
  if (!userId) return { ok: false, reason: "NO_USER" };
  ensureUserTrial(userId);

  const u = users[userId];
  const now = Date.now();
  const paidOk = u.paidUntil !== null && u.paidUntil > now;
  const trialOk = u.trialEndsAt !== null && u.trialEndsAt > now;

  if (paidOk) return { ok: true, tier: "PAID", until: u.paidUntil };
  if (trialOk) return { ok: true, tier: "TRIAL", until: u.trialEndsAt };

  return { ok: false, reason: "EXPIRED", trialEndsAt: u.trialEndsAt, paidUntil: u.paidUntil };
}

function renderLoginPage() {
  const pk = process.env.CLERK_PUBLISHABLE_KEY || "";
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
  </style>
  <script async crossorigin="anonymous"
    data-clerk-publishable-key="${pk}"
    src="https://js.clerk.com/v4/clerk.browser.js"></script>
</head>
<body>
  <div class="box">
    <h2 style="margin:0 0 12px;text-align:center;">🔐 Login</h2>
    <div id="clerk-signin"></div>
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

function renderPaywallPage(access) {
  const reason = access?.reason || "EXPIRED";
  const trialEnds = access?.trialEndsAt ? new Date(access.trialEndsAt).toLocaleString() : "-";
  const paidUntil = access?.paidUntil ? new Date(access.paidUntil).toLocaleString() : "-";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>ALGTP Paywall</title>
  <style>
    :root{color-scheme:dark}
    body{margin:0;background:#0b0d12;color:#e6e8ef;font-family:system-ui}
    .box{max-width:680px;margin:10vh auto;padding:24px;border-radius:18px;border:1px solid rgba(255,255,255,.14);background:rgba(18,24,43,.55)}
    .muted{color:#a7adc2}
    a.btn{display:inline-block;margin-top:12px;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.18);background:#121622;color:#e6e8ef;text-decoration:none}
    a.btn:hover{border-color:rgba(255,255,255,.28)}
  </style>
</head>
<body>
  <div class="box">
    <h2 style="margin:0 0 10px;">🔒 Access Required</h2>
    <div class="muted">Reason: <b>${reason}</b></div>
    <div class="muted">Trial ends: <b>${trialEnds}</b></div>
    <div class="muted">Paid until: <b>${paidUntil}</b></div>
    <p style="margin-top:14px;">Your trial is over. Please upgrade to continue.</p>
    <a class="btn" href="/upgrade">Upgrade</a>
    <a class="btn" href="/login">Back to Login</a>
  </div>
</body>
</html>`;
}

// Public
app.get("/login", (req, res) => res.type("html").send(renderLoginPage()));
app.get("/upgrade", (req, res) => {
  const { userId } = getAuth(req);
  if (!userId) return res.redirect(302, "/login");
  grantPaid30Days(userId, "MANUAL");
  return res.redirect(302, "/ui");
});

// Gate protected routes
app.use((req, res, next) => {
  const p = String(req.path || "");

  const needsGate =
    p === "/ui" ||
    p.startsWith("/ui/") ||
    p.startsWith("/ws/") ||
    p === "/halts";

  if (!needsGate) return next();

  const { userId } = getAuth(req);
  if (!userId) return res.redirect(302, "/login");

  ensureUserTrial(userId);
  const access = getAccess(userId);
  if (access.ok) return next();

  return res.status(402).type("html").send(renderPaywallPage(access));
});

// =====================
// Massive WebSocket Engine
// =====================
let ws = null;
let wsReady = false;
let wsAuthed = false;

const subsActive = new Set(); // current subscriptions we think are active
const wsStatus = {
  connectedAt: null,
  lastMessageAt: null,
  lastStatus: null,
  lastError: null,
};

const agg1m = new Map();     // sym -> last AM payload
const lastTrades = new Map(); // sym -> array of last trades
const haltedMap = new Map();  // sym -> {halted,lastEvent,tsMs,reason}

function nowMs() { return Date.now(); }
function normSym(s) { return String(s || "").trim().toUpperCase(); }

function pushTrade(sym, trade) {
  const key = normSym(sym);
  const arr = lastTrades.get(key) || [];
  arr.unshift(trade);
  if (arr.length > WS_MAX_TRADES_PER_SYMBOL) arr.length = WS_MAX_TRADES_PER_SYMBOL;
  lastTrades.set(key, arr);
}

function setHalt(sym) {
  haltedMap.set(normSym(sym), { halted: true, lastEvent: "HALT", tsMs: nowMs(), reason: "LULD" });
}
function setResume(sym) {
  haltedMap.set(normSym(sym), { halted: false, lastEvent: "RESUME", tsMs: nowMs(), reason: "LULD" });
}

function handleWsMessage(payload) {
  wsStatus.lastMessageAt = nowMs();

  const msgs = Array.isArray(payload) ? payload : [payload];
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;

    const ev = String(m.ev || m.event || "").toUpperCase();

    if (ev === "STATUS") {
      wsStatus.lastStatus = m;
      if (String(m.status || "").toLowerCase() === "auth_success") wsAuthed = true;
      continue;
    }

    if (ev === "AM") {
      // aggregates
      const sym = normSym(m.sym || m.S || m.ticker);
      if (!sym) continue;
      agg1m.set(sym, { ...m, _ts: nowMs() });
      continue;
    }

    if (ev === "T") {
      const sym = normSym(m.sym || m.S || m.ticker);
      if (!sym) continue;
      pushTrade(sym, { ...m, _ts: nowMs() });
      continue;
    }

    if (ev === "LULD") {
      const sym = normSym(m.T || m.sym || m.ticker);
      if (!sym) continue;
      const indicators = Array.isArray(m.i) ? m.i : Array.isArray(m.indicators) ? m.indicators : [];
      if (indicators.includes(17)) setHalt(sym);
      if (indicators.includes(18)) setResume(sym);
      continue;
    }
  }
}

function wsSend(obj) {
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

function wsAuthAndDefaultSubs() {
  if (!wsSend({ action: "auth", params: MASSIVE_API_KEY })) return;
  wsAuthed = false;

  // default subs
  const list = WS_DEFAULT_SUBS.split(",").map(s => s.trim()).filter(Boolean);
  if (list.length) {
    wsSend({ action: "subscribe", params: list.join(",") });
    list.forEach(x => subsActive.add(x));
  }
}

function startWS() {
  if (!ENABLE_HALT_WS) return;

  ws = new WebSocket(MASSIVE_WS_URL);
  wsReady = false;
  wsAuthed = false;

  ws.on("open", () => {
    wsReady = true;
    wsStatus.connectedAt = nowMs();
    wsStatus.lastError = null;
    wsAuthAndDefaultSubs();
    console.log("✅ Massive WS connected");
  });

  ws.on("message", (buf) => {
    try {
      const parsed = JSON.parse(buf.toString("utf8"));
      handleWsMessage(parsed);
    } catch (e) {
      // ignore parse errors
    }
  });

  ws.on("close", () => {
    wsReady = false;
    ws = null;
    console.log("⚠️ Massive WS closed. Reconnect in 3s...");
    setTimeout(startWS, 3000);
  });

  ws.on("error", (err) => {
    wsStatus.lastError = String(err?.message || err);
  });
}

startWS();

// =====================
// WS APIs (protected)
// =====================

// subscribe extra topics runtime
app.post("/ws/subscribe", (req, res) => {
  const topics = Array.isArray(req.body?.topics) ? req.body.topics : [];
  const clean = topics.map(t => String(t).trim()).filter(Boolean);
  if (!clean.length) return res.json({ ok: false, error: "topics[] required" });

  const ok = wsSend({ action: "subscribe", params: clean.join(",") });
  if (ok) clean.forEach(t => subsActive.add(t));

  res.json({ ok, sent: clean, wsReady, wsAuthed });
});

app.get("/ws/state", (req, res) => {
  res.json({
    ok: true,
    wsReady,
    wsAuthed,
    url: MASSIVE_WS_URL,
    status: wsStatus,
    subsActive: Array.from(subsActive).slice(0, 200),
    aggSymbols: agg1m.size,
    tradeSymbols: lastTrades.size,
    haltsTracked: haltedMap.size,
  });
});

app.get("/ws/agg", (req, res) => {
  const sym = normSym(req.query.sym);
  if (!sym) return res.json({ ok: false, error: "sym required" });
  res.json({ ok: true, sym, data: agg1m.get(sym) || null });
});

app.get("/ws/trades", (req, res) => {
  const sym = normSym(req.query.sym);
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 50)));
  if (!sym) return res.json({ ok: false, error: "sym required" });
  const arr = lastTrades.get(sym) || [];
  res.json({ ok: true, sym, count: Math.min(limit, arr.length), results: arr.slice(0, limit) });
});

// HALTS
app.get("/halts", (req, res) => {
  const only = String(req.query.only || "halted").toLowerCase();
  const out = [];
  for (const [symbol, v] of haltedMap.entries()) {
    if (only === "halted" && !v.halted) continue;
    out.push({ symbol, ...v });
  }
  out.sort((a, b) => (b.tsMs ?? 0) - (a.tsMs ?? 0));
  res.json({ ok: true, count: out.length, results: out.slice(0, 500) });
});

// =====================
// Simple UI (protected)
// =====================
app.get("/ui", (req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ALGTP WS Monitor</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0b0d12;color:#e6e8ef;font-family:system-ui}
.wrap{max-width:980px;margin:0 auto;padding:18px}
.card{border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:14px 16px;background:#0b0d12}
code{font-family:ui-monospace;background:#121622;padding:2px 6px;border-radius:8px;border:1px solid rgba(255,255,255,.10)}
.btn{display:inline-block;margin-top:10px;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.18);background:#121622;color:#e6e8ef;text-decoration:none}
</style></head>
<body><div class="wrap"><div class="card">
<h2 style="margin:0 0 10px;">🔥 ALGTP WS Monitor</h2>
<p>Check WS state: <code>/ws/state</code></p>
<p>Get agg: <code>/ws/agg?sym=AAPL</code></p>
<p>Get trades: <code>/ws/trades?sym=MSFT&limit=50</code></p>
<p>Halts: <code>/halts</code></p>
<a class="btn" href="/ws/state">Open /ws/state</a>
<a class="btn" href="/upgrade">DEV Upgrade</a>
</div></div></body></html>`);
});

// =====================
// Root
// =====================
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "ALGTP v18 (Clerk gate + Massive WS)",
    login: "/login",
    ui: "/ui",
    ws: ["/ws/state", "/ws/subscribe", "/ws/agg", "/ws/trades"],
    halts: "/halts",
  });
});

app.listen(PORT, () => {
  console.log(`✅ ALGTP v18 running http://localhost:${PORT}`);
  console.log(`🔐 Login: http://localhost:${PORT}/login`);
  console.log(`🖥️  UI:    http://localhost:${PORT}/ui`);
  console.log(`📡 WS:    http://localhost:${PORT}/ws/state`);
});
