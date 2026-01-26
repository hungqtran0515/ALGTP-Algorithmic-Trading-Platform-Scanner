// ============================================================================
// 🔥 ALGTP™ — Massive Scanner (REST + WS HALT + WS AM fallback + Mini Chart Hover)
// Single-file Node.js (ESM)
// ----------------------------------------------------------------------------
// UI:
//  - /ui   (Dashboard box-matrix like screenshot)
// API:
//  - /list, /scan, /snapshot-all, /premarket, /aftermarket, /halts, /api
// Extra:
//  - /mini-chart?symbol=AAPL&tf=1
// ----------------------------------------------------------------------------
// UI Behavior:
//  - Top bar: ONLY Symbols input active (Enter => refresh IMPORTANT_STOCKS)
//  - Rounded pills (“quang tròn”) for status, auto, snapshot-all
//  - Hover ticker => mini chart
//  - Click ticker => TradingView
// ----------------------------------------------------------------------------
// Data Behavior:
//  - ENABLE_SNAPSHOT_ALL=true  => Snapshot-All for pre/after filtering
//  - ENABLE_SNAPSHOT_ALL=false => AM WS fallback + REST snapshot enrich cache
//  - Fix Open/GAP: fallback open from snapshot keys + AM open
// ============================================================================

import "dotenv/config";
import express from "express";
import axios from "axios";
import WebSocket from "ws";

const WebSocketLib = WebSocket;
const app = express();
app.use(express.json());

// ============================================================================
// SECTION 00 — Brand
// ============================================================================
const BRAND = {
  mark: "🔥",
  name: "ALGTP™",
  legal: "ALGTP™ – Algorithmic Trading Platform",
  subtitle: "Smart Market Scanner",
  watermark: "Powered by ALGTP™",
};

// ============================================================================
// SECTION 01 — ENV
// ============================================================================
const PORT = Number(process.env.PORT || 3000);
const DEBUG = String(process.env.DEBUG || "true").toLowerCase() === "true";

const MASSIVE_API_KEY = String(process.env.MASSIVE_API_KEY || "").trim();
const MASSIVE_AUTH_TYPE = String(process.env.MASSIVE_AUTH_TYPE || "query").trim(); // query | xapi | bearer
const MASSIVE_QUERY_KEYNAME = String(process.env.MASSIVE_QUERY_KEYNAME || "apiKey").trim();

const UI_AUTO_REFRESH_MS = Math.max(0, Math.min(600000, Number(process.env.UI_AUTO_REFRESH_MS || 15000))); // 0 = off
const IMPORTANT_SYMBOLS = String(process.env.IMPORTANT_SYMBOLS || "NVDA,TSLA,AAPL,AMD,META").trim();

const SYMBOL_DOT_TO_DASH = String(process.env.SYMBOL_DOT_TO_DASH || "false").toLowerCase() === "true";

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

// Aggs (for 5m indicators + mini chart)
const MASSIVE_AGGS_URL = String(process.env.MASSIVE_AGGS_URL || "https://api.massive.com/v2/aggs/ticker").trim();
const AGGS_INCLUDE_PREPOST = String(process.env.AGGS_INCLUDE_PREPOST || "true").toLowerCase() === "true";

// 5m indicators
const ENABLE_5M_INDICATORS = String(process.env.ENABLE_5M_INDICATORS || "true").toLowerCase() === "true";
const AGGS_5M_LIMIT = Math.max(40, Math.min(5000, Number(process.env.AGGS_5M_LIMIT || 120)));
const VOL_SPIKE_MULT = Math.max(1.1, Math.min(10, Number(process.env.VOL_SPIKE_MULT || 1.5)));
const VOL_AVG_LEN_5M = Math.max(5, Math.min(200, Number(process.env.VOL_AVG_LEN_5M || 20)));

const INCLUDE_OTC = String(process.env.INCLUDE_OTC || "false").toLowerCase() === "true";
const SNAP_CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.SNAP_CONCURRENCY || 4)));

const MASSIVE_WS_URL = String(process.env.MASSIVE_WS_URL || "wss://socket.massive.com/stocks").trim();
const ENABLE_HALT_WS = String(process.env.ENABLE_HALT_WS || "true").toLowerCase() === "true";

// AM WS fallback
const ENABLE_AM_WS = String(process.env.ENABLE_AM_WS || "true").toLowerCase() === "true";
const AM_WS_SUBS = String(process.env.AM_WS_SUBS || "AM.*").trim();
const AM_CACHE_MAX = Math.max(200, Math.min(20000, Number(process.env.AM_CACHE_MAX || 8000)));

// AM enrich cache
const AM_ENRICH_LIMIT = Math.max(50, Math.min(500, Number(process.env.AM_ENRICH_LIMIT || 200)));
const AM_ENRICH_TTL_MS = Math.max(5000, Math.min(300000, Number(process.env.AM_ENRICH_TTL_MS || 60000)));

// Mini chart cache
const MINI_CACHE_TTL_MS = Math.max(2000, Math.min(120000, Number(process.env.MINI_CACHE_TTL_MS || 15000)));

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
    "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36";
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
function normalizeSymbolForAPI(sym) {
  const s = String(sym || "").trim().toUpperCase();
  if (!s) return "";
  if (SYMBOL_DOT_TO_DASH) return s.replace(/\./g, "-"); // BRK.B => BRK-B
  return s;
}
function parseSymbols(input) {
  return String(input || "")
    .replace(/\n/g, ",")
    .split(",")
    .map((s) => normalizeSymbolForAPI(s))
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

// ===== Session time (NY) =====
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

// ============================================================================
// SECTION 03 — Axios Safe
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
// SECTION 04 — Massive REST
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

// Aggs cache
const aggsCache = new Map();
async function fetchAggs(sym, tf = "1", limit = 300, sort = "asc") {
  const ticker = String(sym || "").trim().toUpperCase();
  const cacheKey = `${ticker}|${tf}|${sort}|${limit}`;
  const now = Date.now();
  const hit = aggsCache.get(cacheKey);
  if (hit && now - hit.ts < 15_000) return { ok: true, cached: true, bars: hit.bars };

  const base = MASSIVE_AGGS_URL.replace(/\/+$/, "");
  const to = ymd(new Date());
  const from = ymd(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
  const url = `${base}/${encodeURIComponent(ticker)}/range/${encodeURIComponent(tf)}/minute/${from}/${to}`;

  const params = { adjusted: "true", sort: String(sort), limit: String(limit) };
  if (AGGS_INCLUDE_PREPOST) params.includePrePost = "true";

  const a = auth(params, {});
  const r = await safeGet(url, { params: a.params, headers: a.headers });
  const bars = Array.isArray(r.data?.results) ? r.data.results : [];
  const ok = r.ok && bars.length > 0;
  if (ok) aggsCache.set(cacheKey, { ts: now, bars });
  return { ok, url, status: r.status, bars, errorDetail: r.errorDetail };
}
async function fetchAggs5m(sym) {
  return fetchAggs(sym, "5", AGGS_5M_LIMIT, "desc");
}

// ============================================================================
// SECTION 05 — Normalize Snapshot (OPEN/GAP fix)
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

  // ✅ OPEN fallback (reduce null)
  if (open === null) open = findFirstNumberByKeys(root, ["open", "o", "dayopen", "openprice"]).value;

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
  if (floatShares === null) floatShares = findFirstNumberByKeys(root, ["float", "freefloat", "sharesfloat", "floatshares"]).value;

  let marketCap =
    n(root?.marketCap) ??
    n(root?.marketcap) ??
    n(root?.mktcap) ??
    n(root?.market_cap) ??
    n(root?.marketCapitalization) ??
    null;
  if (marketCap === null) marketCap = findFirstNumberByKeys(root, ["marketcap", "mktcap", "market_cap", "capitalization"]).value;

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
// SECTION 06 — ALGTP Signals
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
  return "⛔";
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
// SECTION 07 — 5m Indicator engine (VWAP etc)
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
    pv += c * v;
    vv += v;
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

  return {
    ...row,
    aboveVWAP_5m: aboveVWAP,
    volSpike_5m: volSpike,
    paIcon: paSignalIcon({ aboveVWAP_5m: aboveVWAP, volSpike_5m: volSpike }),
  };
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
// SECTION 08 — HALT WS (LULD.*) + /halts
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

function startHaltWebSocket() {
  if (!ENABLE_HALT_WS) return;
  if (!WebSocketLib) return console.log("⚠️ HALT WS disabled: npm i ws");
  if (!MASSIVE_API_KEY) return console.log("⚠️ HALT WS disabled: missing MASSIVE_API_KEY");

  const ws = new WebSocketLib(MASSIVE_WS_URL);
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
  const only = String(req.query.only || "all").toLowerCase();
  const out = [];
  for (const [symbol, v] of haltedMap.entries()) {
    if (only === "halted" && !v.halted) continue;
    out.push({ symbol, ...v });
  }
  out.sort((a, b) => (b.tsMs ?? 0) - (a.tsMs ?? 0));
  res.json({ ok: true, count: out.length, results: out.slice(0, 500) });
});

// ============================================================================
// SECTION 09 — AM WS (minute aggregates) + enrich cache (OPEN fallback)
// ============================================================================
const amMap = new Map();
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

  const ws = new WebSocketLib(MASSIVE_WS_URL);
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
    setTimeout(startAMWebSocket, 3000);
  });

  ws.on("error", (err) => console.log("⚠️ AM WS error:", String(err?.message || err)));
}

// enrich cache
const amSnapCache = new Map();
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
  const op = n(am?.op) ?? null; // ✅ open fallback from AM
  const extPct = price !== null && op !== null && op > 0 ? ((price - op) / op) * 100 : null;
  const vol = n(am?.av) ?? n(am?.v) ?? null;
  const ms = toMs(am?.e) || toMs(am?.s);

  return {
    symbol: sym,
    price: price !== null ? round2(price) : null,
    open: op !== null ? round2(op) : null,
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

  let open = n(snapRow?.open);
  if (open === null) open = n(amRow?.open);

  const pricePct = price !== null && prevClose !== null && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : n(snapRow?.pricePct);
  const gapPct = open !== null && prevClose !== null && prevClose > 0 ? ((open - prevClose) / prevClose) * 100 : n(snapRow?.gapPct);

  const extPct = price !== null && prevClose !== null && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : n(amRow?.extPct);

  const volA = n(amRow?.volume);
  const volS = n(snapRow?.volume);
  const volume = volA !== null && volS !== null ? Math.max(volA, volS) : (volA ?? volS ?? null);

  return {
    ...snapRow,
    price: price !== null ? round2(price) : null,
    open: open !== null ? round2(open) : (snapRow?.open ?? null),
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
function finalizeRows(rows) {
  let out = rows.map((r) => {
    const d = demandScore(r);
    return { ...r, demandScore: d, signalIcon: signalIcon(d), paIcon: r.paIcon || "" };
  });
  out = out.map(attachHaltFlag);
  return out;
}

function groupToDirection(group) {
  if (group === "topLosers") return "losers";
  return "gainers";
}
function sortRowsByGroup(rows, group) {
  if (group === "topGappers") rows.sort((a, b) => Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0));
  else rows.sort((a, b) => Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0));
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
      const ms = toMs(raw?.lastTrade?.t ?? raw?.lastQuote?.t ?? raw?.updated ?? raw?.timestamp ?? raw?.e ?? raw?.s);
      if (!ms) return false;
      return sessionOfMs(ms) === session;
    });
  }

  rows = rows.filter((r) => capPass(r, cap));

  const { rows: withInd, aggsErrors } = await attachIndicatorsIfEnabled(rows);
  rows = finalizeRows(withInd);

  rows.sort(
    (a, b) =>
      Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0) ||
      Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0) ||
      (b.volume ?? 0) - (a.volume ?? 0)
  );

  const lim = clamp(Number(limit || 100), 5, 500);
  rows = rows.slice(0, lim);

  return { ok: true, status: 200, body: { ok: true, source: "SNAPSHOT_ALL", session: session || null, cap, results: rows, aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined } };
}

async function buildRowsFromAMCache({ cap, limit, session }) {
  let base = [];
  for (const [sym, am] of amMap.entries()) {
    const ms = toMs(am?.e) || toMs(am?.s);
    if (!ms) continue;
    if (session && sessionOfMs(ms) !== session) continue;
    base.push(normalizeFromAMOnly(sym, am));
  }
  if (!base.length) return { ok: true, status: 200, body: { ok: true, source: "AM_WS", session, cap, results: [] } };

  const needCap = String(cap || "all").toLowerCase() !== "all";
  const candidates = [...base].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0) || Math.abs(b.extPct ?? 0) - Math.abs(a.extPct ?? 0));
  const pick = candidates.slice(0, AM_ENRICH_LIMIT).map((x) => x.symbol);

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

  let rows = base.map((r) => {
    const snapRow = getSnapCached(r.symbol);
    return snapRow ? mergeAMWithSnapshot(r, snapRow) : r;
  });

  if (needCap) rows = rows.filter((r) => capPass(r, cap));

  const lim = clamp(Number(limit || 100), 5, 500);

  rows.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  rows = rows.slice(0, Math.max(lim * 2, 120));

  const { rows: withInd, aggsErrors } = await attachIndicatorsIfEnabled(rows);
  rows = finalizeRows(withInd);

  rows.sort(
    (a, b) =>
      Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0) ||
      (b.demandScore ?? 0) - (a.demandScore ?? 0) ||
      (b.volume ?? 0) - (a.volume ?? 0)
  );
  rows = rows.slice(0, lim);

  return { ok: true, status: 200, body: { ok: true, source: "AM_FALLBACK", session, cap, results: rows, aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined } };
}

// ============================================================================
// SECTION 11 — Mini Chart endpoint (hover)
// ============================================================================
const miniCache = new Map();

function smaSeries(values, len) {
  const out = Array(values.length).fill(null);
  if (values.length < len) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}
function emaSeries(values, len) {
  const out = Array(values.length).fill(null);
  if (values.length < len) return out;
  const k = 2 / (len + 1);
  let seed = 0;
  for (let i = 0; i < len; i++) seed += values[i];
  let e = seed / len;
  out[len - 1] = e;
  for (let i = len; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}
function vwapSeries(closes, vols) {
  const out = Array(closes.length).fill(null);
  let pv = 0, vv = 0;
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    const v = vols[i] || 0;
    pv += c * v;
    vv += v;
    out[i] = vv > 0 ? pv / vv : null;
  }
  return out;
}

app.get("/mini-chart", async (req, res) => {
  try {
    const sym = String(req.query.symbol || "").trim().toUpperCase();
    const tf = String(req.query.tf || "1");
    if (!sym) return res.json({ ok: false, error: "symbol required" });

    const key = `${sym}|${tf}`;
    const hit = miniCache.get(key);
    if (hit && Date.now() - hit.ts < MINI_CACHE_TTL_MS) return res.json(hit.payload);

    const miss = envMissingFor({ needAggs: true });
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const ag = await fetchAggs(sym, tf, 280, "asc");
    if (!ag.ok) return res.json({ ok: false, error: "no bars", detail: ag.errorDetail });

    const bars = ag.bars
      .map((b) => ({
        time: Math.floor((Number(b.t) || 0) / 1000),
        open: n(b.o),
        high: n(b.h),
        low: n(b.l),
        close: n(b.c),
        volume: n(b.v) ?? 0,
      }))
      .filter((x) => x.time > 0 && x.open !== null && x.high !== null && x.low !== null && x.close !== null);

    if (!bars.length) return res.json({ ok: false, error: "no bars" });

    const closes = bars.map((x) => x.close);
    const vols = bars.map((x) => x.volume);

    const ema9 = emaSeries(closes, 9);
    const ema34 = emaSeries(closes, 34);
    const sma26 = smaSeries(closes, 26);
    const vw = vwapSeries(closes, vols);

    const toLine = (arr) =>
      bars
        .map((b, i) => (arr[i] == null ? null : { time: b.time, value: Number(arr[i].toFixed(4)) }))
        .filter(Boolean);

    const payload = {
      ok: true,
      symbol: sym,
      tf,
      ohlc: bars.map(({ volume, ...x }) => x),
      overlays: {
        ema9: toLine(ema9),
        ema34: toLine(ema34),
        sma26: toLine(sma26),
        vwap: toLine(vw),
      },
    };

    miniCache.set(key, { ts: Date.now(), payload });
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: "mini-chart failed", detail: String(e?.message || e) });
  }
});

// ============================================================================
// SECTION 12 — API Routes
// ============================================================================
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: `${BRAND.legal} running ✅`,
    ui: "/ui",
    endpoints: ["/list", "/scan", "/snapshot-all", "/premarket", "/aftermarket", "/mini-chart", "/halts", "/api"],
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
      uiAutoRefreshMs: UI_AUTO_REFRESH_MS,
      importantSymbols: IMPORTANT_SYMBOLS,
      symbolDotToDash: SYMBOL_DOT_TO_DASH,
    },
  });
});

app.get("/scan", async (req, res) => {
  try {
    const miss = envMissingFor({ needAggs: ENABLE_5M_INDICATORS });
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const symbols = parseSymbols(req.query.symbols || IMPORTANT_SYMBOLS).slice(0, 250);

    const snaps = await mapPool(symbols, SNAP_CONCURRENCY, async (t) => {
      const r = await fetchTickerSnapshot(t);
      return { ticker: t, ...r };
    });

    const good = snaps.filter((x) => x.ok);
    const bad = snaps.filter((x) => !x.ok);

    let rows = good.map((x) => normalizeSnapshotAuto(x.ticker, x.data)).map(addExtPctFromPrevClose);

    // ✅ keep symbols even if snapshot failed (avoid 0 rows)
    const badRows = bad.map((x) => ({
      symbol: x.ticker,
      price: null,
      open: null,
      prevClose: null,
      pricePct: null,
      gapPct: null,
      extPct: null,
      volume: null,
      floatM: null,
      marketCapB: null,
      cap: null,
      demandScore: 0,
      signalIcon: "⚠️",
      paIcon: "",
      source: "SNAP_FAIL",
    }));
    rows = rows.concat(badRows);

    const { rows: withInd, aggsErrors } = await attachIndicatorsIfEnabled(rows);
    rows = finalizeRows(withInd);

    rows.sort((a, b) => Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0) || Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0));

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
    const miss = envMissingFor({ needAggs: ENABLE_5M_INDICATORS });
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
      .slice(0, limit * 3);

    const snaps = await mapPool(tickers, SNAP_CONCURRENCY, async (t) => {
      const r = await fetchTickerSnapshot(t);
      return { ticker: t, ...r };
    });

    const good = snaps.filter((x) => x.ok);
    const bad = snaps.filter((x) => !x.ok);

    let rows = good.map((x) => normalizeSnapshotAuto(x.ticker, x.data)).map(addExtPctFromPrevClose);
    rows = rows.filter((r) => capPass(r, cap));

    if (minGap !== null && Number.isFinite(minGap) && group === "topGappers") {
      rows = rows.filter((r) => (r.gapPct ?? 0) >= minGap);
    }

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

// ============================================================================
// SECTION 13 — UI (Top bar rounded + Symbols feature kept)
// ============================================================================
function riskNoticeContent() {
  return {
    title: "⚠️ Risk Notice & Data Disclaimer",
    vn: [
      "ALGTP™ Scanner chỉ là công cụ tham khảo — KHÔNG phải lời khuyên đầu tư.",
      "Dữ liệu phụ thuộc Internet/API bên thứ ba nên có thể trễ, thiếu, sai.",
      "Tín hiệu/score chỉ tham khảo — KHÔNG đảm bảo lợi nhuận.",
      "Daytrade/small-cap rủi ro cao, có thể mất toàn bộ vốn.",
      "Bạn tự chịu trách nhiệm. Luôn kiểm tra lại trên chart/broker.",
    ],
    en: [
      "ALGTP™ Scanner is for reference only — NOT financial advice.",
      "Data depends on internet and third-party feeds and may be delayed/inaccurate.",
      "Signals/scores are informational and do NOT guarantee profit.",
      "Trading is high risk and may result in total loss of capital.",
      "You are responsible for all decisions. Verify on chart/broker.",
    ],
  };
}

function renderUI() {
  const risk = riskNoticeContent();
  const importantDefault = IMPORTANT_SYMBOLS || "NVDA,TSLA,AAPL";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${BRAND.name} Dashboard</title>
<style>
:root{ color-scheme: dark; }
body{ margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b0d12; color:#e6e8ef; }
.wrap{ max-width:1800px; margin:0 auto; padding:0 12px; }
header{ position:sticky; top:0; background:rgba(11,13,18,.92); backdrop-filter: blur(10px); border-bottom:1px solid rgba(255,255,255,.08); z-index:20; }
.brandRow{ display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 0; }
.brandTitle{ display:flex; align-items:center; gap:10px; }
.brandMark{ font-size:18px; }
.brandName{ font-weight:900; font-size:13px; letter-spacing:.3px; }
.brandSub{ font-size:12px; color:#a7adc2; margin-top:3px; }

.pill{
  font-size:12px; padding:7px 12px; border-radius:999px;
  background:#121622; border:1px solid rgba(255,255,255,.12);
  color:#c8cde0; white-space:nowrap;
}

.panel{ border-bottom:1px solid rgba(255,255,255,.06); padding:10px 0 12px; }
.hint{ font-size:12px; color:#a7adc2; margin-top:8px; line-height:1.4; }

.right{ text-align:right; }
.mono{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.symLink{ color:#e6e8ef; text-decoration:none; border-bottom:1px dashed rgba(255,255,255,.25); cursor:pointer; }
.symLink:hover{ border-bottom-color: rgba(255,255,255,.55); }

.err{ white-space:pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size:12px; color:#ffb4b4; background:#1a0f12; border:1px solid rgba(255,128,128,.25); border-radius:12px; padding:10px 12px; margin-top:12px; display:none; }

/* ===== TOP BAR (rounded like you want) ===== */
.topBar{
  display:flex; align-items:center; justify-content:space-between;
  gap:12px; flex-wrap:wrap;
}
.topBar .left{
  display:flex; align-items:center; gap:10px;
  flex:1; min-width: 520px;
}
.topBar .right{
  display:flex; align-items:center; gap:8px; flex-wrap:wrap;
}
.tag{
  font-size:12px; padding:7px 12px; border-radius:999px;
  background:#121622; border:1px solid rgba(255,255,255,.12);
  color:#c8cde0; white-space:nowrap;
}
.symbolsInput{
  flex:1; min-width:380px;
  background:#0f1320; border:1px solid rgba(255,255,255,.14);
  border-radius:16px;
  padding:11px 14px;
  color:#e6e8ef;
}
.hintMini{
  font-size:12px; color:#a7adc2; white-space:nowrap;
}
@media (max-width: 900px){
  .topBar .left{ min-width:100%; }
  .hintMini{ display:none; }
}

/* ===== GRID ===== */
.grid{
  display:grid;
  grid-template-columns: repeat(12, 1fr);
  gap:8px;
  padding:12px 0 18px;
}
.box{
  grid-column: span 3;
  border:1px solid rgba(255,255,255,.14);
  border-radius:10px;
  overflow:hidden;
  background:#0b0d12;
  min-height:180px;
}
.box.cols2{ grid-column: span 4; }
.box.cols3{ grid-column: span 4; }
.box.cols4{ grid-column: span 6; }
.box.cols6{ grid-column: span 12; }

.boxHead{
  background:#121622;
  border-bottom:1px solid rgba(255,255,255,.10);
  padding:6px 10px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  font-weight:900;
  font-size:12px;
  letter-spacing:.3px;
}
.boxMeta{ font-weight:600; font-size:11px; color:#a7adc2; }
.boxBody{ overflow:auto; max-height:260px; }
.box table{ width:100%; border-collapse:collapse; }
.box th,.box td{
  padding:6px 8px;
  border-bottom:1px solid rgba(255,255,255,.06);
  font-size:12px;
  white-space:nowrap;
}
.box th{ position:sticky; top:0; background:#0b0d12; color:#a7adc2; }
.box tr:hover td{ background: rgba(255,255,255,.03); }

.watermark{ position: fixed; bottom: 10px; right: 12px; font-size: 11px; color: rgba(230,232,239,.30); pointer-events:none; user-select:none; z-index:9999; }

/* ===== Risk popup ===== */
.riskBack{ position:fixed; inset:0; background: rgba(0,0,0,.72); display:none; align-items:center; justify-content:center; z-index:120; }
.riskBox{ width:min(760px, 94vw); background:#0b0d12; border:1px solid rgba(255,255,255,.16); border-radius:18px; box-shadow:0 18px 70px rgba(0,0,0,.60); overflow:hidden; }
.riskTop{ padding:12px 14px; background:#121622; border-bottom:1px solid rgba(255,255,255,.10); }
.riskTitle{ font-weight:900; font-size:13px; }
.riskBody{ padding:12px 14px; color:#cdd3ea; font-size:13px; line-height:1.45; max-height: 68vh; overflow:auto; }
.riskBody ul{ margin:8px 0 0 18px; padding:0; }
.riskBody li{ margin:6px 0; }
.riskFoot{ padding:12px 14px; display:flex; justify-content:flex-end; gap:10px; background:#0b0d12; border-top:1px solid rgba(255,255,255,.08); }
.riskBtn{ cursor:pointer; border:1px solid rgba(255,255,255,.18); background:#121622; color:#e6e8ef; border-radius:12px; padding:10px 12px; font-size:13px; }
.riskBtn:disabled{ opacity:.45; cursor:not-allowed; }
</style>
</head>

<body>
<header>
  <div class="wrap">
    <div class="brandRow">
      <div>
        <div class="brandTitle">
          <span class="brandMark">${BRAND.mark}</span>
          <span class="brandName">${BRAND.legal}</span>
        </div>
        <div class="brandSub">Dashboard • Icons • VWAP • Open+Gap • Hover mini-chart • Click TV</div>
      </div>
      <div class="pill">Auto: <b>${Math.max(1, Math.round(UI_AUTO_REFRESH_MS/1000))}s</b></div>
    </div>
  </div>
</header>

<div class="panel">
  <div class="wrap">
    <div class="topBar">
      <div class="left">
        <span class="tag">🔎 SYMBOLS</span>
        <input id="symbols" class="symbolsInput"
               value="${importantDefault.replace(/"/g, "&quot;")}"
               placeholder="Type symbols: NVDA,TSLA,AAPL (Enter)" />
        <span class="hintMini">Enter → update IMPORTANT_STOCKS</span>
      </div>

      <div class="right">
        <span class="pill" id="statusPill">Dashboard</span>
        <span class="pill">Snapshot-All: <b>${ENABLE_SNAPSHOT_ALL ? "ON" : "OFF"}</b></span>
        <span class="pill">Indicators: <b>${ENABLE_5M_INDICATORS ? "ON" : "OFF"}</b></span>
      </div>
    </div>

    <div class="hint">
      TOP MOVERS + LOSS MOVERS ở TOP LEFT • Icons & VWAP on • Open/GAP best-effort • Auto refresh running
    </div>
    <div class="err" id="errBox"></div>
  </div>
</div>

<div class="wrap">
  <div class="grid" id="grid"></div>
</div>

<div class="watermark">${BRAND.watermark}</div>

<!-- Risk popup -->
<div class="riskBack" id="riskBack" aria-hidden="true">
  <div class="riskBox" role="dialog" aria-modal="true">
    <div class="riskTop"><div class="riskTitle">${risk.title}</div></div>
    <div class="riskBody">
      <div style="font-weight:900; margin-bottom:6px;">${BRAND.legal}</div>

      <div style="font-weight:900; margin-top:8px;">VI</div>
      <ul>${risk.vn.map((x)=>`<li>${x}</li>`).join("")}</ul>

      <div style="font-weight:900; margin-top:10px;">EN</div>
      <ul>${risk.en.map((x)=>`<li>${x}</li>`).join("")}</ul>

      <div style="margin-top:12px; padding:10px 12px; border:1px solid rgba(255,255,255,.10); border-radius:12px; background:#121622;">
        <label style="display:flex; gap:10px; align-items:flex-start; font-size:13px; line-height:1.35; cursor:pointer;">
          <input type="checkbox" id="riskAgree" style="transform:translateY(2px);" />
          <span><b>I Understand & Agree</b><br/>Tôi đã hiểu và đồng ý với cảnh báo rủi ro.</span>
        </label>
      </div>

      <div id="riskHint" style="margin-top:10px; color:#ffb4b4; font-size:12px; display:none;">
        ⚠️ Please check “I Understand & Agree” to continue.
      </div>
    </div>
    <div class="riskFoot"><button class="riskBtn" id="riskContinueBtn" disabled>Continue</button></div>
  </div>
</div>

<script src="https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js"></script>
<script>
const byId = (id) => document.getElementById(id);
const grid = byId("grid");
const errBox = byId("errBox");
const statusPill = byId("statusPill");

let riskAccepted = false;

// risk popup
(function riskNotice(){
  const back = byId("riskBack");
  const agree = byId("riskAgree");
  const btn = byId("riskContinueBtn");
  const hint = byId("riskHint");

  back.style.display = "flex";
  agree.checked = false;
  btn.disabled = true;

  agree.addEventListener("change", () => {
    btn.disabled = !agree.checked;
    hint.style.display = agree.checked ? "none" : "block";
  });

  btn.addEventListener("click", () => {
    if (!agree.checked) { hint.style.display = "block"; return; }
    riskAccepted = true;
    back.style.display = "none";
  });
})();
function riskIsOpen(){ return !riskAccepted; }

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

// TradingView click
function tvUrlFor(sym){
  return "https://www.tradingview.com/chart/?symbol=" + encodeURIComponent("NASDAQ:" + sym) + "&interval=5";
}
window.handleTickerClick = function(ev, sym){
  window.open(tvUrlFor(sym), "_blank", "noopener,noreferrer");
};

// hover mini chart
let miniBox=null, miniChart=null, candle=null, lineEMA9=null, lineEMA34=null, lineSMA26=null, lineVWAP=null;
let miniSym=null, hoverTimer=null;
const miniCache = new Map();

function ensureMiniBox(){
  if (miniBox) return;
  miniBox=document.createElement("div");
  miniBox.style.position="fixed";
  miniBox.style.width="380px";
  miniBox.style.height="250px";
  miniBox.style.background="#0b0d12";
  miniBox.style.border="1px solid rgba(255,255,255,.18)";
  miniBox.style.borderRadius="16px";
  miniBox.style.boxShadow="0 18px 70px rgba(0,0,0,.55)";
  miniBox.style.padding="10px";
  miniBox.style.zIndex="110";
  miniBox.style.display="none";
  miniBox.innerHTML=\`
    <div id="miniTitle" style="font-weight:900;font-size:12px;margin-bottom:6px;"></div>
    <div id="miniChart" style="width:100%;height:190px;"></div>
    <div style="margin-top:6px;font-size:11px;color:#a7adc2">Hover = mini chart • Click = TradingView</div>\`;
  document.body.appendChild(miniBox);

  const el = miniBox.querySelector("#miniChart");
  miniChart = LightweightCharts.createChart(el, {
    layout: { background: { type: "solid", color: "#0b0d12" }, textColor: "#c8cde0" },
    grid: { vertLines: { visible: false }, horzLines: { visible: false } },
    rightPriceScale: { visible: true },
    timeScale: { visible: false },
    crosshair: { mode: 0 },
  });
  candle = miniChart.addCandlestickSeries();
  lineEMA9  = miniChart.addLineSeries();
  lineEMA34 = miniChart.addLineSeries();
  lineSMA26 = miniChart.addLineSeries();
  lineVWAP  = miniChart.addLineSeries();
}

function posMini(ev){
  const pad=12;
  let x=ev.clientX+pad, y=ev.clientY+pad;
  const w=400,h=270;
  if (x+w>window.innerWidth) x=ev.clientX-w-pad;
  if (y+h>window.innerHeight) y=ev.clientY-h-pad;
  miniBox.style.left=x+"px";
  miniBox.style.top=y+"px";
}

async function fetchMini(sym){
  if (miniCache.has(sym)) return miniCache.get(sym);
  const r = await fetch("/mini-chart?symbol="+encodeURIComponent(sym)+"&tf=1");
  const j = await r.json();
  if (!j.ok) return null;
  miniCache.set(sym,j);
  return j;
}

async function showMini(ev, sym){
  ensureMiniBox();
  miniSym=sym;
  posMini(ev);
  miniBox.style.display="block";
  miniBox.querySelector("#miniTitle").textContent = "📈 " + sym + " — mini chart";

  const data = await fetchMini(sym);
  if (!data || miniSym!==sym) return;

  candle.setData(data.ohlc||[]);
  lineEMA9.setData(data.overlays?.ema9||[]);
  lineEMA34.setData(data.overlays?.ema34||[]);
  lineSMA26.setData(data.overlays?.sma26||[]);
  lineVWAP.setData(data.overlays?.vwap||[]);
}

function hideMini(){ miniSym=null; if(miniBox) miniBox.style.display="none"; }

function bindMiniHover(){
  document.querySelectorAll(".symLink").forEach(a=>{
    const sym = a.getAttribute("data-sym") || a.textContent.trim();
    a.onmouseenter = (ev)=>{ clearTimeout(hoverTimer); hoverTimer=setTimeout(()=>showMini(ev,sym),120); };
    a.onmousemove  = (ev)=>{ if(miniBox && miniBox.style.display==="block") posMini(ev); };
    a.onmouseleave = ()=>{ clearTimeout(hoverTimer); hideMini(); };
  });
}

// ===== dashboard sections (TOP LEFT movers/losers) =====
let importantSymbols = ${JSON.stringify(importantDefault)};
const REFRESH_MS = ${UI_AUTO_REFRESH_MS};

const SECTIONS = [
  // TOP LEFT
  { id:"top_movers",  title:"TOP MOVERS",  url:"/list?group=topGainers&cap=all&limit=80", cols:2, limit:6, sort:"pctDesc" },
  { id:"loss_movers", title:"LOSS MOVERS", url:"/list?group=topLosers&cap=all&limit=80",  cols:2, limit:6, sort:"pctAsc" },

  { id:"penny_gappers", title:"PENNY_GAPPERS", url:"/list?group=topGappers&cap=all&limit=120&minGap=10", cols:2, limit:6, sort:"gapDesc" },
  { id:"important", title:"IMPORTANT_STOCKS", url:"/scan?symbols="+encodeURIComponent(importantSymbols), cols:2, limit:8, sort:"gapDesc" },

  { id:"vwap", title:"VWAP", url:"/list?group=topGainers&cap=all&limit=120", cols:3, limit:6, sort:"vwapFocus" },
  { id:"breaking_high", title:"BREAKING HIGH WITH VOLUME", url:"/list?group=topGainers&cap=all&limit=120", cols:3, limit:6, sort:"gapDesc" },
  { id:"flush", title:"FLUSH", url:"/list?group=topLosers&cap=all&limit=120", cols:3, limit:6, sort:"gapDesc" },

  { id:"cheap", title:"CHEAP STOCKS", url:"/scan?symbols=XTKG,CCTG,CNTM,OPTT,SBEV", cols:3, limit:6, sort:"gapDesc" },
  { id:"halts", title:"HALT", url:"/halts?only=all", cols:3, limit:10, type:"halts" },
];

function boxHtml(sec){
  const cls = sec.cols ? "cols"+sec.cols : "";
  return \`
    <div class="box \${cls}" id="box_\${sec.id}">
      <div class="boxHead">
        <div>\${sec.title}</div>
        <div class="boxMeta" id="meta_\${sec.id}">...</div>
      </div>
      <div class="boxBody" id="body_\${sec.id}"></div>
    </div>\`;
}

function renderGrid(){ grid.innerHTML = SECTIONS.map(boxHtml).join(""); }

function sortRows(rows, mode){
  const safe = (v)=> (Number.isFinite(Number(v)) ? Number(v) : null);

  if (mode==="pctDesc") return [...rows].sort((a,b)=> (safe(b.pricePct)??-1e18)-(safe(a.pricePct)??-1e18));
  if (mode==="pctAsc")  return [...rows].sort((a,b)=> (safe(a.pricePct)?? 1e18)-(safe(b.pricePct)?? 1e18));
  if (mode==="gapDesc") return [...rows].sort((a,b)=> (safe(b.gapPct)??-1e18)-(safe(a.gapPct)??-1e18));

  if (mode==="vwapFocus"){
    return [...rows].sort((a,b)=>
      (Number(b.aboveVWAP_5m&&b.volSpike_5m)-Number(a.aboveVWAP_5m&&a.volSpike_5m)) ||
      (Number(b.aboveVWAP_5m)-Number(a.aboveVWAP_5m)) ||
      (safe(b.gapPct)??-1e18)-(safe(a.gapPct)??-1e18)
    );
  }

  return rows;
}

function rowsTable(rowsRaw, sec){
  const rows = sortRows(rowsRaw, sec.sort).slice(0, sec.limit ?? 6);

  return \`
  <table>
    <thead>
      <tr>
        <th>Sig</th>
        <th>PA</th>
        <th>Symbol</th>
        <th class="right">Price</th>
        <th class="right">Open</th>
        <th class="right">Gap%</th>
        <th class="right">VWAP</th>
        <th class="right">Vol</th>
        <th class="right">New_Vol</th>
        <th class="right">Float</th>
      </tr>
    </thead>
    <tbody>
      \${rows.map(r=>{
        const sym=String(r.symbol||"");
        const safeSym=sym.replace(/'/g,"");
        return \`
        <tr>
          <td>\${r.signalIcon||""}</td>
          <td>\${r.paIcon||""}</td>
          <td class="mono">
            <a class="symLink" data-sym="\${safeSym}" href="javascript:void(0)" onclick="handleTickerClick(event,'\${safeSym}')">\${sym}</a>
          </td>
          <td class="right mono">\${fmtNum(r.price)}</td>
          <td class="right mono">\${fmtNum(r.open)}</td>
          <td class="right mono">\${fmtNum(r.gapPct)}%</td>
          <td class="right mono">\${fmtNum(r.vwap_5m)}</td>
          <td class="right mono">\${fmtInt(r.volume)}</td>
          <td class="right mono">\${fmtInt(r.lastVol_5m)}</td>
          <td class="right mono">\${fmtNum(r.floatM)}</td>
        </tr>\`;
      }).join("")}
    </tbody>
  </table>\`;
}

function haltsTable(rows){
  const top = rows.slice(0, 30);
  return \`
  <table>
    <thead>
      <tr>
        <th>Symbol</th>
        <th>Time</th>
        <th>Description</th>
      </tr>
    </thead>
    <tbody>
      \${top.map(x=>{
        const t = x.tsMs ? new Date(x.tsMs).toLocaleTimeString() : "-";
        const desc = x.halted ? "Halted" : "Resumed";
        return \`
          <tr>
            <td class="mono">\${x.symbol||""}</td>
            <td class="mono">\${t}</td>
            <td>\${desc}</td>
          </tr>\`;
      }).join("")}
    </tbody>
  </table>\`;
}

async function loadSection(sec){
  const meta = byId("meta_"+sec.id);
  const body = byId("body_"+sec.id);

  try{
    meta.textContent="Loading...";
    const r = await fetch(sec.url);
    const j = await r.json();

    if (!j || !j.ok){
      meta.textContent="Error";
      body.innerHTML = "<div style='padding:10px;color:#ffb4b4;font-size:12px;'>"+(JSON.stringify(j).slice(0,700))+"</div>";
      return;
    }

    meta.textContent = (j.results?.length ?? j.count ?? 0) + " rows • " + new Date().toLocaleTimeString();

    if (sec.type==="halts"){
      const rows = Array.isArray(j.results) ? j.results : [];
      body.innerHTML = haltsTable(rows);
    }else{
      const rows = Array.isArray(j.results) ? j.results : [];
      body.innerHTML = rowsTable(rows, sec);
      bindMiniHover();
    }
  }catch(e){
    meta.textContent="Error";
    body.innerHTML = "<div style='padding:10px;color:#ffb4b4;font-size:12px;'>"+String(e?.message||e)+"</div>";
  }
}

function loadAll(){
  clearError();
  for (const sec of SECTIONS) loadSection(sec);
}

// Symbols feature kept: Enter => refresh IMPORTANT_STOCKS only
(function bindSymbolsSearch(){
  const input = byId("symbols");
  if (!input) return;

  input.addEventListener("keydown",(e)=>{
    if (e.key !== "Enter") return;
    const val = String(input.value||"").trim();
    if (!val) return;

    importantSymbols = val;
    const sec = SECTIONS.find(s=>s.id==="important");
    if (!sec) return;

    sec.url = "/scan?symbols=" + encodeURIComponent(importantSymbols);
    loadSection(sec);

    statusPill.textContent = "Updated";
    setTimeout(()=>statusPill.textContent="Dashboard", 900);
  });
})();

// init
renderGrid();
loadAll();

// auto refresh
setInterval(()=>{
  if (REFRESH_MS<=0) return;
  if (riskIsOpen()) return;
  if (miniBox && miniBox.style.display==="block") return;
  loadAll();
}, REFRESH_MS);

</script>
</body>
</html>`;
}

app.get("/ui", (req, res) => res.type("html").send(renderUI()));

// ============================================================================
// SECTION 14 — Start WS + Listen
// ============================================================================
startHaltWebSocket();
startAMWebSocket();

app.listen(PORT, () => {
  const base = `http://localhost:${PORT}`;
  console.log(`\n✅ ${BRAND.legal} running`);
  console.log(`🚀 UI: ${base}/ui`);
  console.log(`📈 Mini chart: ${base}/mini-chart?symbol=AAPL&tf=1`);
  console.log(`⛔ Halts: ${base}/halts`);
  console.log(`ℹ️ API: ${base}/api`);
  console.log("");
});
