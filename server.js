/**
 * server.js — ALGTP™ – Algorithmic Trading Platform Scanner (FULL + Multi-Page UI + Alerts + Auto Refresh + Scan Symbols)
 */

require("dotenv").config();

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // QUAN TRỌNG cho PIN form

// ============================================================================
// ✅ HELPERS (shared)
// ============================================================================
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";

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

function parseCookieGeneric(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  raw.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// ============================================================================
// ✅ PIN LOCK (CLEAN + Max-Age + works on localhost)
// ============================================================================
const PIN_ENABLED = String(process.env.PIN_ENABLED || "true").toLowerCase() === "true";
const PIN_CODE = String(process.env.APP_PIN_CODE || "").trim();
const PIN_COOKIE = "algtp_pin_ok";
const PIN_MAX_AGE_SEC = Math.max(60, Number(process.env.PIN_MAX_AGE_SEC || 86400)); // default 24h

function renderPinPage(err = "") {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ALGTP™ Secure Access</title>
<style>
body{margin:0;background:#0b0d12;color:#e6e8ef;font-family:system-ui}
.box{max-width:420px;margin:20vh auto;padding:20px;border-radius:14px;
border:1px solid rgba(255,255,255,.14);background:#121622}
input,button{width:100%;padding:12px;margin-top:12px;border-radius:10px;
border:1px solid rgba(255,255,255,.2);background:#0b0d12;color:#fff;font-size:16px}
button{cursor:pointer}
.err{color:#ff8c8c;margin-top:10px;font-size:14px}
</style>
</head>
<body>
<div class="box">
<h2>🔐 ALGTP™ Secure Access</h2>
<form method="POST" action="/pin">
  <input name="pin" type="password" placeholder="Enter PIN" autofocus />
  <button>Unlock</button>
</form>
${err ? `<div class="err">${err}</div>` : ""}
</div>
</body>
</html>`;
}

app.get("/pin", (req, res) => res.type("html").send(renderPinPage()));

app.post("/pin", (req, res) => {
  if (!PIN_CODE) return res.type("html").send(renderPinPage("PIN not configured"));

  const pin = String(req.body?.pin || "").trim();
  if (pin !== PIN_CODE) return res.type("html").send(renderPinPage("Wrong PIN"));

  // cookie Secure chỉ bật khi production/https, chạy localhost http vẫn lưu cookie OK
  const cookie = `${PIN_COOKIE}=1; Max-Age=${PIN_MAX_AGE_SEC}; Path=/; HttpOnly; SameSite=Strict${
    IS_PROD ? "; Secure" : ""
  }`;

  res.setHeader("Set-Cookie", cookie);
  res.redirect("/ui");
});

// PIN guard (apply ONCE)
app.use((req, res, next) => {
  if (!PIN_ENABLED) return next();

  // bypass pin + health + api
  if (req.path === "/pin") return next();
  if (req.path === "/health") return next();
  if (req.path === "/api") return next();
  if (req.path.startsWith("/_debug")) return next(); // optional

  const cookies = parseCookieGeneric(req);
  if (cookies[PIN_COOKIE] === "1") return next();

  return res.status(401).type("html").send(renderPinPage());
});

// ============================================================================
// ✅ ENV (DECLARE ONCE ONLY)
// ============================================================================
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

// ============================================================================
// ✅ ACCESS LOCK (TOKEN) — CLEAN + NO REDECLARE
// ============================================================================
const LOCK_ENABLED = String(process.env.APP_LOCK_ENABLED || "true").toLowerCase() === "true";
const HARD_LOCK_ENABLED = String(process.env.HARD_LOCK_ENABLED || "false").toLowerCase() === "true";
const ACCESS_SECRET = String(process.env.APP_ACCESS_SECRET || "").trim();

if (HARD_LOCK_ENABLED) {
  const REQUIRED_ENVS = ["APP_ACCESS_SECRET", "MASSIVE_API_KEY"];
  for (const k of REQUIRED_ENVS) {
    if (!process.env[k] || !String(process.env[k]).trim()) {
      console.error(`❌ FATAL: Missing required env ${k}`);
      process.exit(1);
    }
  }
}

app.get("/_debug/env", (req, res) => {
  const allow =
    String(process.env.DEBUG || "false").toLowerCase() === "true" ||
    String(process.env.ALLOW_DEBUG || "false").toLowerCase() === "true";

  if (!allow) return res.status(404).json({ ok: false });

  res.json({
    ok: true,
    pinEnabled: PIN_ENABLED,
    lockEnabled: LOCK_ENABLED,
    hardLockEnabled: HARD_LOCK_ENABLED,
    hasAppAccessSecret: Boolean(ACCESS_SECRET),
    appAccessSecretLen: ACCESS_SECRET.length,
    hasMassiveKey: Boolean(MASSIVE_API_KEY),
    massiveKeyLen: MASSIVE_API_KEY.length,
    nodeEnv: process.env.NODE_ENV || null,
  });
});

// base64url
function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}
function fromB64url(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  return Buffer.from((str + pad).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function deviceHash(req) {
  const ua = String(req.headers["user-agent"] || "");
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
    .split(",")[0]
    .trim();
  return crypto.createHash("sha256").update(ua + "|" + ip).digest("hex");
}

function sign(data) {
  return b64url(crypto.createHmac("sha256", ACCESS_SECRET).update(data).digest());
}

function makeToken(payload) {
  const body = b64urlJson(payload);
  const sig = sign(body);
  return `${body}.${sig}`;
}

function verifyToken(token) {
  try {
    if (!ACCESS_SECRET) return { ok: false, reason: "missing_secret" };
    if (!token) return { ok: false, reason: "missing_token" };

    const parts = String(token).split(".");
    if (parts.length !== 2) return { ok: false, reason: "bad_format" };

    const [body, sig] = parts;
    const expected = sign(body);

    const a = Buffer.from(String(sig));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: "bad_signature" };
    }

    const payload = JSON.parse(fromB64url(body));
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp)) return { ok: false, reason: "no_exp" };

    const now = Math.floor(Date.now() / 1000);
    if (now > exp) return { ok: false, reason: "expired", exp, now };

    return { ok: true, payload };
  } catch (e) {
    return { ok: false, reason: "verify_error", detail: String(e?.message || e) };
  }
}

function renderLocked(reason = "unauthorized", extra = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ALGTP™ Locked</title>
<style>
body{margin:0;background:#0b0d12;color:#e6e8ef;font-family:system-ui}
.box{max-width:720px;margin:10vh auto;padding:18px;border-radius:14px;
border:1px solid rgba(255,255,255,.14);background:rgba(18,24,43,.55)}
.muted{opacity:.8;line-height:1.6}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;opacity:.75;white-space:pre-wrap}
</style>
</head>
<body>
<div class="box">
<h2 style="margin:0 0 10px;">🔒 ALGTP™ Scanner Locked</h2>
<div class="muted">Access token missing / expired / invalid.</div>
<div class="mono" style="margin-top:10px;">Reason: ${String(reason)}${
    extra?.exp ? `\nExp: ${extra.exp}` : ""
  }${extra?.now ? `\nNow: ${extra.now}` : ""}</div>
<div class="muted" style="margin-top:12px;">Please purchase / renew access to continue.</div>
</div>
</body>
</html>`;
}

// Save token from query -> cookie (visit ?token=xxx)
app.use((req, res, next) => {
  if (!LOCK_ENABLED) return next();

  const t = req.query.token || req.query.t || req.query.access_token;
  if (t) {
    const cookie = `algtp_token=${encodeURIComponent(String(t))}; Path=/; HttpOnly; SameSite=Lax${
      IS_PROD ? "; Secure" : ""
    }`;
    res.setHeader("Set-Cookie", cookie);
  }
  next();
});

function accessGuard(req, res, next) {
  if (!LOCK_ENABLED) return next();

  // bypass routes
  if (req.path === "/health") return next();
  if (req.path === "/api") return next();
  if (req.path === "/pin") return next();
  if (req.path.startsWith("/_debug")) return next();

  const cookies = parseCookieGeneric(req);
  const token =
    req.headers["x-access-token"] ||
    req.query.token ||
    req.query.t ||
    cookies.algtp_token;

  const v = verifyToken(token);
  if (!v.ok) return res.status(401).type("html").send(renderLocked(v.reason, v));

  const currentDh = deviceHash(req);
  if (v.payload?.dh && v.payload.dh !== currentDh) {
    return res.status(401).type("html").send(renderLocked("device_mismatch"));
  }

  req.algtpAccess = v.payload;
  return next();
}

// ✅ apply access guard ONCE, after it’s defined
app.use(accessGuard);

// ============================================================================
// ✅ ROUTES (YOUR ORIGINAL CODE)
// ============================================================================

// Health route (bypass)
app.get("/health", (req, res) => res.json({ ok: true }));

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

// ============================================================================
// ✅ UI (GIỮ NGUYÊN UI BẠN ĐÃ DÁN) — MÌNH KHÔNG ĐỔI LOGIC UI
// ============================================================================
function renderUI(preset = {}) {
  // *** NOTE: Đây là nguyên UI code bạn đã gửi ***
  // Bạn dán phần renderUI(...) đầy đủ của bạn ở đây (y chang)
  // (Mình giữ trống để tránh message quá dài; nhưng bạn đã có UI ở file bạn.)
  return "<html><body>Paste your full renderUI here</body></html>";
}

// UI routes (bạn thay lại renderUI bản đầy đủ của bạn)
app.get("/ui", (req, res) => res.type("html").send(renderUI({ path: "/ui", group: "topGainers", cap: "all", limit: 50 })));
app.get("/ui/gainers", (req, res) => res.type("html").send(renderUI({ path: "/ui/gainers", group: "topGainers", cap: "all", limit: 50 })));
app.get("/ui/losers", (req, res) => res.type("html").send(renderUI({ path: "/ui/losers", group: "topLosers", cap: "all", limit: 50 })));
app.get("/ui/gappers", (req, res) => res.type("html").send(renderUI({ path: "/ui/gappers", group: "topGappers", cap: "all", limit: 80, minGap: 10 })));
app.get("/ui/smallcap", (req, res) => res.type("html").send(renderUI({ path: "/ui/smallcap", group: "topGainers", cap: "small", limit: 80 })));
app.get("/ui/midcap", (req, res) => res.type("html").send(renderUI({ path: "/ui/midcap", group: "topGainers", cap: "mid", limit: 80 })));
app.get("/ui/bigcap", (req, res) => res.type("html").send(renderUI({ path: "/ui/bigcap", group: "topGainers", cap: "big", limit: 80 })));

// ============================================================================
// ✅ API ROUTES
// ============================================================================
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

// Symbols scan endpoint
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

// ============================================================================
// ✅ START
// ============================================================================
app.listen(PORT, () => {
  console.log(`✅ ALGTP™ Scanner running http://localhost:${PORT}`);
  console.log(`🚀 UI: http://localhost:${PORT}/ui`);
  console.log(`🔎 Symbols scan: /scan?symbols=NVDA,TSLA,AAPL`);
});
