// ============================================================================
// 🔥 ALGTP™ — Massive Scanner (REST + WS HALT + WS AM fallback)
// Single-file Node.js (CommonJS)
// ----------------------------------------------------------------------------
// Features:
// - UI: /ui (+ tabs)
// - API: /list, /scan, /snapshot-all, /premarket, /aftermarket, /halts, /api
// - Snapshot-All ON: Pre/After uses Snapshot-All (accurate cap/float)
// - Snapshot-All OFF: Pre/After uses AM WS fallback + REST snapshot enrich cache
// - 5m Indicators (optional): SMA/EMA/VWAP + VWAP/VolSpike signal
// - HALT WS (optional): LULD.*
// ============================================================================

import 'dotenv/config';
import express from 'express';
import axios from 'axios';

// ws optional
let WebSocketLib = null;
try {
  const { default: WebSocket } = await import('ws');
  WebSocketLib = WebSocket;
} catch {
  WebSocketLib = null;
}

const app = express();
app.use(express.json());

// ============================================================================
// SECTION 01 — ENV + Config
// ============================================================================
const BRAND = {
  mark: "🔥",
  legal: "ALGTP™ – Algorithmic Trading Platform",
};

const PORT = Number(process.env.PORT || 3000);
const DEBUG = String(process.env.DEBUG || "true").toLowerCase() === "true";

const MASSIVE_API_KEY = String(process.env.MASSIVE_API_KEY || "").trim();
const MASSIVE_AUTH_TYPE = String(process.env.MASSIVE_AUTH_TYPE || "query").trim(); // query | xapi | bearer
const MASSIVE_QUERY_KEYNAME = String(process.env.MASSIVE_QUERY_KEYNAME || "apiKey").trim();

const MASSIVE_MOVER_URL = String(
  process.env.MASSIVE_MOVER_URL || "https://api.massive.com/v2/snapshot/locale/us/markets/stocks"
).trim();

const MASSIVE_TICKER_SNAPSHOT_URL = String(
  process.env.MASSIVE_TICKER_SNAPSHOT_URL || "https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers"
).trim();

const MASSIVE_SNAPSHOT_ALL_URL = String(
  process.env.MASSIVE_SNAPSHOT_ALL_URL || "https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers"
).trim();

const ENABLE_SNAPSHOT_ALL = String(process.env.ENABLE_SNAPSHOT_ALL || "false").toLowerCase() === "true";

const MASSIVE_AGGS_URL = String(process.env.MASSIVE_AGGS_URL || "https://api.massive.com/v2/aggs/ticker").trim();
const AGGS_INCLUDE_PREPOST = String(process.env.AGGS_INCLUDE_PREPOST || "true").toLowerCase() === "true";

const ENABLE_5M_INDICATORS = String(process.env.ENABLE_5M_INDICATORS || "true").toLowerCase() === "true";
const AGGS_5M_LIMIT = Math.max(40, Math.min(5000, Number(process.env.AGGS_5M_LIMIT || 120)));

const VOL_SPIKE_MULT = Math.max(1.1, Math.min(10, Number(process.env.VOL_SPIKE_MULT || 1.5)));
const VOL_AVG_LEN_5M = Math.max(5, Math.min(200, Number(process.env.VOL_AVG_LEN_5M || 20)));

const MASSIVE_DIVIDENDS_URL = String(process.env.MASSIVE_DIVIDENDS_URL || "https://api.massive.com/v3/reference/dividends").trim();

const INCLUDE_OTC = String(process.env.INCLUDE_OTC || "false").toLowerCase() === "true";
const SNAP_CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.SNAP_CONCURRENCY || 4)));

const MASSIVE_WS_URL = String(process.env.MASSIVE_WS_URL || "wss://socket.massive.com/stocks").trim();

// HALT WS
const ENABLE_HALT_WS = String(process.env.ENABLE_HALT_WS || "true").toLowerCase() === "true";

// AM WS fallback
const ENABLE_AM_WS = String(process.env.ENABLE_AM_WS || "true").toLowerCase() === "true";
const AM_WS_SUBS = String(process.env.AM_WS_SUBS || "AM.*").trim();
const AM_CACHE_MAX = Math.max(200, Math.min(20000, Number(process.env.AM_CACHE_MAX || 8000)));

// AM enrich snapshot cache
const AM_ENRICH_LIMIT = Math.max(50, Math.min(500, Number(process.env.AM_ENRICH_LIMIT || 200)));
const AM_ENRICH_TTL_MS = Math.max(5000, Math.min(300000, Number(process.env.AM_ENRICH_TTL_MS || 60000)));

if (!MASSIVE_API_KEY || !MASSIVE_MOVER_URL || !MASSIVE_TICKER_SNAPSHOT_URL) {
  console.error("❌ Missing ENV. Required:");
  console.error(" - MASSIVE_API_KEY");
  console.error(" - MASSIVE_MOVER_URL");
  console.error(" - MASSIVE_TICKER_SNAPSHOT_URL");
  process.exit(1);
}

// ============================================================================
// SECTION 02 — Helpers
// ============================================================================
function envMissingFor({ needSnapshotAll = false, needAggs = false } = {}) {
  const miss = [];
  if (!MASSIVE_API_KEY) miss.push("MASSIVE_API_KEY");
  if (!MASSIVE_MOVER_URL) miss.push("MASSIVE_MOVER_URL");
  if (!MASSIVE_TICKER_SNAPSHOT_URL) miss.push("MASSIVE_TICKER_SNAPSHOT_URL");
  if (needSnapshotAll && !MASSIVE_SNAPSHOT_ALL_URL) miss.push("MASSIVE_SNAPSHOT_ALL_URL");
  if (needAggs && !MASSIVE_AGGS_URL) miss.push("MASSIVE_AGGS_URL");
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
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

function ymd(d) {
  const x = new Date(d);
  const yyyy = x.getFullYear();
  const mm = String(x.getMonth() + 1).padStart(2, "0");
  const dd = String(x.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// time/session
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
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
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

// ============================================================================
// SECTION 03 — Scoring + Icons
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
// SECTION 04 — Axios Safe
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
    const r = await axios.get(url, { params, headers, timeout: 25000, validateStatus: () => true });
    return { ok: r.status < 400, status: r.status, data: r.data, url };
  } catch (e) {
    return { ok: false, status: null, data: null, url, errorDetail: axiosFail(e) };
  }
}

// ============================================================================
// SECTION 05 — Massive REST calls
// ============================================================================
async function fetchMovers(direction = "gainers") {
  const d = String(direction || "gainers").toLowerCase().trim();
  const directionSafe = d === "losers" ? "losers" : "gainers";
  const base = MASSIVE_MOVER_URL.replace(/\/+$/, "");
  const url = `${base}/${directionSafe}`;

  const params = {};
  if (INCLUDE_OTC) params.include_otc = "true";
  const a = auth(params, {});
  const r = await safeGet(url, { params: a.params, headers: a.headers });

  const rows = Array.isArray(r.data?.tickers)
    ? r.data.tickers
    : Array.isArray(r.data?.results)
    ? r.data.results
    : Array.isArray(r.data?.data)
    ? r.data.data
    : [];

  return { ok: r.ok && Array.isArray(rows), url, status: r.status, rows, errorDetail: r.errorDetail };
}

async function fetchTickerSnapshot(ticker) {
  const base = MASSIVE_TICKER_SNAPSHOT_URL.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(String(ticker || "").trim().toUpperCase())}`;
  const a = auth({}, {});
  const r = await safeGet(url, { params: a.params, headers: a.headers });
  return { ok: r.ok, url, status: r.status, data: r.data, errorDetail: r.errorDetail };
}

async function fetchSnapshotAll() {
  const url = MASSIVE_SNAPSHOT_ALL_URL.replace(/\/+$/, "");
  const a = auth({}, {});
  const r = await safeGet(url, { params: a.params, headers: a.headers });

  const rows = Array.isArray(r.data?.tickers)
    ? r.data.tickers
    : Array.isArray(r.data?.results)
    ? r.data.results
    : Array.isArray(r.data?.data)
    ? r.data.data
    : [];

  return { ok: r.ok && Array.isArray(rows), url, status: r.status, rows, errorDetail: r.errorDetail };
}

// Aggs 5m
async function fetchAggs5m(ticker) {
  const sym = String(ticker || "").trim().toUpperCase();
  const base = MASSIVE_AGGS_URL.replace(/\/+$/, "");
  const to = ymd(new Date());
  const from = ymd(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000));
  const url = `${base}/${encodeURIComponent(sym)}/range/5/minute/${from}/${to}`;

  const params = { adjusted: "true", sort: "desc", limit: String(AGGS_5M_LIMIT) };
  if (AGGS_INCLUDE_PREPOST) params.includePrePost = "true";
  const a = auth(params, {});
  const r = await safeGet(url, { params: a.params, headers: a.headers });

  const bars = Array.isArray(r.data?.results) ? r.data.results : [];
  return { ok: r.ok && bars.length > 0, url, status: r.status, bars, errorDetail: r.errorDetail };
}

// ============================================================================
// SECTION 06 — Normalize Snapshot (auto)
// ============================================================================
function findFirstNumberByKeys(obj, candidateKeys, maxNodes = 6000) {
  if (!obj || typeof obj !== "object") return { value: null };
  const wanted = new Set(candidateKeys.map((k) => String(k).toLowerCase()));
  const q = [{ v: obj }];
  let visited = 0;

  while (q.length && visited < maxNodes) {
    const { v } = q.shift();
    visited++;
    if (!v || typeof v !== "object") continue;

    if (Array.isArray(v)) {
      for (const item of v) if (item && typeof item === "object") q.push({ v: item });
      continue;
    }

    for (const k of Object.keys(v)) {
      const keyLower = String(k).toLowerCase();
      const val = v[k];
      if (wanted.has(keyLower)) {
        const num = n(val);
        if (num !== null) return { value: num };
      }
      if (val && typeof val === "object") q.push({ v: val });
    }
  }
  return { value: null };
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
  const prevClose0 = n(prev?.c ?? prev?.close ?? root?.prevClose ?? root?.previousClose) ?? null;

  let price = lastTradePrice ?? dayClose ?? null;
  let open = n(day?.o ?? day?.open ?? root?.open) ?? null;
  let volume = n(day?.v ?? day?.volume ?? root?.volume ?? root?.dayVolume) ?? null;

  let pricePct =
    n(root?.todaysChangePerc) ??
    n(root?.todaysChangePercent) ??
    n(root?.changePerc) ??
    n(root?.changePercent) ??
    null;

  if (price === null) price = findFirstNumberByKeys(root, ["price", "last", "p", "c", "close"]).value;
  if (open === null) open = findFirstNumberByKeys(root, ["open", "o"]).value;

  let prevClose = prevClose0;
  if (prevClose === null) prevClose = findFirstNumberByKeys(root, ["prevclose", "previousclose", "pc", "prevc"]).value;
  if (volume === null) volume = findFirstNumberByKeys(root, ["volume", "v", "dayvolume"]).value;

  if (pricePct === null && price !== null && prevClose !== null && prevClose > 0) {
    pricePct = ((price - prevClose) / prevClose) * 100;
  }
  const gapPct = open !== null && prevClose !== null && prevClose > 0 ? ((open - prevClose) / prevClose) * 100 : null;

  let floatShares =
    n(root?.float) ??
    n(root?.freeFloat) ??
    n(root?.sharesFloat) ??
    n(root?.floatShares) ??
    null;

  if (floatShares === null) {
    floatShares = findFirstNumberByKeys(root, ["float", "freefloat", "sharesfloat", "floatshares"]).value;
  }

  let marketCap =
    n(root?.marketCap) ??
    n(root?.marketcap) ??
    n(root?.mktcap) ??
    n(root?.market_cap) ??
    n(root?.marketCapitalization) ??
    null;

  if (marketCap === null) {
    marketCap = findFirstNumberByKeys(root, ["marketcap", "mktcap", "market_cap", "capitalization"]).value;
  }

  const marketCapEst = marketCap === null && price !== null && floatShares !== null ? price * floatShares : null;
  const marketCapFinal = marketCap ?? marketCapEst;

  return {
    symbol: String(ticker || "").trim().toUpperCase(),

    price: price !== null ? round2(price) : null,
    open: open !== null ? round2(open) : null,
    prevClose: prevClose !== null ? round2(prevClose) : null,

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

function addExtPctFromPrevClose(row) {
  const price = n(row?.price);
  const prevClose = n(row?.prevClose);
  const extPct = price !== null && prevClose !== null && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null;
  return { ...row, extPct: extPct !== null ? round2(extPct) : null };
}

function capPass(row, cap) {
  const c = String(cap || "all").toLowerCase();
  if (c === "all") return true;
  if (!row.cap) return false;
  return row.cap === c;
}

// ============================================================================
// SECTION 07 — 5m Indicators (optional)
// ============================================================================
function computeSMA(closes, len) {
  if (!Array.isArray(closes) || closes.length < len) return null;
  let sum = 0;
  for (let i = closes.length - len; i < closes.length; i++) sum += closes[i];
  return sum / len;
}
function computeEMA(closes, len) {
  if (!Array.isArray(closes) || closes.length < len) return null;
  const k = 2 / (len + 1);
  let ema = computeSMA(closes.slice(0, len), len);
  if (ema === null) return null;
  for (let i = len; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}
function computeVWAP(closes, volumes) {
  if (!Array.isArray(closes) || !Array.isArray(volumes) || closes.length === 0 || closes.length !== volumes.length) return null;
  let pv = 0, vv = 0;
  for (let i = 0; i < closes.length; i++) {
    const c = n(closes[i]);
    const v = n(volumes[i]);
    if (c === null || v === null || v <= 0) continue;
    pv += c * v; vv += v;
  }
  if (vv <= 0) return null;
  return pv / vv;
}
function computeAvg(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  let s = 0, c = 0;
  for (const x of arr) {
    const v = n(x);
    if (v === null) continue;
    s += v; c++;
  }
  if (c === 0) return null;
  return s / c;
}

function indicatorsFromAggs5m(barsDesc) {
  if (!Array.isArray(barsDesc) || barsDesc.length === 0) {
    return { sma26_5m: null, ema9_5m: null, ema34_5m: null, vwap_5m: null, lastVol_5m: null, avgVol_5m: null };
  }

  const bars = barsDesc
    .map((b) => ({ c: n(b?.c ?? b?.close), v: n(b?.v ?? b?.volume) }))
    .filter((x) => x.c !== null)
    .slice(0, 600);

  const barsChrono = [...bars].reverse();
  const closes = barsChrono.map((x) => x.c);
  const vols = barsChrono.map((x) => x.v ?? 0);

  const sma26 = closes.length >= 26 ? computeSMA(closes, 26) : null;
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

function attach5mSignals(row) {
  const price = n(row?.price);
  const vwap = n(row?.vwap_5m);
  const lastVol = n(row?.lastVol_5m);
  const avgVol = n(row?.avgVol_5m);

  const aboveVWAP = price !== null && vwap !== null ? price > vwap : false;
  const volSpike = lastVol !== null && avgVol !== null && avgVol > 0 ? lastVol >= avgVol * VOL_SPIKE_MULT : false;

  return { ...row, aboveVWAP_5m: aboveVWAP, volSpike_5m: volSpike, paIcon: paSignalIcon({ aboveVWAP_5m: aboveVWAP, volSpike_5m: volSpike }) };
}

async function attachIndicatorsIfEnabled(rows) {
  if (!ENABLE_5M_INDICATORS) return { rows, aggsErrors: [] };

  const aggsErrors = [];
  const ind = await mapPool(rows, SNAP_CONCURRENCY, async (r) => {
    const a = await fetchAggs5m(r.symbol);
    if (!a.ok) {
      aggsErrors.push({ ticker: r.symbol, status: a.status, url: a.url, errorDetail: a.errorDetail });
      return { symbol: r.symbol, sma26_5m: null, ema9_5m: null, ema34_5m: null, vwap_5m: null, lastVol_5m: null, avgVol_5m: null };
    }
    return { symbol: r.symbol, ...indicatorsFromAggs5m(a.bars) };
  });

  const mapInd = new Map(ind.map((x) => [x.symbol, x]));
  let out = rows.map((r) => ({ ...r, ...(mapInd.get(r.symbol) || {}) }));
  out = out.map(attach5mSignals);
  return { rows: out, aggsErrors };
}

// ============================================================================
// SECTION 08 — HALT WS (LULD) + /halts
// ============================================================================
const haltedMap = new Map();
function setHalt(sym) { haltedMap.set(sym, { halted: true, lastEvent: "HALT", tsMs: Date.now(), reason: "LULD" }); }
function setResume(sym) { haltedMap.set(sym, { halted: false, lastEvent: "RESUME", tsMs: Date.now(), reason: "LULD" }); }

function handleLULD(payload) {
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

let haltWs = null;
function startHaltWebSocket() {
  if (!ENABLE_HALT_WS) return;
  if (!WebSocketLib) return console.log("⚠️ HALT WS disabled: npm i ws");
  if (!MASSIVE_API_KEY) return console.log("⚠️ HALT WS disabled: missing MASSIVE_API_KEY");

  try { if (haltWs && haltWs.readyState === 1) return; } catch {}

  const ws = new WebSocketLib(MASSIVE_WS_URL);
  haltWs = ws;
  let subscribed = false;

  ws.on("open", () => {
    ws.send(JSON.stringify({ action: "auth", params: MASSIVE_API_KEY }));
    console.log("✅ HALT WS connected (waiting auth_success...)");
  });

  ws.on("message", (buf) => {
    try {
      const parsed = JSON.parse(buf.toString("utf8"));
      const msgs = Array.isArray(parsed) ? parsed : [parsed];

      const st = msgs.find((x) => x && String(x.ev || "").toLowerCase() === "status");
      if (st && String(st.status || "").toLowerCase() === "auth_success" && !subscribed) {
        subscribed = true;
        ws.send(JSON.stringify({ action: "subscribe", params: "LULD.*" }));
        console.log("✅ HALT WS auth_success → subscribed LULD.*");
      }

      handleLULD(parsed);
    } catch {}
  });

  ws.on("close", () => {
    console.log("⚠️ HALT WS closed. Reconnect in 3s...");
    haltWs = null;
    setTimeout(startHaltWebSocket, 3000);
  });

  ws.on("error", (err) => console.log("⚠️ HALT WS error:", String(err?.message || err)));
}

function attachHaltFlag(row) {
  const sym = String(row?.symbol || "").trim().toUpperCase();
  if (!sym) return row;
  const x = haltedMap.get(sym);
  const halted = Boolean(x?.halted);
  return { ...row, halted, haltIcon: halted ? "⛔" : "", haltReason: x?.reason || null, lastEvent: x?.lastEvent || null, haltTsMs: x?.tsMs || null };
}

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

// ============================================================================
// SECTION 09 — AM WS cache + snapshot enrich
// ============================================================================
const amMap = new Map(); // sym -> AM payload
let amWs = null;

function trimAMCache() {
  if (amMap.size <= AM_CACHE_MAX) return;
  const arr = Array.from(amMap.entries());
  arr.sort((a, b) => (a[1]?._recvTs ?? 0) - (b[1]?._recvTs ?? 0));
  const drop = arr.length - AM_CACHE_MAX;
  for (let i = 0; i < drop; i++) amMap.delete(arr[i][0]);
}

function handleAMPayload(payload) {
  const msgs = Array.isArray(payload) ? payload : [payload];
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const ev = String(m.ev || m.event || "").toUpperCase();
    if (ev !== "AM") continue;

    const sym = String(m.sym || m.S || m.ticker || "").trim().toUpperCase();
    if (!sym) continue;

    amMap.set(sym, { ...m, _recvTs: Date.now() });
    trimAMCache();
  }
}

function startAMWebSocket() {
  if (!ENABLE_AM_WS) return;
  if (!WebSocketLib) return console.log("⚠️ AM WS disabled: npm i ws");
  if (!MASSIVE_API_KEY) return console.log("⚠️ AM WS disabled: missing MASSIVE_API_KEY");

  try { if (amWs && amWs.readyState === 1) return; } catch {}

  const ws = new WebSocketLib(MASSIVE_WS_URL);
  amWs = ws;
  let subscribed = false;

  ws.on("open", () => {
    ws.send(JSON.stringify({ action: "auth", params: MASSIVE_API_KEY }));
    console.log("✅ AM WS connected (waiting auth_success...)");
  });

  ws.on("message", (buf) => {
    try {
      const parsed = JSON.parse(buf.toString("utf8"));
      const msgs = Array.isArray(parsed) ? parsed : [parsed];

      const st = msgs.find((x) => x && String(x.ev || "").toLowerCase() === "status");
      if (st && String(st.status || "").toLowerCase() === "auth_success" && !subscribed) {
        subscribed = true;
        ws.send(JSON.stringify({ action: "subscribe", params: AM_WS_SUBS }));
        console.log(`✅ AM WS auth_success → subscribed: ${AM_WS_SUBS}`);
      }

      handleAMPayload(parsed);
    } catch {}
  });

  ws.on("close", () => {
    console.log("⚠️ AM WS closed. Reconnect in 3s...");
    amWs = null;
    setTimeout(startAMWebSocket, 3000);
  });

  ws.on("error", (err) => console.log("⚠️ AM WS error:", String(err?.message || err)));
}

// snapshot enrich cache
const amSnapCache = new Map(); // sym -> {ts,row}
function getSnapCached(sym) {
  const hit = amSnapCache.get(sym);
  if (!hit) return null;
  if (Date.now() - hit.ts > AM_ENRICH_TTL_MS) return null;
  return hit.row;
}
function setSnapCached(sym, row) {
  amSnapCache.set(sym, { ts: Date.now(), row });
}

function normalizeFromAMOnly(sym, am) {
  const price = n(am?.c) ?? null;
  const op = n(am?.op) ?? null;
  const extPct = price !== null && op !== null && op > 0 ? ((price - op) / op) * 100 : null;
  const vol = n(am?.av) ?? n(am?.v) ?? null;
  const ms = toMs(am?.e) || toMs(am?.s);

  return {
    symbol: sym,
    price: price !== null ? round2(price) : null,
    pricePct: null,
    gapPct: null,
    extPct: extPct !== null ? round2(extPct) : null,
    volume: vol !== null ? Math.round(vol) : null,
    floatM: null,
    marketCapB: null,
    cap: null,
    source: "AM_WS",
    am_ts: ms,
  };
}

function mergeAMWithSnapshot(amRow, snapRow) {
  const price = n(amRow?.price) ?? n(snapRow?.price);
  const prevClose = n(snapRow?.prevClose);
  const open = n(snapRow?.open);

  const pricePct = price !== null && prevClose !== null && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : n(snapRow?.pricePct);
  const gapPct = open !== null && prevClose !== null && prevClose > 0 ? ((open - prevClose) / prevClose) * 100 : n(snapRow?.gapPct);
  const extPct = price !== null && prevClose !== null && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : n(amRow?.extPct);

  const volA = n(amRow?.volume);
  const volS = n(snapRow?.volume);
  const volume = volA !== null && volS !== null ? Math.max(volA, volS) : (volA ?? volS ?? null);

  return {
    ...snapRow,
    price: price !== null ? round2(price) : null,
    pricePct: pricePct !== null ? round2(pricePct) : null,
    gapPct: gapPct !== null ? round2(gapPct) : null,
    extPct: extPct !== null ? round2(extPct) : null,
    volume: volume !== null ? Math.round(volume) : null,
    source: "AM+SNAP",
    am_ts: amRow?.am_ts ?? null,
  };
}

// ============================================================================
// SECTION 10 — Builders
// ============================================================================
function groupToDirection(group) {
  if (group === "topLosers") return "losers";
  return "gainers";
}
function sortRowsByGroup(rows, group) {
  if (group === "topGappers") rows.sort((a, b) => Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0));
  else rows.sort((a, b) => Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0));
}

function finalizeRows(rows) {
  let out = rows.map((r) => {
    const d = demandScore(r);
    return { ...r, demandScore: d, signalIcon: signalIcon(d), paIcon: r.paIcon || "" };
  });
  out = out.map(attachHaltFlag);
  return out;
}

async function buildRowsFromSnapshotAll({ cap, limit, session }) {
  if (!ENABLE_SNAPSHOT_ALL) {
    return { ok: false, status: 403, body: { ok: false, error: "Snapshot-All is OFF", hint: "Set ENABLE_SNAPSHOT_ALL=true or use AM WS fallback." } };
  }

  const miss = envMissingFor({ needSnapshotAll: true, needAggs: ENABLE_5M_INDICATORS });
  if (miss.length) return { ok: false, status: 400, body: { ok: false, error: "Missing env", miss } };

  const snap = await fetchSnapshotAll();
  if (!snap.ok) return { ok: false, status: 500, body: { ok: false, error: "Snapshot-all failed", debug: snap } };

  const snapMap = new Map();
  for (const x of snap.rows) {
    const t = String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase();
    if (t) snapMap.set(t, x);
  }

  let rows = [];
  for (const [ticker, raw] of snapMap.entries()) {
    let r = normalizeSnapshotAuto(ticker, raw);
    r = addExtPctFromPrevClose(r);
    rows.push(r);
  }

  if (session) {
    rows = rows.filter((r) => {
      const raw = snapMap.get(r.symbol);
      const ms = toMs(raw?.lastTrade?.t ?? raw?.lastQuote?.t ?? raw?.updated ?? raw?.timestamp);
      if (!ms) return false;
      return sessionOfMs(ms) === session;
    });
  }

  rows = rows.filter((r) => capPass(r, cap));

  const { rows: withInd, aggsErrors } = await attachIndicatorsIfEnabled(rows);
  rows = finalizeRows(withInd);

  rows.sort(
    (a, b) =>
      Math.abs(b.extPct ?? 0) - Math.abs(a.extPct ?? 0) ||
      Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0) ||
      (b.volume ?? 0) - (a.volume ?? 0)
  );

  const lim = clamp(Number(limit || 100), 5, 500);
  rows = rows.slice(0, lim);

  return { ok: true, status: 200, body: { ok: true, source: "SNAPSHOT_ALL", session: session || null, cap, results: rows, aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined } };
}

async function buildRowsFromAMCache({ cap, limit, session }) {
  // 1) base AM rows
  let base = [];
  for (const [sym, am] of amMap.entries()) {
    const ms = toMs(am?.e) || toMs(am?.s);
    if (!ms) continue;
    if (session && sessionOfMs(ms) !== session) continue;
    base.push(normalizeFromAMOnly(sym, am));
  }

  if (!base.length) {
    return { ok: true, status: 200, body: { ok: true, source: "AM_WS", session, cap, results: [] } };
  }

  // 2) pick candidates for enrichment
  const needCap = String(cap || "all").toLowerCase() !== "all";
  const candidates = [...base].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0) || Math.abs(b.extPct ?? 0) - Math.abs(a.extPct ?? 0));
  const pick = candidates.slice(0, AM_ENRICH_LIMIT).map((x) => x.symbol);

  // 3) fetch missing snapshots into cache
  const toFetch = pick.filter((sym) => !getSnapCached(sym));
  if (toFetch.length) {
    const snaps = await mapPool(toFetch, SNAP_CONCURRENCY, async (t) => {
      const r = await fetchTickerSnapshot(t);
      return { ticker: t, ...r };
    });
    for (const s of snaps) {
      if (s.ok) setSnapCached(s.ticker, normalizeSnapshotAuto(s.ticker, s.data));
    }
  }

  // 4) merge
  let rows = base.map((r) => {
    const snapRow = getSnapCached(r.symbol);
    return snapRow ? mergeAMWithSnapshot(r, snapRow) : r;
  });

  // 5) cap filter: if cap requested, drop AM-only rows (cap null)
  if (needCap) rows = rows.filter((r) => capPass(r, cap));

  // 6) attach indicators only to top N to keep fast
  const lim = clamp(Number(limit || 100), 5, 500);
  rows.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  rows = rows.slice(0, Math.max(lim * 2, 120));

  const { rows: withInd, aggsErrors } = await attachIndicatorsIfEnabled(rows);
  rows = finalizeRows(withInd);

  rows.sort(
    (a, b) =>
      (b.demandScore ?? 0) - (a.demandScore ?? 0) ||
      Math.abs(b.extPct ?? 0) - Math.abs(a.extPct ?? 0) ||
      (b.volume ?? 0) - (a.volume ?? 0)
  );

  rows = rows.slice(0, lim);

  return { ok: true, status: 200, body: { ok: true, source: "AM_FALLBACK", session, cap, results: rows, aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined } };
}

// ============================================================================
// SECTION 11 — API Routes
// ============================================================================
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: `${BRAND.legal} running ✅`,
    ui: "/ui",
    endpoints: ["/list", "/scan", "/snapshot-all", "/premarket", "/aftermarket", "/halts", "/api", "/dividends"],
  });
});

app.get("/api", (req, res) => {
  res.json({
    ok: true,
    config: {
      port: PORT,
      snapshotAllEnabled: ENABLE_SNAPSHOT_ALL,
      indicators5m: ENABLE_5M_INDICATORS,
      haltWs: ENABLE_HALT_WS,
      amWs: ENABLE_AM_WS,
      amSubs: AM_WS_SUBS,
      amCache: amMap.size,
      snapCache: amSnapCache.size,
    },
    envMissingCore: envMissingFor({ needSnapshotAll: false, needAggs: false }),
    envMissingIfSnapshotAll: envMissingFor({ needSnapshotAll: true, needAggs: false }),
    envMissingIfAggs: envMissingFor({ needSnapshotAll: false, needAggs: true }),
  });
});

app.get("/scan", async (req, res) => {
  try {
    const miss = envMissingFor({ needSnapshotAll: false, needAggs: ENABLE_5M_INDICATORS });
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const symbols = parseSymbols(req.query.symbols || "NVDA,TSLA,AAPL").slice(0, 100);
    const snaps = await mapPool(symbols, SNAP_CONCURRENCY, async (t) => {
      const r = await fetchTickerSnapshot(t);
      return { ticker: t, ...r };
    });

    const good = snaps.filter((x) => x.ok);
    const bad = snaps.filter((x) => !x.ok);

    let rows = good.map((x) => normalizeSnapshotAuto(x.ticker, x.data)).map(addExtPctFromPrevClose);

    const { rows: withInd, aggsErrors } = await attachIndicatorsIfEnabled(rows);
    rows = finalizeRows(withInd);

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
      snapshotErrors: DEBUG ? bad.slice(0, 10).map((x) => ({ ticker: x.ticker, status: x.status, url: x.url, errorDetail: x.errorDetail })) : undefined,
      aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Scan failed", detail: String(e?.message || e) });
  }
});

app.get("/list", async (req, res) => {
  try {
    const miss = envMissingFor({ needSnapshotAll: false, needAggs: ENABLE_5M_INDICATORS });
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const group = String(req.query.group || "topGainers").trim();
    const cap = String(req.query.cap || "all").trim().toLowerCase();
    const limit = clamp(Number(req.query.limit || 50), 5, 200);
    const minGap = n(req.query.minGap);

    const direction = groupToDirection(group);
    const movers = await fetchMovers(direction);
    if (!movers.ok) return res.status(500).json({ ok: false, error: "Movers failed", moverDebug: movers });

    // widen for cap filtering
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

    let rows = good.map((x) => normalizeSnapshotAuto(x.ticker, x.data)).map(addExtPctFromPrevClose);
    rows = rows.filter((r) => capPass(r, cap));

    if (minGap !== null && Number.isFinite(minGap)) rows = rows.filter((r) => (r.gapPct ?? 0) >= minGap);

    rows = rows.slice(0, limit);

    const { rows: withInd, aggsErrors } = await attachIndicatorsIfEnabled(rows);
    rows = finalizeRows(withInd);

    sortRowsByGroup(rows, group);

    res.json({
      ok: true,
      mode: "group",
      group,
      cap,
      limitRequested: limit,
      results: rows,
      snapshotErrors: DEBUG ? bad.slice(0, 10).map((x) => ({ ticker: x.ticker, status: x.status, url: x.url, errorDetail: x.errorDetail })) : undefined,
      aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "List failed", detail: String(e?.message || e) });
  }
});

app.get("/snapshot-all", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = req.query.limit;
  const out = await buildRowsFromSnapshotAll({ cap, limit, session: null });
  return res.status(out.status).json(out.body);
});

app.get("/premarket", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = req.query.limit;

  if (ENABLE_SNAPSHOT_ALL) {
    const out = await buildRowsFromSnapshotAll({ cap, limit, session: "pre" });
    return res.status(out.status).json(out.body);
  }

  const out = await buildRowsFromAMCache({ cap, limit, session: "pre" });
  return res.status(out.status).json(out.body);
});

app.get("/aftermarket", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = req.query.limit;

  if (ENABLE_SNAPSHOT_ALL) {
    const out = await buildRowsFromSnapshotAll({ cap, limit, session: "after" });
    return res.status(out.status).json(out.body);
  }

  const out = await buildRowsFromAMCache({ cap, limit, session: "after" });
  return res.status(out.status).json(out.body);
});

// Dividends (optional)
app.get("/dividends", async (req, res) => {
  try {
    const ticker = String(req.query.ticker || "").trim().toUpperCase();
    const limit = clamp(Number(req.query.limit || 50), 1, 1000);
    const order = String(req.query.order || "desc").toLowerCase() === "asc" ? "asc" : "desc";
    const sort = String(req.query.sort || "ex_dividend_date").trim();

    const url = MASSIVE_DIVIDENDS_URL.replace(/\/+$/, "");
    const params = { limit: String(limit), order, sort };
    if (ticker) params.ticker = ticker;

    const a = auth(params, {});
    const r = await safeGet(url, { params: a.params, headers: a.headers });

    const rows =
      Array.isArray(r.data?.results) ? r.data.results :
      Array.isArray(r.data?.dividends) ? r.data.dividends :
      Array.isArray(r.data?.data) ? r.data.data : [];

    return res.json({ ok: r.ok, status: r.status, ticker: ticker || null, count: rows.length, results: rows, errorDetail: r.ok ? undefined : r.errorDetail });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Dividends failed", detail: String(e?.message || e) });
  }
});

// ============================================================================
// SECTION 12 — UI (simple)
// ============================================================================
function renderUI(preset = {}) {
  const presetGroup = preset.group || "topGainers";
  const presetCap = preset.cap || "all";
  const presetLimit = preset.limit || 80;
  const presetMinGap = preset.minGap ?? "";

  const active = (path) => (preset.path === path ? "opacity:1" : "opacity:.65");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ALGTP™ Scanner</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0b0d12;color:#e6e8ef;font-family:system-ui}
header{padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08);position:sticky;top:0;background:rgba(11,13,18,.92);backdrop-filter: blur(10px)}
.wrap{max-width:1400px;margin:0 auto}
.nav{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}
.nav a{text-decoration:none;color:#c8cde0;background:#121622;border:1px solid rgba(255,255,255,.12);padding:8px 10px;border-radius:999px;font-size:12px}
.panel{padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.06)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
select,input,button{background:#121622;border:1px solid rgba(255,255,255,.12);color:#e6e8ef;border-radius:12px;padding:9px 10px;font-size:13px}
button{cursor:pointer} button:hover{border-color:rgba(255,255,255,.22)}
.badge{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;background:#121622;border:1px solid rgba(255,255,255,.12);font-size:12px;color:#c8cde0}
.card{border:1px solid rgba(255,255,255,.10);border-radius:14px;overflow:hidden;margin:14px 16px}
.cardHead{padding:10px 12px;display:flex;justify-content:space-between;background:#121622;border-bottom:1px solid rgba(255,255,255,.08)}
table{width:100%;border-collapse:collapse}
th,td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);font-size:13px}
th{color:#a7adc2;text-align:left}
tr:hover td{background:rgba(255,255,255,.03)}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace}
.right{text-align:right}
.symLink{color:#e6e8ef;text-decoration:none;border-bottom:1px dashed rgba(255,255,255,.25)}
.symLink:hover{border-bottom-color:rgba(255,255,255,.55)}
.note{margin-top:8px;color:#a7adc2;font-size:12px}
.banner{margin-top:10px;padding:10px 12px;border:1px solid rgba(255,180,180,.25);background:#1a0f12;border-radius:12px;color:#ffb4b4;font-size:12px;display:none}
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
      <div>
        <div style="font-weight:900">${BRAND.mark} ${BRAND.legal}</div>
        <div style="font-size:12px;color:#a7adc2;margin-top:4px;">Pre/After: Snapshot-All (if ON) or AM WS fallback (if OFF)</div>
      </div>
      <div class="badge" id="status">Idle</div>
    </div>

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

      <input id="symbols" placeholder="Symbols: NVDA,TSLA,AAPL" style="min-width:260px;flex:1"/>

      <select id="group">
        <option value="topGainers">Top Gainers</option>
        <option value="topLosers">Top Losers</option>
        <option value="topGappers">Top Gappers</option>
        <option value="premarket">Pre-Market</option>
        <option value="aftermarket">After-Hours</option>
        <option value="snapshotAll">Snapshot-All</option>
      </select>

      <select id="cap">
        <option value="all">Cap: All</option>
        <option value="small">Cap: Small</option>
        <option value="mid">Cap: Mid</option>
        <option value="big">Cap: Big</option>
      </select>

      <select id="limit">
        <option>20</option><option>50</option><option selected>80</option><option>100</option><option>150</option>
      </select>

      <input id="minGap" placeholder="minGap% (gappers)" style="min-width:160px"/>
      <span class="badge"><input id="autoOn" type="checkbox"/> Auto</span>
      <input id="autoSec" placeholder="sec (30)" style="min-width:110px"/>
      <button id="runBtn">Run</button>
    </div>

    <div class="banner" id="bannerSnap">⚠️ Snapshot-All OFF → Pre/After uses AM WS fallback + snapshot enrich.</div>

    <div class="note">
      Click ticker opens TradingView. Columns show Score + VWAP/VolSpike (if indicators enabled).
    </div>
  </div>
</div>

<div class="wrap" id="out"></div>

<script>
const SNAPSHOT_ALL_ENABLED = ${JSON.stringify(ENABLE_SNAPSHOT_ALL)};
const byId = (id)=>document.getElementById(id);
const out = byId("out");
const statusEl = byId("status");

function setStatus(t){ statusEl.textContent = t; }
function fmtNum(x,d=2){ if(x==null) return "-"; const n=Number(x); if(!Number.isFinite(n)) return "-"; return n.toFixed(d); }
function fmtInt(x){ if(x==null) return "-"; const n=Number(x); if(!Number.isFinite(n)) return "-"; return Math.round(n).toLocaleString(); }

function openTV(sym){
  const url = "https://www.tradingview.com/chart/?symbol="+encodeURIComponent("NASDAQ:"+sym)+"&interval=5";
  window.open(url, "_blank", "noopener,noreferrer");
}

function renderTable(data){
  const rows = Array.isArray(data.results) ? data.results : [];
  const source = data.source || data.mode || "-";
  out.innerHTML = \`
    <div class="card">
      <div class="cardHead">
        <div style="font-weight:800">Results</div>
        <div style="color:#a7adc2;font-size:12px">source=\${source} • rows=\${rows.length}</div>
      </div>
      <div style="overflow:auto">
      <table>
        <thead><tr>
          <th>Sig</th>
          <th>PA</th>
          <th>Symbol</th>
          <th class="right">Price</th>
          <th class="right">Price%</th>
          <th class="right">Ext%</th>
          <th class="right">Gap%</th>
          <th class="right">Vol</th>
          <th class="right">Float(M)</th>
          <th>Cap</th>
          <th class="right">Score</th>
          <th class="right">VWAP</th>
          <th class="right">RVOL</th>
        </tr></thead>
        <tbody>
          \${rows.map(r=>{
            const sym = String(r.symbol||"");
            const safe = sym.replace(/'/g,"");
            const tv = \`<a class="symLink" href="javascript:void(0)" onclick="openTV('\${safe}')">\${sym}</a>\`;
            const halted = r.halted ? "⛔" : "";
            const pa = r.paIcon || "";
            const rvol = (r.lastVol_5m!=null && r.avgVol_5m!=null && r.avgVol_5m>0) ? (r.lastVol_5m/r.avgVol_5m).toFixed(2) : "-";
            return \`
              <tr>
                <td>\${halted}\${r.signalIcon||""}</td>
                <td>\${pa}</td>
                <td class="mono">\${tv}</td>
                <td class="right mono">\${fmtNum(r.price)}</td>
                <td class="right mono">\${fmtNum(r.pricePct)}%</td>
                <td class="right mono">\${fmtNum(r.extPct)}%</td>
                <td class="right mono">\${fmtNum(r.gapPct)}%</td>
                <td class="right mono">\${fmtInt(r.volume)}</td>
                <td class="right mono">\${fmtNum(r.floatM)}</td>
                <td>\${r.cap || "-"}</td>
                <td class="right mono">\${r.demandScore ?? "-"}</td>
                <td class="right mono">\${fmtNum(r.vwap_5m)}</td>
                <td class="right mono">\${rvol}</td>
              </tr>\`;
          }).join("")}
        </tbody>
      </table>
      </div>
    </div>\`;
}

async function run(){
  setStatus("Loading...");
  out.innerHTML = "";

  const mode = byId("mode").value;
  const cap = byId("cap").value;
  const limit = byId("limit").value;
  const minGap = byId("minGap").value.trim();
  const group = byId("group").value;

  let url = "";
  if (mode === "symbols"){
    const symbols = (byId("symbols").value || "NVDA,TSLA,AAPL").trim();
    url = "/scan?symbols="+encodeURIComponent(symbols);
  } else {
    if (group === "premarket") url = "/premarket?cap="+encodeURIComponent(cap)+"&limit="+encodeURIComponent(limit);
    else if (group === "aftermarket") url = "/aftermarket?cap="+encodeURIComponent(cap)+"&limit="+encodeURIComponent(limit);
    else if (group === "snapshotAll") url = "/snapshot-all?cap="+encodeURIComponent(cap)+"&limit="+encodeURIComponent(limit);
    else {
      url = "/list?group="+encodeURIComponent(group)+"&cap="+encodeURIComponent(cap)+"&limit="+encodeURIComponent(limit);
      if (minGap) url += "&minGap="+encodeURIComponent(minGap);
    }
  }

  try{
    const r = await fetch(url);
    const data = await r.json();
    if (!data.ok){
      setStatus("Error");
      out.innerHTML = "<pre style='white-space:pre-wrap;color:#ffb4b4'>"+JSON.stringify(data,null,2)+"</pre>";
      return;
    }
    setStatus("OK ("+(data.results?.length||0)+" rows)");
    renderTable(data);
  }catch(e){
    setStatus("Error");
    out.innerHTML = "<pre style='white-space:pre-wrap;color:#ffb4b4'>"+String(e?.message||e)+"</pre>";
  }
}

let timer = null;
function applyAuto(){
  const on = byId("autoOn").checked;
  const sec = Number(byId("autoSec").value || "30");
  const s = Math.max(5, Math.min(3600, Number.isFinite(sec)?sec:30));
  if (timer) clearInterval(timer);
  timer = null;
  if (on) timer = setInterval(run, s*1000);
}

byId("runBtn").addEventListener("click", run);
byId("autoOn").addEventListener("change", applyAuto);
byId("autoSec").addEventListener("change", applyAuto);

if (!SNAPSHOT_ALL_ENABLED) byId("bannerSnap").style.display = "block";
run();
</script>
</body>
</html>`;
}

// UI routes (presets)
app.get("/ui", (req, res) => res.type("html").send(renderUI({ path: "/ui", group: "topGainers", cap: "all", limit: 80 })));
app.get("/ui/gainers", (req, res) => res.type("html").send(renderUI({ path: "/ui/gainers", group: "topGainers", cap: "all", limit: 80 })));
app.get("/ui/losers", (req, res) => res.type("html").send(renderUI({ path: "/ui/losers", group: "topLosers", cap: "all", limit: 80 })));
app.get("/ui/gappers", (req, res) => res.type("html").send(renderUI({ path: "/ui/gappers", group: "topGappers", cap: "all", limit: 120, minGap: 10 })));
app.get("/ui/smallcap", (req, res) => res.type("html").send(renderUI({ path: "/ui/smallcap", group: "topGainers", cap: "small", limit: 120 })));
app.get("/ui/midcap", (req, res) => res.type("html").send(renderUI({ path: "/ui/midcap", group: "topGainers", cap: "mid", limit: 120 })));
app.get("/ui/bigcap", (req, res) => res.type("html").send(renderUI({ path: "/ui/bigcap", group: "topGainers", cap: "big", limit: 120 })));
app.get("/ui/premarket", (req, res) => res.type("html").send(renderUI({ path: "/ui/premarket", group: "premarket", cap: "small", limit: 120 })));
app.get("/ui/aftermarket", (req, res) => res.type("html").send(renderUI({ path: "/ui/aftermarket", group: "aftermarket", cap: "small", limit: 120 })));
app.get("/ui/snapshot-all", (req, res) => res.type("html").send(renderUI({ path: "/ui/snapshot-all", group: "snapshotAll", cap: "all", limit: 200 })));

// ============================================================================
// SECTION 13 — Listen + start WS
// ============================================================================
startHaltWebSocket();
startAMWebSocket();

app.listen(PORT, '0.0.0.0', () => {
  const base = `http://localhost:${PORT}`;
  console.log(`\n✅ ${BRAND.legal} running`);
  console.log(`🚀 UI: ${base}/ui`);
  console.log(`🌅 Pre: ${base}/ui/premarket`);
  console.log(`🌙 After: ${base}/ui/aftermarket`);
  console.log(`⛔ Halts: ${base}/halts`);
  console.log(`ℹ️ API: ${base}/api`);
  if (!ENABLE_SNAPSHOT_ALL) console.log(`⚠️ Snapshot-All OFF → Pre/After uses AM WS fallback + enrich`);
  console.log("");
});
