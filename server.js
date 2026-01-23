// server.js
try { require("dotenv").config(); } catch (_) {}

const express = require("express");
const axios = require("axios");
const { clerkMiddleware, requireAuth, getAuth } = require("@clerk/express");

const app = express();
app.use(express.json());

// ================= PORT =================
const PORT = Number(process.env.PORT || 3000);

// ================= CLERK (optional) =================
const CLERK_PUBLISHABLE_KEY = String(process.env.CLERK_PUBLISHABLE_KEY || "").trim();
const CLERK_SECRET_KEY = String(process.env.CLERK_SECRET_KEY || "").trim();
const CLERK_ENABLED = Boolean(CLERK_SECRET_KEY);

if (CLERK_ENABLED) {
  app.use(clerkMiddleware());
  console.log("✅ Clerk enabled");
} else {
  console.log("⚠️ Clerk disabled (no CLERK_SECRET_KEY)");
}
const maybeRequireAuth = CLERK_ENABLED ? requireAuth() : (req, res, next) => next();

// ===================== MASSIVE ENV (ONE BLOCK ONLY) =====================
const MASSIVE_API_KEY = String(process.env.MASSIVE_API_KEY || "").trim();

// auth mode
const MASSIVE_AUTH_TYPE = String(process.env.MASSIVE_AUTH_TYPE || "query").trim(); // query | xapi | bearer
const MASSIVE_QUERY_KEYNAME = String(process.env.MASSIVE_QUERY_KEYNAME || "apiKey").trim();

// endpoints
const MASSIVE_MOVER_URL = String(
  process.env.MASSIVE_MOVER_URL || "https://api.massive.com/v2/snapshot/locale/us/markets/stocks"
).trim();

const MASSIVE_TICKER_SNAPSHOT_URL = String(
  process.env.MASSIVE_TICKER_SNAPSHOT_URL || "https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers"
).trim();

const MASSIVE_AGGS_URL = String(
  process.env.MASSIVE_AGGS_URL || "https://api.massive.com/v2/aggs/ticker"
).trim();

// toggles
const INCLUDE_OTC = String(process.env.INCLUDE_OTC || "false").toLowerCase() === "true";
const SNAP_CONCURRENCY = clamp(Number(process.env.SNAP_CONCURRENCY || 4), 1, 10);
const DEBUG = String(process.env.DEBUG || "false").toLowerCase() === "true";

const ENABLE_5M_INDICATORS = String(process.env.ENABLE_5M_INDICATORS || "true").toLowerCase() === "true";
const AGGS_5M_LIMIT = clamp(Number(process.env.AGGS_5M_LIMIT || 80), 40, 5000);

const VOL_SPIKE_MULT = clamp(Number(process.env.VOL_SPIKE_MULT || 1.5), 1.1, 10);
const VOL_AVG_LEN_5M = clamp(Number(process.env.VOL_AVG_LEN_5M || 20), 5, 200);

// ===================== Helpers =====================
function clamp(x, a, b) {
  const v = Number(x);
  if (!Number.isFinite(v)) return a;
  return Math.max(a, Math.min(b, v));
}

function envMissing() {
  const miss = [];
  if (!MASSIVE_API_KEY) miss.push("MASSIVE_API_KEY");
  if (!MASSIVE_MOVER_URL) miss.push("MASSIVE_MOVER_URL");
  if (!MASSIVE_TICKER_SNAPSHOT_URL) miss.push("MASSIVE_TICKER_SNAPSHOT_URL");
  if (!MASSIVE_AGGS_URL) miss.push("MASSIVE_AGGS_URL");
  return miss;
}

function auth(params = {}, headers = {}) {
  const t = String(MASSIVE_AUTH_TYPE || "query").toLowerCase();

  if (t === "query") params[MASSIVE_QUERY_KEYNAME || "apiKey"] = MASSIVE_API_KEY;
  else if (t === "xapi") headers["x-api-key"] = MASSIVE_API_KEY;
  else if (t === "bearer") headers["authorization"] = `Bearer ${MASSIVE_API_KEY}`;
  else params[MASSIVE_QUERY_KEYNAME || "apiKey"] = MASSIVE_API_KEY;

  headers["user-agent"] =
    headers["user-agent"] ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari";

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

function ymd(d) {
  const x = new Date(d);
  const yyyy = x.getFullYear();
  const mm = String(x.getMonth() + 1).padStart(2, "0");
  const dd = String(x.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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

// ================= AXIOS SAFE =================
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

// ================= MASSIVE CALLS =================
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
    : [];

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

// ===================== Aggs 5m + indicators =====================
const aggsCache = new Map(); // key: "TICKER|5m" -> { ts, bars }

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
  const headers = {};
  const a = auth(params, headers);

  const r = await safeGet(url, { params: a.params, headers: a.headers });
  const bars = Array.isArray(r.data?.results) ? r.data.results : [];
  const ok = r.ok && bars.length > 0;

  if (ok) aggsCache.set(cacheKey, { ts: now, bars });

  return { ok, url, status: r.status, bars, errorDetail: r.errorDetail };
}

function computeSMA(values, len) {
  if (!Array.isArray(values) || values.length < len) return null;
  let sum = 0;
  for (let i = values.length - len; i < values.length; i++) sum += values[i];
  return sum / len;
}

function computeEMA(values, len) {
  if (!Array.isArray(values) || values.length < len) return null;
  const k = 2 / (len + 1);

  // seed SMA of first len (chronological)
  const seedArr = values.slice(0, len);
  if (seedArr.length < len) return null;
  let ema = seedArr.reduce((a, b) => a + b, 0) / len;

  for (let i = len; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function computeVWAP(closes, volumes) {
  if (!Array.isArray(closes) || !Array.isArray(volumes) || closes.length === 0 || closes.length !== volumes.length)
    return null;
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
      vwapBar_5m: null,
      lastVol_5m: null,
      avgVol_5m: null,
    };
  }

  // barsDesc is usually DESC from API (sort=desc). We'll normalize then reverse to chrono.
  const bars = barsDesc
    .map((b) => ({
      c: n(b?.c ?? b?.close),
      v: n(b?.v ?? b?.volume),
      vw: n(b?.vw),
    }))
    .filter((x) => x.c !== null)
    .slice(0, 400);

  const barsChrono = [...bars].reverse();
  const closes = barsChrono.map((x) => x.c);
  const vols = barsChrono.map((x) => x.v ?? 0);

  const sma26 = computeSMA(closes, 26);
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
    vwapBar_5m: lastBar?.vw !== null && lastBar?.vw !== undefined ? round2(lastBar.vw) : null,
    lastVol_5m: lastVol !== null ? Math.round(lastVol) : null,
    avgVol_5m: avgVol !== null ? Math.round(avgVol) : null,
  };
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
    paIcon: aboveVWAP && volSpike ? "🚨" : aboveVWAP ? "✅" : volSpike ? "🔊" : "",
  };
}

// ================= NORMALIZE SNAPSHOT =================
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

  const price = lastTradePrice ?? dayClose ?? null;
  const open = n(day?.o ?? day?.open ?? root?.open) ?? null;
  const volume = n(day?.v ?? day?.volume ?? root?.volume ?? root?.dayVolume) ?? null;

  let pricePct =
    n(root?.todaysChangePerc) ??
    n(root?.todaysChangePercent) ??
    n(root?.changePerc) ??
    n(root?.changePercent) ??
    null;

  if (pricePct === null && price !== null && prevClose !== null && prevClose > 0) {
    pricePct = ((price - prevClose) / prevClose) * 100;
  }

  const gapPct = open !== null && prevClose !== null && prevClose > 0 ? ((open - prevClose) / prevClose) * 100 : null;

  return {
    symbol: String(ticker || "").trim().toUpperCase(),
    price: price !== null ? round2(price) : null,
    pricePct: pricePct !== null ? round2(pricePct) : null,
    gapPct: gapPct !== null ? round2(gapPct) : null,
    volume: volume !== null ? Math.round(volume) : null,
  };
}

// ================= HTML UI =================
function renderLoginPageClerk() {
  if (!CLERK_PUBLISHABLE_KEY) return "<h2>Missing CLERK_PUBLISHABLE_KEY</h2>";

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
    .box{max-width:560px;margin:10vh auto;padding:24px;border-radius:18px;
      border:1px solid rgba(255,255,255,.14);background:rgba(18,24,43,.55)}
    .muted{opacity:.8;font-size:12px;margin-top:10px;text-align:center}
  </style>
</head>
<body>
  <div class="box">
    <h2 style="text-align:center;margin:0 0 14px;">🔐 Login</h2>
    <div id="clerk-signin"></div>
    <div class="muted">After login → /ui</div>
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

function renderLogoutPage() {
  if (!CLERK_PUBLISHABLE_KEY) return `<script>location.href="/login"</script>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Logout</title>
  <script async crossorigin="anonymous"
    data-clerk-publishable-key="${CLERK_PUBLISHABLE_KEY}"
    src="https://js.clerk.com/v4/clerk.browser.js">
  </script>
</head>
<body style="margin:0;background:#0b0d12;color:#e6e8ef;font-family:system-ui;display:grid;place-items:center;height:100vh">
  <div>Signing out...</div>
  <script>
    window.addEventListener("load", async () => {
      try{
        await Clerk.load();
        await Clerk.signOut();
      }catch(e){}
      location.href="/login";
    });
  </script>
</body>
</html>`;
}

function renderUI(userId) {
  return `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
</head>
<body style="background:#111;color:white;font-family:system-ui;margin:0;padding:18px">
  <h2 style="margin:0 0 8px">ALGTP Scanner</h2>
  <div style="opacity:.8;margin-bottom:12px">User: ${userId || "DEV MODE"}</div>

  <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
    <button onclick="scan('NVDA,TSLA,AAPL')">Scan NVDA,TSLA,AAPL</button>
    <button onclick="list()">List Top Gainers</button>
    <button onclick="location.href='/logout'">Logout</button>
  </div>

  <pre id="out" style="white-space:pre-wrap;background:#0b0d12;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.12)"></pre>

<script>
async function scan(symbols){
  const r = await fetch("/scan?symbols="+encodeURIComponent(symbols));
  const j = await r.json();
  document.getElementById("out").textContent = JSON.stringify(j,null,2);
}
async function list(){
  const r = await fetch("/list");
  const j = await r.json();
  document.getElementById("out").textContent = JSON.stringify(j,null,2);
}
</script>
</body>
</html>`;
}

// ================= ROUTES =================
app.get("/", (req, res) => res.redirect("/ui"));

app.get("/login", (req, res) => {
  if (!CLERK_ENABLED) return res.redirect("/ui");
  res.type("html").send(renderLoginPageClerk());
});

app.get("/logout", (req, res) => {
  if (!CLERK_ENABLED) return res.redirect("/ui");
  res.type("html").send(renderLogoutPage());
});

app.get("/ui", maybeRequireAuth, (req, res) => {
  const authInfo = CLERK_ENABLED ? getAuth(req) : {};
  res.type("html").send(renderUI(authInfo.userId));
});

// ================= API: scan custom symbols =================
app.get("/scan", async (req, res) => {
  try {
    const miss = envMissing();
    if (miss.length) return res.status(400).json({ ok: false, miss });

    const symbols = parseSymbols(req.query.symbols || "NVDA,TSLA,AAPL");

    const snaps = await mapPool(symbols, SNAP_CONCURRENCY, async (t) => {
      const r = await fetchTickerSnapshot(t);
      if (!r.ok) return null;

      let row = normalizeSnapshotAuto(t, r.data);

      if (ENABLE_5M_INDICATORS) {
        const a = await fetchAggs5m(t);
        if (a.ok) {
          const ind = indicatorsFromAggs5m(a.bars);
          row = { ...row, ...ind, ...attach5mSignals({ ...row, ...ind }) };
        } else if (DEBUG) {
          row = { ...row, aggs5mError: a.errorDetail || { status: a.status, url: a.url } };
        }
      }

      return row;
    });

    res.json({ ok: true, results: snaps.filter(Boolean) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ================= API: list top movers =================
app.get("/list", async (req, res) => {
  try {
    const miss = envMissing();
    if (miss.length) return res.status(400).json({ ok: false, miss });

    const direction = String(req.query.direction || "gainers").toLowerCase() === "losers" ? "losers" : "gainers";
    const limit = clamp(Number(req.query.limit || 20), 1, 100);

    const movers = await fetchMovers(direction);
    if (!movers.ok) {
      return res.status(502).json({
        ok: false,
        error: "fetchMovers failed",
        status: movers.status,
        sample: movers.sample,
        errorDetail: movers.errorDetail,
        url: movers.url,
      });
    }

    const tickers = movers.rows.slice(0, limit).map((x) => x.ticker || x.symbol).filter(Boolean);

    const snaps = await mapPool(tickers, SNAP_CONCURRENCY, async (t) => {
      const r = await fetchTickerSnapshot(t);
      if (!r.ok) return null;

      let row = normalizeSnapshotAuto(t, r.data);

      if (ENABLE_5M_INDICATORS) {
        const a = await fetchAggs5m(t);
        if (a.ok) {
          const ind = indicatorsFromAggs5m(a.bars);
          row = { ...row, ...ind, ...attach5mSignals({ ...row, ...ind }) };
        } else if (DEBUG) {
          row = { ...row, aggs5mError: a.errorDetail || { status: a.status, url: a.url } };
        }
      }

      return row;
    });

    res.json({ ok: true, direction, results: snaps.filter(Boolean) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});


// ===================== HTML: Scanner UI (Protected) =====================
function renderScannerUI(preset = {}, authInfo = {}) {
  const presetGroup = preset.group || "topGainers";
  const presetCap = preset.cap || "all";
  const presetLimit = preset.limit || 50;
  const presetMinGap = preset.minGap ?? "";
  const presetSymbols = preset.symbols ?? "NVDA,TSLA,AAPL";
  const active = (path) => (preset.path === path ? "opacity:1" : "opacity:.65");

  const userLine = CLERK_ENABLED
    ? `<div class="sub">Signed in: <span class="mono">${String(authInfo.userId || "unknown")}</span> • <a href="/logout">Logout</a></div>`
    : `<div class="sub">Auth: <b>OFF</b> (dev mode) • <a href="/login">Login</a></div>`;

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
    <div class="sub">Gainers • Losers • Gappers • Small/Mid/Big Cap • Alerts • Auto Refresh • Click ticker for chart • 5m SMA/EMA/VWAP</div>
    ${userLine}

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
      Click any ticker to open a TradingView chart. If a symbol does not load, switch exchange in the chart (NASDAQ/NYSE/AMEX).
      <br/>5m indicators used: <b>SMA26</b>, <b>EMA9</b>, <b>EMA34</b>, <b>VWAP</b>. Alerts will fire when Price&gt;VWAP and/or 5m volume spike.
    </div>

    <div class="err" id="errBox"></div>
  </div>
</div>

<div class="grid">
  <div class="wrap" id="out"></div>
</div>

<div class="watermark">Powered by ALGTP™</div>

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
  if (alerted.has(r.symbol)) return false;

  const score = Number(r.demandScore ?? 0);
  const gap = Number(r.gapPct ?? 0);
  const pc = Number(r.pricePct ?? 0);

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
  if (cfg.desktopOn) pushNotification(\`\${r.signalIcon || ""}\${r.paIcon ? " " + r.paIcon : ""} \${r.symbol}\`, body);
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

// -------- Chart Modal --------
const modalBack = byId("modalBack");
const modalTitle = byId("modalTitle");
const chartBox = byId("chartBox");
const exSel = byId("exSel");
const tfSel = byId("tfSel");
let currentSymbol = null;

function openModal(){ modalBack.style.display = "flex"; modalBack.setAttribute("aria-hidden", "false"); }
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
            <th>PA</th>
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
            <th class="right">SMA26(5m)</th>
            <th class="right">EMA9(5m)</th>
            <th class="right">EMA34(5m)</th>
            <th class="right">VWAP(5m)</th>
          </tr>
        </thead>
        <tbody>
          \${rows.map(r => \`
            <tr>
              <td>\${r.signalIcon || ""}</td>
              <td>\${r.paIcon || ""}</td>
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
              <td class="right mono">\${fmtNum(r.sma26_5m)}</td>
              <td class="right mono">\${fmtNum(r.ema9_5m)}</td>
              <td class="right mono">\${fmtNum(r.ema34_5m)}</td>
              <td class="right mono">\${fmtNum(r.vwap_5m)}</td>
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

// -------- Run --------
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
    if (data.aggsErrors && data.aggsErrors.length){
      showError({ aggsErrors: data.aggsErrors });
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

// ===================== ROUTES =====================

// Home → UI
app.get("/", (req, res) => res.redirect(302, "/ui"));

// Health
app.get("/health", (req, res) => {
  res.json({ ok: true, login: "/login", ui: "/ui", clerkEnabled: CLERK_ENABLED });
});

// Login page (only meaningful if Clerk enabled)
app.get("/login", (req, res) => {
  if (!CLERK_ENABLED) return res.redirect(302, "/ui");
  res.type("html").send(renderLoginPageClerk());
});

// Logout page
app.get("/logout", (req, res) => {
  if (!CLERK_ENABLED) return res.redirect(302, "/ui");
  res.type("html").send(renderLogoutPage());
});

// Debug api
app.get("/api", (req, res) => {
  res.json({
    ok: true,
    clerkEnabled: CLERK_ENABLED,
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
      aggsUrl: MASSIVE_AGGS_URL,
      enable5mIndicators: ENABLE_5M_INDICATORS,
      aggs5mLimit: AGGS_5M_LIMIT,
      volSpikeMult: VOL_SPIKE_MULT,
      volAvgLen5m: VOL_AVG_LEN_5M,
    },
  });
});

// ===================== UI routes (Protected) =====================
function getAuthInfo(req) {
  if (!CLERK_ENABLED) return { userId: null };
  const a = getAuth(req);
  return { userId: a?.userId || null };
}

app.get("/ui", maybeRequireAuth, (req, res) =>
  res.type("html").send(renderScannerUI({ path: "/ui", group: "topGainers", cap: "all", limit: 50 }, getAuthInfo(req)))
);

app.get("/ui/gainers", maybeRequireAuth, (req, res) =>
  res
    .type("html")
    .send(renderScannerUI({ path: "/ui/gainers", group: "topGainers", cap: "all", limit: 50 }, getAuthInfo(req)))
);

app.get("/ui/losers", maybeRequireAuth, (req, res) =>
  res
    .type("html")
    .send(renderScannerUI({ path: "/ui/losers", group: "topLosers", cap: "all", limit: 50 }, getAuthInfo(req)))
);

app.get("/ui/gappers", maybeRequireAuth, (req, res) =>
  res
    .type("html")
    .send(renderScannerUI({ path: "/ui/gappers", group: "topGappers", cap: "all", limit: 80, minGap: 10 }, getAuthInfo(req)))
);

app.get("/ui/smallcap", maybeRequireAuth, (req, res) =>
  res
    .type("html")
    .send(renderScannerUI({ path: "/ui/smallcap", group: "topGainers", cap: "small", limit: 80 }, getAuthInfo(req)))
);

app.get("/ui/midcap", maybeRequireAuth, (req, res) =>
  res
    .type("html")
    .send(renderScannerUI({ path: "/ui/midcap", group: "topGainers", cap: "mid", limit: 80 }, getAuthInfo(req)))
);

app.get("/ui/bigcap", maybeRequireAuth, (req, res) =>
  res
    .type("html")
    .send(renderScannerUI({ path: "/ui/bigcap", group: "topGainers", cap: "big", limit: 80 }, getAuthInfo(req)))
);

// ===================== API routes =====================

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

    const aggsErrors = [];
    if (ENABLE_5M_INDICATORS) {
      const ind = await mapPool(rows, SNAP_CONCURRENCY, async (r) => {
        const a = await fetchAggs5m(r.symbol);
        if (!a.ok) {
          aggsErrors.push({ ticker: r.symbol, status: a.status, url: a.url, errorDetail: a.errorDetail });
          return {
            symbol: r.symbol,
            __aggsOk: false,
            sma26_5m: null,
            ema9_5m: null,
            ema34_5m: null,
            vwap_5m: null,
            vwapBar_5m: null,
            lastVol_5m: null,
            avgVol_5m: null,
          };
        }
        const ii = indicatorsFromAggs5m(a.bars);
        return { symbol: r.symbol, __aggsOk: true, ...ii };
      });

      const mapInd = new Map(ind.map((x) => [x.symbol, x]));
      rows = rows.map((r) => ({ ...r, ...(mapInd.get(r.symbol) || {}) }));
      rows = rows.map((r) => ({ ...r, ...attach5mSignals(r) }));
    }

    rows = rows.map((r) => {
      const d = demandScore(r);
      return { ...r, demandScore: d, signalIcon: signalIcon(d), paIcon: r.paIcon || "" };
    });

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

    const aggsErrors = [];
    if (ENABLE_5M_INDICATORS) {
      const ind = await mapPool(rows, SNAP_CONCURRENCY, async (r) => {
        const a = await fetchAggs5m(r.symbol);
        if (!a.ok) {
          aggsErrors.push({ ticker: r.symbol, status: a.status, url: a.url, errorDetail: a.errorDetail });
          return {
            symbol: r.symbol,
            __aggsOk: false,
            sma26_5m: null,
            ema9_5m: null,
            ema34_5m: null,
            vwap_5m: null,
            vwapBar_5m: null,
            lastVol_5m: null,
            avgVol_5m: null,
          };
        }
        const ii = indicatorsFromAggs5m(a.bars);
        return { symbol: r.symbol, __aggsOk: true, ...ii };
      });

      const mapInd = new Map(ind.map((x) => [x.symbol, x]));
      rows = rows.map((r) => ({ ...r, ...(mapInd.get(r.symbol) || {}) }));
      rows = rows.map((r) => ({ ...r, ...attach5mSignals(r) }));
    }

    rows = rows.map((r) => {
      const d = demandScore(r);
      return { ...r, demandScore: d, signalIcon: signalIcon(d), paIcon: r.paIcon || "" };
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
      aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "List failed", detail: String(e?.message || e) });
  }
});

// ===================== START =====================
app.listen(PORT, () => {
  console.log(`✅ Server running: http://localhost:${PORT}`);
  console.log(`🖥 UI: http://localhost:${PORT}/ui`);
  if (CLERK_ENABLED) console.log(`🔐 Login: http://localhost:${PORT}/login`);
});
