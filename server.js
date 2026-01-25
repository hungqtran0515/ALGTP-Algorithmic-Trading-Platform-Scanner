verion 18 

// ============================================================================
// SECTION 01 — Imports + App Init
// ============================================================================
require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());
// ============================================================================
// SECTION 19 — Clerk Auth Gate (Express) + Trial/Paywall
// ============================================================================
const { clerkMiddleware, getAuth } = require("@clerk/express");

// NOTE: Clerk middleware must be mounted early (before your routes)
app.use(clerkMiddleware());

// ---------------- Simple in-memory access store (DEV only) ----------------
// IMPORTANT: This resets on server restart (Render will reset too).
// For production: store users in DB (Redis/Postgres/etc).
const users = Object.create(null);

// Trial config
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 3);
const PAID_DAYS = Number(process.env.PAID_DAYS || 30);

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

// ---------------- Gate middleware ----------------
app.use((req, res, next) => {
  const p = String(req.path || "");

  // Routes that require login + access
  const needsGate =
    p === "/ui" ||
    p.startsWith("/ui/") ||
    p === "/list" ||
    p === "/scan" ||
    p === "/snapshot-all" ||
    p === "/premarket" ||
    p === "/aftermarket" ||
    p === "/halts";

  // public routes
  if (!needsGate) return next();

  const { userId } = getAuth(req);

  if (!userId) {
    // Not logged in -> go login
    return res.redirect(302, "/login");
  }

  // trial/paid logic (use userId key)
  ensureUserTrial(userId);
  const access = getAccess(userId);

  if (access.ok) return next();

  // expired -> paywall
  return res.status(402).type("html").send(renderPaywallPage(access));
});

// ---------------- Login + Paywall pages ----------------
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
    src="https://js.clerk.com/v4/clerk.browser.js">
  </script>
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

    <p style="margin-top:14px;">
      Your trial is over. Please upgrade to continue using ALGTP Scanner.
    </p>

    <!-- Replace this link with your real Stripe/Whop checkout -->
    <a class="btn" href="/upgrade">Upgrade</a>
    <a class="btn" href="/login">Back to Login</a>
  </div>
</body>
</html>`;
}

// Public login route
app.get("/login", (req, res) => res.type("html").send(renderLoginPage()));

// Demo upgrade route (DEV ONLY): grant paid access for current user
// Replace with Stripe webhook verification later.
app.get("/upgrade", (req, res) => {
  const { userId } = getAuth(req);
  if (!userId) return res.redirect(302, "/login");
  grantPaid30Days(userId, "MANUAL");
  return res.redirect(302, "/ui");
});

// ============================================================================
// SECTION 02 — ENV + Config
// ============================================================================
const PORT = Number(process.env.PORT || 3000);

const MASSIVE_API_KEY = String(process.env.MASSIVE_API_KEY || "").trim();
const MASSIVE_AUTH_TYPE = String(process.env.MASSIVE_AUTH_TYPE || "query").trim(); // query | xapi | bearer
const MASSIVE_QUERY_KEYNAME = String(process.env.MASSIVE_QUERY_KEYNAME || "apiKey").trim();

const MASSIVE_MOVER_URL = String(
  process.env.MASSIVE_MOVER_URL || "https://api.massive.com/v2/snapshot/locale/us/markets/stocks"
).trim();

const MASSIVE_TICKER_SNAPSHOT_URL = String(
  process.env.MASSIVE_TICKER_SNAPSHOT_URL || "https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers"
).trim();

// Snapshot ALL tickers (pre/after/snapshot-all scanners)
const MASSIVE_SNAPSHOT_ALL_URL = String(
  process.env.MASSIVE_SNAPSHOT_ALL_URL || "https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers"
).trim();

// Aggs
const MASSIVE_AGGS_URL = String(process.env.MASSIVE_AGGS_URL || "https://api.massive.com/v2/aggs/ticker").trim();
const AGGS_INCLUDE_PREPOST = String(process.env.AGGS_INCLUDE_PREPOST || "true").toLowerCase() === "true";

// Optional dividends
const MASSIVE_DIVIDENDS_URL = String(
  process.env.MASSIVE_DIVIDENDS_URL || "https://api.massive.com/v3/reference/dividends"
).trim();

const INCLUDE_OTC = String(process.env.INCLUDE_OTC || "false").toLowerCase() === "true";
const SNAP_CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.SNAP_CONCURRENCY || 4)));
const DEBUG = String(process.env.DEBUG || "true").toLowerCase() === "true";

// Indicators
const ENABLE_5M_INDICATORS = String(process.env.ENABLE_5M_INDICATORS || "true").toLowerCase() === "true";
const AGGS_5M_LIMIT = Math.max(40, Math.min(5000, Number(process.env.AGGS_5M_LIMIT || 120)));

// Volume spike thresholds
const VOL_SPIKE_MULT = Math.max(1.1, Math.min(10, Number(process.env.VOL_SPIKE_MULT || 1.5)));
const VOL_AVG_LEN_5M = Math.max(5, Math.min(200, Number(process.env.VOL_AVG_LEN_5M || 20)));

// HALT WS
const ENABLE_HALT_WS = String(process.env.ENABLE_HALT_WS || "true").toLowerCase() === "true";
const MASSIVE_WS_URL = String(process.env.MASSIVE_WS_URL || "wss://socket.massive.com/stocks").trim();

// ============================================================================
// SECTION 03 — Helpers
// ============================================================================
function envMissing() {
  const miss = [];
  if (!MASSIVE_API_KEY) miss.push("MASSIVE_API_KEY");
  if (!MASSIVE_MOVER_URL) miss.push("MASSIVE_MOVER_URL");
  if (!MASSIVE_TICKER_SNAPSHOT_URL) miss.push("MASSIVE_TICKER_SNAPSHOT_URL");
  if (!MASSIVE_SNAPSHOT_ALL_URL) miss.push("MASSIVE_SNAPSHOT_ALL_URL");
  if (!MASSIVE_AGGS_URL) miss.push("MASSIVE_AGGS_URL");
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

// ============================================================================
// SECTION 04 — Scoring + Icons
// ============================================================================
function demandScore(row) {
  const gap = Math.abs(n(row?.gapPct) ?? 0);
  const pc = Math.abs(n(row?.pricePct ?? row?.extPct) ?? 0);

  let s = 0;
  if (gap >= 20) s += 1;
  if (gap >= 40) s += 1;
  if (gap >= 60) s += 1;
  if (pc >= 10) s += 1;
  if (pc >= 20) s += 1;

  if (row?.aboveVWAP_5m && row?.volSpike_5m) s += 1;

  return clamp(s, 0, 5);
}

function signalIcon(d) {
  if (d >= 5) return "🚀";
  if (d >= 4) return "🔥";
  if (d >= 3) return "👀";
  return "⛔️";
}

function paSignalIcon(row) {
  const above = Boolean(row?.aboveVWAP_5m);
  const volSpike = Boolean(row?.volSpike_5m);
  if (above && volSpike) return "🚨";
  if (above) return "✅";
  if (volSpike) return "🔊";
  return "";
}

// ============================================================================
// SECTION 05 — Axios Safe Layer
// ============================================================================
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

// ============================================================================
// SECTION 06 — Massive Calls (Movers / Ticker Snapshot / Snapshot ALL)
// ============================================================================
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

async function fetchSnapshotAll() {
  const url = MASSIVE_SNAPSHOT_ALL_URL.replace(/\/+$/, "");
  const params = {};
  const headers = {};
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

// ============================================================================
// SECTION 07 — Auto-detect Fields + Normalize Snapshot
// ============================================================================
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

  // Market cap (may be missing)
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

  // Fallback marketCap estimate: price * floatShares (helps mid/big cap filter)
  const marketCapEst = marketCap === null && price !== null && floatShares !== null ? price * floatShares : null;
  const marketCapFinal = marketCap ?? marketCapEst;

  return {
    symbol: String(ticker || "").trim().toUpperCase(),
    price: price !== null ? round2(price) : null,
    pricePct: pricePct !== null ? round2(pricePct) : null,
    gapPct: gapPct !== null ? round2(gapPct) : null,
    volume: volume !== null ? Math.round(volume) : null,

    floatShares: floatShares !== null ? Math.round(floatShares) : null,
    floatM: floatShares !== null ? round2(floatShares / 1_000_000) : null,
    floatCat: floatCategory(floatShares),

    marketCap: marketCapFinal !== null ? Math.round(marketCapFinal) : null,
    marketCapB: marketCapFinal !== null ? round2(marketCapFinal / 1_000_000_000) : null,
    cap: capCategory(marketCapFinal),
    marketCapSource: marketCap !== null ? "api" : marketCapEst !== null ? "est_float" : null,
  };
}

// ============================================================================
// SECTION 08 — Grouping + Sorting
// ============================================================================
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
// SECTION 09 — Aggs 5m Indicators (SMA/EMA/VWAP) + Cache
// ============================================================================
function computeSMA(closes, len) {
  if (!Array.isArray(closes) || closes.length < len) return null;
  let sum = 0;
  for (let i = 0; i < len; i++) sum += closes[i];
  return sum / len;
}

function computeEMA(closes, len) {
  if (!Array.isArray(closes) || closes.length < len) return null;
  const k = 2 / (len + 1);
  const seed = computeSMA(closes.slice(0, len), len);
  if (seed === null) return null;

  let ema = seed;
  for (let i = len; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function computeVWAP(closes, volumes) {
  if (!Array.isArray(closes) || !Array.isArray(volumes) || closes.length === 0 || closes.length !== volumes.length) return null;
  let pv = 0;
  let vv = 0;
  for (let i = 0; i < closes.length; i++) {
    const c = n(closes[i]);
    const v = n(volumes[i]);
    if (c === null || v === null || v <= 0) continue;
    pv += c * v;
    vv += v;
  }
  if (vv <= 0) return null;
  return pv / vv;
}

function computeAvg(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  let s = 0;
  let c = 0;
  for (const x of arr) {
    const v = n(x);
    if (v === null) continue;
    s += v;
    c += 1;
  }
  if (c === 0) return null;
  return s / c;
}

function indicatorsFromAggs5m(barsDesc) {
  if (!Array.isArray(barsDesc) || barsDesc.length === 0) {
    return {
      sma26_5m: null,
      ema9_5m: null,
      ema34_5m: null,
      vwap_5m: null,
      lastVol_5m: null,
      avgVol_5m: null,
    };
  }

  const bars = barsDesc
    .map((b) => ({
      c: n(b?.c ?? b?.close),
      v: n(b?.v ?? b?.volume),
    }))
    .filter((x) => x.c !== null)
    .slice(0, 600);

  const barsChrono = [...bars].reverse();
  const closes = barsChrono.map((x) => x.c);
  const vols = barsChrono.map((x) => x.v ?? 0);

  const sma26 = closes.length >= 26 ? computeSMA(closes.slice(-26), 26) : null;
  const ema9 = computeEMA(closes, 9);
  const ema34 = computeEMA(closes, 34);
  const vwap = computeVWAP(closes, vols);

  const lastBar = barsChrono[barsChrono.length - 1] || null;
  const lastVol = lastBar?.v ?? null;
  const avgVol = computeAvg(vols.slice(-VOL_AVG_LEN_5M));

  return {
    sma26_5m: sma26 !== null ? round2(sma26) : null,
    ema9_5m: ema9 !== null ? round2(ema9) : null,
    ema34_5m: ema34 !== null ? round2(ema34) : null,
    vwap_5m: vwap !== null ? round2(vwap) : null,
    lastVol_5m: lastVol !== null ? Math.round(lastVol) : null,
    avgVol_5m: avgVol !== null ? Math.round(avgVol) : null,
  };
}

const aggsCache = new Map(); // key -> {ts,bars}

function ymd(d) {
  const x = new Date(d);
  const yyyy = x.getFullYear();
  const mm = String(x.getMonth() + 1).padStart(2, "0");
  const dd = String(x.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function fetchAggs5m(ticker) {
  const sym = String(ticker || "").trim().toUpperCase();
  const cacheKey = `${sym}|5m`;
  const now = Date.now();

  const hit = aggsCache.get(cacheKey);
  if (hit && now - hit.ts < 25_000) return { ok: true, cached: true, bars: hit.bars };

  const base = MASSIVE_AGGS_URL.replace(/\/+$/, "");
  const to = ymd(new Date());
  const from = ymd(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000));
  const url = `${base}/${encodeURIComponent(sym)}/range/5/minute/${from}/${to}`;

  const params = { adjusted: "true", sort: "desc", limit: String(AGGS_5M_LIMIT) };
  if (AGGS_INCLUDE_PREPOST) params.includePrePost = "true";

  const headers = {};
  const a = auth(params, headers);

  const r = await safeGet(url, { params: a.params, headers: a.headers });
  const bars = Array.isArray(r.data?.results) ? r.data.results : [];
  const ok = r.ok && bars.length > 0;

  if (ok) aggsCache.set(cacheKey, { ts: now, bars });

  return { ok, url, status: r.status, bars, errorDetail: r.errorDetail };
}

function attach5mSignals(row) {
  const price = n(row?.price);
  const vwap = n(row?.vwap_5m);
  const lastVol = n(row?.lastVol_5m);
  const avgVol = n(row?.avgVol_5m);

  const aboveVWAP = price !== null && vwap !== null ? price > vwap : false;
  const volSpike = lastVol !== null && avgVol !== null && avgVol > 0 ? lastVol >= avgVol * VOL_SPIKE_MULT : false;

  return {
    aboveVWAP_5m: aboveVWAP,
    volSpike_5m: volSpike,
    paIcon: paSignalIcon({ aboveVWAP_5m: aboveVWAP, volSpike_5m: volSpike }),
  };
}

// ============================================================================
// SECTION 10 — Session Utils (Pre/RTH/After)
// ============================================================================
function toMs(ts) {
  const x = n(ts);
  if (x === null) return null;
  if (x > 1e14) return Math.floor(x / 1e6);
  if (x > 1e12) return Math.floor(x);
  if (x > 1e9) return Math.floor(x * 1000);
  return null;
}

function nyHM(ms) {
  try {
    const d = new Date(ms);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return { h, m };
  } catch {
    return { h: 0, m: 0 };
  }
}

function sessionOfMs(ms) {
  const { h, m } = nyHM(ms);
  const mins = h * 60 + m;
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "pre";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "rth";
  if (mins >= 16 * 60 && mins < 20 * 60) return "after";
  return "off";
}

function snapshotTs(snap) {
  const t = snap?.lastTrade?.t ?? snap?.lastQuote?.t ?? snap?.updated ?? null;
  return toMs(t);
}

function addExtPct(row, rawSnap) {
  const prevClose = n(rawSnap?.prevDay?.c ?? rawSnap?.prevDay?.close) ?? null;
  const price = n(row?.price) ?? null;
  const extPct = price !== null && prevClose !== null && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null;
  return { ...row, extPct: extPct !== null ? round2(extPct) : null };
}

// ============================================================================
// SECTION 11 — HALT/RESUME WebSocket (LULD 17/18) + /halts API + attachHaltFlag
// ============================================================================
let WebSocketLib = null;
try {
  WebSocketLib = require("ws");
} catch (e) {
  WebSocketLib = null;
}

const haltedMap = new Map(); // symbol -> { halted, lastEvent, tsMs, reason }
function nowMs() { return Date.now(); }

function setHalt(sym) {
  haltedMap.set(sym, { halted: true, lastEvent: "HALT", tsMs: nowMs(), reason: "LULD" });
}
function setResume(sym) {
  haltedMap.set(sym, { halted: false, lastEvent: "RESUME", tsMs: nowMs(), reason: "LULD" });
}

function handleWsPayload(payload) {
  const msgs = Array.isArray(payload) ? payload : [payload];
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const ev = String(m.ev || m.event || "").toUpperCase();
    if (ev !== "LULD") continue;

    const sym = String(m.T || m.ticker || m.sym || "").trim().toUpperCase();
    if (!sym) continue;

    const indicators = Array.isArray(m.i) ? m.i : Array.isArray(m.indicators) ? m.indicators : [];
    if (indicators.includes(17)) setHalt(sym);
    if (indicators.includes(18)) setResume(sym);
  }
}

function startHaltWebSocket() {
  if (!ENABLE_HALT_WS) return;
  if (!WebSocketLib) {
    console.log("⚠️ ws package not installed. Run: npm i ws");
    return;
  }
  if (!MASSIVE_API_KEY) {
    console.log("⚠️ Missing MASSIVE_API_KEY. Halt WS disabled.");
    return;
  }

  const ws = new WebSocketLib(MASSIVE_WS_URL);

  ws.on("open", () => {
    try {
      ws.send(JSON.stringify({ action: "auth", params: MASSIVE_API_KEY }));
      ws.send(JSON.stringify({ action: "subscribe", params: "LULD.*" }));
      console.log("✅ HALT WS connected + subscribed LULD.*");
    } catch (e) {
      console.log("⚠️ HALT WS open error:", String(e?.message || e));
    }
  });

  ws.on("message", (buf) => {
    try {
      const parsed = JSON.parse(buf.toString("utf8"));
      handleWsPayload(parsed);
    } catch {
      // ignore
    }
  });

  ws.on("close", () => {
    console.log("⚠️ HALT WS closed. Reconnect in 3s...");
    setTimeout(startHaltWebSocket, 3000);
  });

  ws.on("error", (err) => {
    console.log("⚠️ HALT WS error:", String(err?.message || err));
  });
}

function attachHaltFlag(row) {
  const sym = String(row?.symbol || "").trim().toUpperCase();
  if (!sym) return row;
  const x = haltedMap.get(sym);
  const halted = Boolean(x?.halted);
  return {
    ...row,
    halted,
    haltIcon: halted ? "⛔" : "",
    haltReason: x?.reason || null,
    lastEvent: x?.lastEvent || null,
    haltTsMs: x?.tsMs || null,
  };
}

app.get("/halts", (req, res) => {
  const only = String(req.query.only || "halted").toLowerCase(); // halted|all
  const out = [];
  for (const [symbol, v] of haltedMap.entries()) {
    if (only === "halted" && !v.halted) continue;
    out.push({ symbol, ...v });
  }
  out.sort((a, b) => (b.tsMs ?? 0) - (a.tsMs ?? 0));
  res.json({ ok: true, count: out.length, results: out.slice(0, 500) });
});

// ============================================================================
// SECTION 12 — UI Renderer (renderUI)
// ============================================================================
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
  <title>ALGTP™ – Scanner</title>
  <style>
    :root { color-scheme: dark; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b0d12; color:#e6e8ef;}
    header { padding:16px 18px; border-bottom:1px solid rgba(255,255,255,.08); position:sticky; top:0; background:rgba(11,13,18,.92); backdrop-filter: blur(10px); z-index:20; }
    h1 { margin:0; font-size:16px; }
    .sub { margin-top:6px; font-size:12px; color:#a7adc2; }
    .wrap { max-width:1400px; margin:0 auto; }
    .panel { padding:14px 18px; border-bottom:1px solid rgba(255,255,255,.06); }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    select, input, button { background:#121622; border:1px solid rgba(255,255,255,.12); color:#e6e8ef; border-radius:12px; padding:9px 10px; font-size:13px; outline:none; }
    input { min-width:220px; }
    #symbols { min-width:240px; flex:1; }
    #minGap { min-width:200px; }
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
    .pill { display:inline-flex; align-items:center; gap:8px; padding:7px 10px; border-radius:999px; background:#121622; border:1px solid rgba(255,255,255,.12); font-size:12px; color:#c8cde0; }
    .pill input[type="checkbox"]{ transform: translateY(1px); }
    .symLink { color:#e6e8ef; text-decoration:none; border-bottom:1px dashed rgba(255,255,255,.25); cursor:pointer; }
    .symLink:hover { border-bottom-color: rgba(255,255,255,.55); }

    /* ===== HALT UI ===== */
    tr.haltRow td { background: rgba(255, 80, 80, .10) !important; }
    tr.resumeFlash td { background: rgba(80, 255, 140, .12) !important; }

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
    <h1>ALGTP™ – Scanner</h1>
    <div class="sub">RTH • Pre/After • SMA/EMA/VWAP • HALT/RESUME • Alerts • Auto refresh • Click ticker for chart</div>

    <div class="nav">
      <a href="/ui" style="${active("/ui")}">Dashboard</a>
      <a href="/ui/gainers" style="${active("/ui/gainers")}">Gainers</a>
      <a href="/ui/losers" style="${active("/ui/losers")}">Losers</a>
      <a href="/ui/gappers" style="${active("/ui/gappers")}">Gappers</a>
      <a href="/ui/smallcap" style="${active("/ui/smallcap")}">Small Cap</a>
      <a href="/ui/midcap" style="${active("/ui/midcap")}">Mid Cap</a>
      <a href="/ui/bigcap" style="${active("/ui/bigcap")}">Big Cap</a>
      <a href="/ui/premarket" style="${active("/ui/premarket")}">Pre-Market</a>
      <a href="/ui/aftermarket" style="${active("/ui/aftermarket")}">After-Hours</a>
      <a href="/ui/snapshot-all" style="${active("/ui/snapshot-all")}">Snapshot-All</a>
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
        <option value="premarket">Pre-Market (Snapshot)</option>
        <option value="aftermarket">After-Hours (Snapshot)</option>
        <option value="snapshotAll">Snapshot-All (All tickers)</option>
      </select>

      <select id="cap">
        <option value="all">Cap: All</option>
        <option value="small">Cap: Small (&lt;2B)</option>
        <option value="mid">Cap: Mid (2B–10B)</option>
        <option value="big">Cap: Big (&gt;10B)</option>
      </select>

      <select id="limit">
        <option>20</option><option>30</option><option selected>50</option><option>100</option><option>150</option>
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

      <span class="pill"><input id="openNewWin" type="checkbox" /> Open new window</span>
      <span class="pill"><input id="openNewTab" type="checkbox" checked /> New tab</span>

      <input id="alertScore" placeholder="Alert score >= (default 4)" style="min-width:180px;" />
      <input id="alertGap" placeholder="Alert gap% >= (default 20)" style="min-width:180px;" />
      <input id="alertPrice" placeholder="Alert price% >= (default 20)" style="min-width:200px;" />

      <input id="alertAboveVWAP" placeholder="Alert if Price > VWAP (5m): 1/0 (default 1)" style="min-width:260px;" />
      <input id="alertVolSpike" placeholder="Alert if VolSpike (5m): 1/0 (default 1)" style="min-width:260px;" />

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
      🔴 HALT row = red • 🟢 RESUME row = green flash • Tooltip shows HALT/RESUME reason.
      <br/>Click ticker: modal chart (default) or enable "Open new window" (or Ctrl/Cmd+Click).
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

// ===== RESUME flash memory =====
const resumeFlash = new Map(); // symbol -> expiresAt(ms)
function nowMs(){ return Date.now(); }
function shouldFlash(sym){
  const exp = resumeFlash.get(sym);
  if (!exp) return false;
  if (nowMs() > exp){ resumeFlash.delete(sym); return false; }
  return true;
}

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
function toBool01(val, def){
  const s = String(val ?? "").trim();
  if (s === "") return def;
  if (s === "1" || s.toLowerCase() === "true" || s.toLowerCase() === "yes") return true;
  if (s === "0" || s.toLowerCase() === "false" || s.toLowerCase() === "no") return false;
  return def;
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
    aboveVWAPOn: toBool01(byId("alertAboveVWAP").value, true),
    volSpikeOn: toBool01(byId("alertVolSpike").value, true),
  };
}
function shouldAlertRow(r, cfg){
  if (!cfg.alertsOn) return false;
  if (!r || !r.symbol) return false;
  if (r.halted) return false; // ✅ no alerts during HALT
  if (alerted.has(r.symbol)) return false;

  const score = Number(r.demandScore ?? 0);
  const gap = Number(r.gapPct ?? 0);
  const pc = Number(r.pricePct ?? r.extPct ?? 0);

  const aboveVWAP = Boolean(r.aboveVWAP_5m);
  const volSpike = Boolean(r.volSpike_5m);

  const classicHit = (score >= cfg.scoreTh) || (gap >= cfg.gapTh) || (pc >= cfg.priceTh);
  const vwapHit = (cfg.aboveVWAPOn && aboveVWAP) || (cfg.volSpikeOn && volSpike);

  return classicHit || vwapHit;
}
function fireAlert(r, cfg){
  alerted.add(r.symbol);
  const parts = [];
  if (r.pricePct != null) parts.push(\`Price%: \${r.pricePct}%\`);
  if (r.extPct != null) parts.push(\`Ext%: \${r.extPct}%\`);
  if (r.gapPct != null) parts.push(\`Gap%: \${r.gapPct}%\`);
  if (r.floatM != null) parts.push(\`Float(M): \${r.floatM}\`);
  if (r.marketCapB != null) parts.push(\`MCap(B): \${r.marketCapB}\`);

  if (r.sma26_5m != null) parts.push(\`SMA26(5m): \${r.sma26_5m}\`);
  if (r.ema9_5m != null) parts.push(\`EMA9(5m): \${r.ema9_5m}\`);
  if (r.ema34_5m != null) parts.push(\`EMA34(5m): \${r.ema34_5m}\`);
  if (r.vwap_5m != null) parts.push(\`VWAP(5m): \${r.vwap_5m}\`);
  if (r.aboveVWAP_5m) parts.push(\`Price>VWAP ✅\`);
  if (r.volSpike_5m) parts.push(\`VolSpike 🔊\`);

  const body = parts.join(" | ") || "Signal";
  if (cfg.soundOn) beep();
  if (cfg.desktopOn) pushNotification(\`\${r.haltIcon || ""}\${r.signalIcon || ""}\${r.paIcon ? " " + r.paIcon : ""} \${r.symbol}\`, body);
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

// -------- Chart Modal / New Window --------
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
function tvUrlFor(sym){
  const tvSymbol = buildTvSymbol(sym);
  const interval = tfSel.value || "5";
  return "https://www.tradingview.com/chart/?symbol=" + encodeURIComponent(tvSymbol) + "&interval=" + encodeURIComponent(interval);
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
function handleTickerClick(ev, sym){
  const forceNew = byId("openNewWin")?.checked;
  const modifier = ev && (ev.ctrlKey || ev.metaKey);
  if (forceNew || modifier){
    const url = tvUrlFor(sym);
    const newTab = byId("openNewTab")?.checked !== false;
    if (newTab) window.open(url, "_blank", "noopener,noreferrer");
    else window.location.href = url;
    return;
  }
  openChart(sym);
}

byId("closeBtn").addEventListener("click", closeModal);
modalBack.addEventListener("click", (e)=>{ if (e.target === modalBack) closeModal(); });
document.addEventListener("keydown", (e)=>{ if (e.key === "Escape") closeModal(); });

exSel.addEventListener("change", ()=>{ if (currentSymbol) renderChart(currentSymbol); });
tfSel.addEventListener("change", ()=>{ if (currentSymbol) renderChart(currentSymbol); });

// -------- Render Table --------
function renderList(data){
  const rows = Array.isArray(data.results) ? data.results : [];

  // flash green for RESUME for 8 seconds
  for (const r of rows){
    if (!r || !r.symbol) continue;
    if (r.halted === false && r.lastEvent === "RESUME") {
      resumeFlash.set(String(r.symbol), nowMs() + 8000);
    }
  }

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
            <th>PA</th>
            <th>Symbol</th>
            <th class="right">Price</th>
            <th class="right">Price%</th>
            <th class="right">Ext%</th>
            <th class="right">Gap%</th>
            <th class="right">Vol</th>
            <th class="right">Float(M)</th>
            <th>FloatCat</th>
            <th class="right">MCap(B)</th>
            <th>Cap</th>
            <th class="right">Score</th>
            <th class="right">SMA26</th>
            <th class="right">EMA9</th>
            <th class="right">EMA34</th>
            <th class="right">VWAP</th>
          </tr>
        </thead>
        <tbody>
          \${rows.map(r => {
            const sym = String(r.symbol||"");
            const isHalt = Boolean(r.halted);
            const flash = shouldFlash(sym);
            const rowClass = isHalt ? "haltRow" : (flash ? "resumeFlash" : "");
            const tip = isHalt
              ? \`HALT – \${r.haltReason || "LULD"}\`
              : (flash ? \`RESUME – \${r.haltReason || "LULD"}\` : "");
            return \`
              <tr class="\${rowClass}" title="\${tip}">
                <td>\${r.haltIcon || ""}\${r.signalIcon || ""}</td>
                <td>\${r.paIcon || ""}</td>
                <td class="mono">
                  <a class="symLink" href="javascript:void(0)" onclick="handleTickerClick(event,'\${String(r.symbol||"").replace(/'/g,"")}')">\${r.symbol || ""}</a>
                </td>
                <td class="right mono">\${fmtNum(r.price)}</td>
                <td class="right mono">\${fmtNum(r.pricePct)}%</td>
                <td class="right mono">\${fmtNum(r.extPct)}%</td>
                <td class="right mono">\${fmtNum(r.gapPct)}%</td>
                <td class="right mono">\${fmtInt(r.volume)}</td>
                <td class="right mono">\${fmtNum(r.floatM)}</td>
                <td>\${r.floatCat || "-"}</td>
                <td class="right mono">\${fmtNum(r.marketCapB)}</td>
                <td>\${r.cap || "-"}</td>
                <td class="right mono">\${r.demandScore ?? "-"}</td>
                <td class="right mono">\${fmtNum(r.sma26_5m)}</td>
                <td class="right mono">\${fmtNum(r.ema9_5m)}</td>
                <td class="right mono">\${fmtNum(r.ema34_5m)}</td>
                <td class="right mono">\${fmtNum(r.vwap_5m)}</td>
              </tr>\`;
          }).join("")}
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

    if (group === "premarket") {
      url = \`/premarket?cap=\${encodeURIComponent(cap)}&limit=\${encodeURIComponent(limit)}\`;
    } else if (group === "aftermarket") {
      url = \`/aftermarket?cap=\${encodeURIComponent(cap)}&limit=\${encodeURIComponent(limit)}\`;
    } else if (group === "snapshotAll") {
      url = \`/snapshot-all?cap=\${encodeURIComponent(cap)}&limit=\${encodeURIComponent(limit)}\`;
    } else {
      url = \`/list?group=\${encodeURIComponent(group)}&cap=\${encodeURIComponent(cap)}&limit=\${encodeURIComponent(limit)}\`;
      if (minGap) url += \`&minGap=\${encodeURIComponent(minGap)}\`;
    }
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

    if (data.snapshotErrors && data.snapshotErrors.length) showError({ snapshotErrors: data.snapshotErrors });
    if (data.aggsErrors && data.aggsErrors.length) showError({ aggsErrors: data.aggsErrors });
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
  byId("alertAboveVWAP").value = "1";
  byId("alertVolSpike").value = "1";

  byId("autoSec").value = "30";
  countdownBadge.textContent = "-";
}

byId("runBtn").addEventListener("click", run);
byId("notifyBtn").addEventListener("click", enableNotifications);
byId("clearAlertsBtn").addEventListener("click", ()=>{ alerted.clear(); alert("Alert memory cleared."); });

byId("applyAutoBtn").addEventListener("click", applyAuto);
byId("stopAutoBtn").addEventListener("click", stopAuto);

byId("mode").addEventListener("change", ()=>{ stopAuto(); });

setPreset();
run();
</script>
</body>
</html>`;
}

// ============================================================================
// SECTION 13 — UI Routes
// ============================================================================
app.get("/ui", (req, res) => res.type("html").send(renderUI({ path: "/ui", group: "topGainers", cap: "all", limit: 50 })));
app.get("/ui/gainers", (req, res) => res.type("html").send(renderUI({ path: "/ui/gainers", group: "topGainers", cap: "all", limit: 50 })));
app.get("/ui/losers", (req, res) => res.type("html").send(renderUI({ path: "/ui/losers", group: "topLosers", cap: "all", limit: 50 })));
app.get("/ui/gappers", (req, res) => res.type("html").send(renderUI({ path: "/ui/gappers", group: "topGappers", cap: "all", limit: 80, minGap: 10 })));
app.get("/ui/smallcap", (req, res) => res.type("html").send(renderUI({ path: "/ui/smallcap", group: "topGainers", cap: "small", limit: 80 })));
app.get("/ui/midcap", (req, res) => res.type("html").send(renderUI({ path: "/ui/midcap", group: "topGainers", cap: "mid", limit: 80 })));
app.get("/ui/bigcap", (req, res) => res.type("html").send(renderUI({ path: "/ui/bigcap", group: "topGainers", cap: "big", limit: 80 })));

app.get("/ui/premarket", (req, res) => res.type("html").send(renderUI({ path: "/ui/premarket", group: "premarket", cap: "all", limit: 80 })));
app.get("/ui/aftermarket", (req, res) => res.type("html").send(renderUI({ path: "/ui/aftermarket", group: "aftermarket", cap: "all", limit: 80 })));
app.get("/ui/snapshot-all", (req, res) => res.type("html").send(renderUI({ path: "/ui/snapshot-all", group: "snapshotAll", cap: "all", limit: 100 })));

// ============================================================================
// SECTION 14 — Base API Routes
// ============================================================================
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "ALGTP™ Scanner running ✅",
    ui: "/ui",
    endpoints: ["/scan", "/list", "/snapshot-all", "/premarket", "/aftermarket", "/halts"],
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
      snapshotAllUrl: MASSIVE_SNAPSHOT_ALL_URL,
      aggsUrl: MASSIVE_AGGS_URL,
      includePrePost: AGGS_INCLUDE_PREPOST,
      enable5mIndicators: ENABLE_5M_INDICATORS,
      aggs5mLimit: AGGS_5M_LIMIT,
      snapConcurrency: SNAP_CONCURRENCY,
      includeOtc: INCLUDE_OTC,
      haltWs: ENABLE_HALT_WS,
      wsUrl: MASSIVE_WS_URL,
    },
  });
});

// ============================================================================
// SECTION 15 — /scan (Symbols) + /list (Movers)
// ============================================================================
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

    const aggsErrors = [];
    if (ENABLE_5M_INDICATORS) {
      const ind = await mapPool(rows, SNAP_CONCURRENCY, async (r) => {
        const a = await fetchAggs5m(r.symbol);
        if (!a.ok) {
          aggsErrors.push({ ticker: r.symbol, status: a.status, url: a.url, errorDetail: a.errorDetail });
          return { symbol: r.symbol, sma26_5m: null, ema9_5m: null, ema34_5m: null, vwap_5m: null, lastVol_5m: null, avgVol_5m: null };
        }
        return { symbol: r.symbol, ...indicatorsFromAggs5m(a.bars) };
      });

      const mapInd = new Map(ind.map((x) => [x.symbol, x]));
      rows = rows.map((r) => ({ ...r, ...(mapInd.get(r.symbol) || {}) }));
      rows = rows.map((r) => ({ ...r, ...attach5mSignals(r) }));
    }

    rows = rows.map((r) => {
      const d = demandScore(r);
      return { ...r, demandScore: d, signalIcon: signalIcon(d), paIcon: r.paIcon || "" };
    });

    rows = rows.map(attachHaltFlag);

    rows.sort(
      (a, b) =>
        (b.demandScore ?? 0) - (a.demandScore ?? 0) ||
        (b.aboveVWAP_5m === true) - (a.aboveVWAP_5m === true) ||
        Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0)
    );

    res.json({
      ok: true,
      mode: "symbols",
      results: rows,
      snapshotErrors: DEBUG
        ? bad.slice(0, 10).map((x) => ({ ticker: x.ticker, status: x.status, url: x.url, errorDetail: x.errorDetail }))
        : undefined,
      aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Scan failed", detail: String(e?.message || e) });
  }
});

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

    // widen universe so mid/big filter doesn't end up empty
    const tickers = movers.rows
      .map((x) => String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase())
      .filter(Boolean)
      .slice(0, limit * 3);

    const snaps = await mapPool(tickers, SNAP_CONCURRENCY, async (t) => {
      const r = await fetchTickerSnapshot(t);
      return { ticker: t, ...r };
    });

    const good = snaps.filter((x) => x.ok);
    const bad = snaps.filter((x) => !x.ok);

    let rows = good.map((x) => normalizeSnapshotAuto(x.ticker, x.data));
    rows = rows.filter((r) => capPass(r, cap));

    if (minGap !== null && Number.isFinite(minGap)) {
      rows = rows.filter((r) => (r.gapPct ?? 0) >= minGap);
    }

    rows = rows.slice(0, limit);

    const aggsErrors = [];
    if (ENABLE_5M_INDICATORS) {
      const ind = await mapPool(rows, SNAP_CONCURRENCY, async (r) => {
        const a = await fetchAggs5m(r.symbol);
        if (!a.ok) {
          aggsErrors.push({ ticker: r.symbol, status: a.status, url: a.url, errorDetail: a.errorDetail });
          return { symbol: r.symbol, sma26_5m: null, ema9_5m: null, ema34_5m: null, vwap_5m: null, lastVol_5m: null, avgVol_5m: null };
        }
        return { symbol: r.symbol, ...indicatorsFromAggs5m(a.bars) };
      });

      const mapInd = new Map(ind.map((x) => [x.symbol, x]));
      rows = rows.map((r) => ({ ...r, ...(mapInd.get(r.symbol) || {}) }));
      rows = rows.map((r) => ({ ...r, ...attach5mSignals(r) }));
    }

    rows = rows.map((r) => {
      const d = demandScore(r);
      return { ...r, demandScore: d, signalIcon: signalIcon(d), paIcon: r.paIcon || "" };
    });

    rows = rows.map(attachHaltFlag);

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
      aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "List failed", detail: String(e?.message || e) });
  }
});

// ============================================================================
// SECTION 16 — Snapshot-All / Pre / After (API)
// ============================================================================
async function buildRowsFromSnapshotAll({ cap, limit, session }) {
  const miss = envMissing();
  if (miss.length) return { ok: false, status: 400, body: { ok: false, error: "Missing env", miss } };

  const snap = await fetchSnapshotAll();
  if (!snap.ok) return { ok: false, status: 500, body: { ok: false, error: "Snapshot-all failed", debug: snap } };

  const snapMap = new Map();
  for (const x of snap.rows) {
    const t = String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase();
    if (t) snapMap.set(t, x);
  }

  let rows = [];
  for (const [ticker, rawSnap] of snapMap.entries()) {
    rows.push(addExtPct(normalizeSnapshotAuto(ticker, rawSnap), rawSnap));
  }

  if (session) {
    rows = rows.filter((r) => {
      const raw = snapMap.get(r.symbol);
      const ms = snapshotTs(raw);
      if (!ms) return false;
      return sessionOfMs(ms) === session;
    });
  }

  rows = rows.filter((r) => capPass(r, cap));

  const aggsErrors = [];
  if (ENABLE_5M_INDICATORS) {
    const ind = await mapPool(rows, SNAP_CONCURRENCY, async (r) => {
      const a = await fetchAggs5m(r.symbol);
      if (!a.ok) {
        aggsErrors.push({ ticker: r.symbol, status: a.status, url: a.url, errorDetail: a.errorDetail });
        return { symbol: r.symbol, sma26_5m: null, ema9_5m: null, ema34_5m: null, vwap_5m: null, lastVol_5m: null, avgVol_5m: null };
      }
      return { symbol: r.symbol, ...indicatorsFromAggs5m(a.bars) };
    });

    const mapInd = new Map(ind.map((x) => [x.symbol, x]));
    rows = rows.map((r) => ({ ...r, ...(mapInd.get(r.symbol) || {}) }));
    rows = rows.map((r) => ({ ...r, ...attach5mSignals(r) }));
  }

  rows = rows.map((r) => {
    const d = demandScore(r);
    return { ...r, demandScore: d, signalIcon: signalIcon(d), paIcon: r.paIcon || "" };
  });

  rows = rows.map(attachHaltFlag);

  rows.sort(
    (a, b) =>
      Math.abs(b.extPct ?? 0) - Math.abs(a.extPct ?? 0) ||
      Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0) ||
      (b.volume ?? 0) - (a.volume ?? 0)
  );

  const lim = clamp(Number(limit || 100), 5, 500);
  rows = rows.slice(0, lim);

  return { ok: true, status: 200, body: { ok: true, results: rows, aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined } };
}

app.get("/snapshot-all", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = req.query.limit;
  const out = await buildRowsFromSnapshotAll({ cap, limit, session: null });
  return res.status(out.status).json(out.body);
});

app.get("/premarket", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = req.query.limit;
  const out = await buildRowsFromSnapshotAll({ cap, limit, session: "pre" });
  return res.status(out.status).json(out.body);
});

app.get("/aftermarket", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = req.query.limit;
  const out = await buildRowsFromSnapshotAll({ cap, limit, session: "after" });
  return res.status(out.status).json(out.body);
});

// ============================================================================
// SECTION 17 — Optional Dividends API
// ============================================================================
app.get("/dividends", async (req, res) => {
  try {
    const miss = envMissing();
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const ticker = String(req.query.ticker || "").trim().toUpperCase();
    const limit = clamp(Number(req.query.limit || 50), 1, 1000);
    const order = String(req.query.order || "desc").toLowerCase() === "asc" ? "asc" : "desc";
    const sort = String(req.query.sort || "ex_dividend_date").trim();

    const url = MASSIVE_DIVIDENDS_URL.replace(/\/+$/, "");
    const params = { limit: String(limit), order, sort };
    if (ticker) params.ticker = ticker;

    const headers = {};
    const a = auth(params, headers);

    const r = await safeGet(url, { params: a.params, headers: a.headers });

    const rows =
      Array.isArray(r.data?.results) ? r.data.results :
      Array.isArray(r.data?.dividends) ? r.data.dividends :
      Array.isArray(r.data?.data) ? r.data.data :
      [];

    return res.json({
      ok: r.ok,
      status: r.status,
      ticker: ticker || null,
      count: rows.length,
      results: rows,
      errorDetail: r.ok ? undefined : r.errorDetail,
      rawSample: DEBUG ? r.data : undefined,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Dividends failed", detail: String(e?.message || e) });
  }
});

// ============================================================================
// SECTION 18 — Listen
// ============================================================================
startHaltWebSocket();

app.listen(PORT, () => {
  console.log(`✅ ALGTP™ Scanner running http://localhost:${PORT}`);
  console.log(`🚀 UI: http://localhost:${PORT}/ui`);
  console.log(`⛔ HALTS: http://localhost:${PORT}/halts`);
});
