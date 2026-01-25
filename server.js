/**
 * ============================================================================
 * 🔥 ALGTP™ – Algorithmic Trading Platform
 * Smart Market Scanner (Day Trade Core + Pro/Extended Modules)
 * ----------------------------------------------------------------------------
 * Single-file Node.js server (CommonJS)
 *
 * UI:
 *  - /ui (Dashboard) + tabs (Gainers/Losers/Gappers/Cap buckets/Pre/After/Snapshot-All/Top Movers)
 * API:
 *  - /list, /scan, /premarket, /aftermarket, /snapshot-all, /halts
 * Extra:
 *  - /top-movers  (SECTION 21, standalone)
 * Help:
 *  - /help
 *
 * ENV (minimum):
 *  - PORT=3000
 *  - MASSIVE_API_KEY=...
 *  - MASSIVE_AUTH_TYPE=query|xapi|bearer
 *  - MASSIVE_QUERY_KEYNAME=apiKey
 *  - MASSIVE_MOVER_URL=https://api.massive.com/v2/snapshot/locale/us/markets/stocks
 *  - MASSIVE_TICKER_SNAPSHOT_URL=https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers
 *
 * ENV (Pro / Extended):
 *  - MASSIVE_AGGS_URL=https://api.massive.com/v2/aggs/ticker
 *  - MASSIVE_SNAPSHOT_ALL_URL=https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers
 *  - ENABLE_HALT_WS=true
 *  - MASSIVE_WS_URL=wss://socket.massive.com/stocks
 *
 * Feature toggles:
 *  - DEBUG=true|false
 *  - SNAP_CONCURRENCY=4
 *  - INCLUDE_OTC=false
 *
 *  - ENABLE_5M_INDICATORS_DAYTRADE=false
 *  - ENABLE_5M_INDICATORS_PRO=true
 *  - AGGS_5M_LIMIT=120
 *  - AGGS_INCLUDE_PREPOST=true
 *  - VOL_SPIKE_MULT=1.5
 *  - VOL_AVG_LEN_5M=20
 *
 *  - ENABLE_SNAPSHOT_ALL=false   (recommended default)
 *
 * Disclaimer:
 *  - DISCLAIMER_MODE=simple|pro   (default simple)
 *  - DISCLAIMER_TTL_DAYS=7
 *  - DISCLAIMER_AUTO_CLOSE_MS=5000
 * ============================================================================
 */

// ============================================================================
// SECTION 01 — Brand Identity & Logo System
// Debug tag: SECTION01_BRAND_LOGO
// ============================================================================
const BRAND = {
  mark: "🔥",
  name: "ALGTP™",
  legal: "ALGTP™ – Algorithmic Trading Platform",
  subtitle: "Smart Market Scanner",
  watermark: "Powered by ALGTP™",
};

// ============================================================================
// SECTION 02 — Imports + App Boot (CommonJS only)
// Debug tag: SECTION02_BOOT_IMPORTS
// ============================================================================
require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ============================================================================
// SECTION 03 — ENV Config + Runtime Modes
// Debug tag: SECTION03_ENV_CONFIG
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

const MASSIVE_AGGS_URL = String(process.env.MASSIVE_AGGS_URL || "https://api.massive.com/v2/aggs/ticker").trim();

const MASSIVE_SNAPSHOT_ALL_URL = String(
  process.env.MASSIVE_SNAPSHOT_ALL_URL || "https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers"
).trim();

const INCLUDE_OTC = String(process.env.INCLUDE_OTC || "false").toLowerCase() === "true";
const SNAP_CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.SNAP_CONCURRENCY || 4)));
const DEBUG = String(process.env.DEBUG || "true").toLowerCase() === "true";

// Indicators toggles by mode
const ENABLE_5M_INDICATORS_DAYTRADE =
  String(process.env.ENABLE_5M_INDICATORS_DAYTRADE || "false").toLowerCase() === "true";
const ENABLE_5M_INDICATORS_PRO = String(process.env.ENABLE_5M_INDICATORS_PRO || "true").toLowerCase() === "true";

const AGGS_5M_LIMIT = Math.max(40, Math.min(5000, Number(process.env.AGGS_5M_LIMIT || 120)));
const AGGS_INCLUDE_PREPOST = String(process.env.AGGS_INCLUDE_PREPOST || "true").toLowerCase() === "true";
const VOL_SPIKE_MULT = Math.max(1.1, Math.min(10, Number(process.env.VOL_SPIKE_MULT || 1.5)));
const VOL_AVG_LEN_5M = Math.max(5, Math.min(200, Number(process.env.VOL_AVG_LEN_5M || 20)));

const ENABLE_SNAPSHOT_ALL = String(process.env.ENABLE_SNAPSHOT_ALL || "false").toLowerCase() === "true";

// HALT WS
const ENABLE_HALT_WS = String(process.env.ENABLE_HALT_WS || "true").toLowerCase() === "true";
const MASSIVE_WS_URL = String(process.env.MASSIVE_WS_URL || "wss://socket.massive.com/stocks").trim();

// Disclaimer
const DISCLAIMER_MODE = String(process.env.DISCLAIMER_MODE || "simple").toLowerCase();
const DISCLAIMER_TTL_DAYS = Math.max(1, Math.min(365, Number(process.env.DISCLAIMER_TTL_DAYS || 7)));
const DISCLAIMER_AUTO_CLOSE_MS = Math.max(1000, Math.min(30000, Number(process.env.DISCLAIMER_AUTO_CLOSE_MS || 5000)));

// ============================================================================
// SECTION 04 — Core Helpers (parse/number/clamp/pool)
// Debug tag: SECTION04_HELPERS_POOL
// ============================================================================
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function n(x) { const v = Number(x); return Number.isFinite(v) ? v : null; }
function round2(x) { const v = n(x); return v === null ? null : Number(v.toFixed(2)); }
function parseSymbols(input) {
  return String(input || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
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

// ============================================================================
// SECTION 05 — Auth Layer (query/xapi/bearer)
// Debug tag: SECTION05_AUTH
// ============================================================================
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

// ============================================================================
// SECTION 06 — Safe HTTP (Axios Guard)
// Debug tag: SECTION06_SAFE_HTTP
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
// SECTION 07 — ENV Guard (per feature needs)
// Debug tag: SECTION07_ENV_GUARD
// ============================================================================
function envMissingFor({ needAggs = false, needSnapshotAll = false } = {}) {
  const miss = [];
  if (!MASSIVE_API_KEY) miss.push("MASSIVE_API_KEY");
  if (!MASSIVE_MOVER_URL) miss.push("MASSIVE_MOVER_URL");
  if (!MASSIVE_TICKER_SNAPSHOT_URL) miss.push("MASSIVE_TICKER_SNAPSHOT_URL");
  if (needAggs && !MASSIVE_AGGS_URL) miss.push("MASSIVE_AGGS_URL");
  if (needSnapshotAll && !MASSIVE_SNAPSHOT_ALL_URL) miss.push("MASSIVE_SNAPSHOT_ALL_URL");
  return miss;
}
function shouldEnableIndicators(mode) {
  return mode === "pro" ? ENABLE_5M_INDICATORS_PRO : ENABLE_5M_INDICATORS_DAYTRADE;
}

// ============================================================================
// SECTION 08 — Data Sources (Movers/Snapshot/Snapshot-All)
// Debug tag: SECTION08_SOURCES
// ============================================================================
async function fetchMovers(direction = "gainers") {
  const d = String(direction || "gainers").toLowerCase().trim();
  const directionSafe = d === "losers" ? "losers" : "gainers";
  const url = `${MASSIVE_MOVER_URL.replace(/\/+$/, "")}/${directionSafe}`;

  const params = {};
  const headers = {};
  if (INCLUDE_OTC) params.include_otc = "true";
  const a = auth(params, headers);

  const r = await safeGet(url, { params: a.params, headers: a.headers });
  const rows = Array.isArray(r.data?.tickers) ? r.data.tickers : Array.isArray(r.data?.results) ? r.data.results : Array.isArray(r.data?.data) ? r.data.data : [];
  return { ok: r.ok && Array.isArray(rows), status: r.status, url, rows, errorDetail: r.errorDetail };
}

async function fetchTickerSnapshot(ticker) {
  const url = `${MASSIVE_TICKER_SNAPSHOT_URL.replace(/\/+$/, "")}/${encodeURIComponent(String(ticker || "").trim().toUpperCase())}`;
  const a = auth({}, {});
  const r = await safeGet(url, { params: a.params, headers: a.headers });
  return { ok: r.ok, status: r.status, url, data: r.data, errorDetail: r.errorDetail };
}

async function fetchSnapshotAll() {
  const url = MASSIVE_SNAPSHOT_ALL_URL.replace(/\/+$/, "");
  const a = auth({}, {});
  const r = await safeGet(url, { params: a.params, headers: a.headers });
  const rows = Array.isArray(r.data?.tickers) ? r.data.tickers : Array.isArray(r.data?.results) ? r.data.results : Array.isArray(r.data?.data) ? r.data.data : [];
  return { ok: r.ok && Array.isArray(rows), status: r.status, url, rows, errorDetail: r.errorDetail };
}

// ============================================================================
// SECTION 09 — Normalize Snapshot + Categories
// Debug tag: SECTION09_NORMALIZE
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

  if (price === null) price = findFirstNumberByKeys(root, ["price","last","lastprice","last_price","p","c","close"]).value;
  if (open === null) open = findFirstNumberByKeys(root, ["open","o"]).value;

  let prevC = prevClose;
  if (prevC === null) prevC = findFirstNumberByKeys(root, ["prevclose","previousclose","prev_close","pc","prevc"]).value;

  if (volume === null) volume = findFirstNumberByKeys(root, ["volume","v","dayvolume","day_volume"]).value;

  if (pricePct === null && price !== null && prevC !== null && prevC > 0) pricePct = ((price - prevC) / prevC) * 100;
  const gapPct = open !== null && prevC !== null && prevC > 0 ? ((open - prevC) / prevC) * 100 : null;

  let floatShares = n(root?.float) ?? n(root?.freeFloat) ?? n(root?.sharesFloat) ?? n(root?.floatShares) ?? null;
  if (floatShares === null) floatShares = findFirstNumberByKeys(root, ["float","freefloat","free_float","sharesfloat","floatshares","publicfloat","public_float"]).value;

  let marketCap =
    n(root?.marketCap) ?? n(root?.marketcap) ?? n(root?.mktcap) ?? n(root?.market_cap) ?? n(root?.marketCapitalization) ?? null;
  if (marketCap === null) marketCap = findFirstNumberByKeys(root, ["marketcap","mktcap","market_cap","marketcapitalization","cap","capitalization"]).value;

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
  };
}

// ============================================================================
// SECTION 10 — Signals (Demand + Vol/Float tier + Icons)
// Debug tag: SECTION10_SIGNALS
// ============================================================================
function demandScore(row) {
  const gap = Math.abs(n(row?.gapPct) ?? 0);
  const pc = Math.abs(n(row?.pricePct) ?? 0);
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
function volFloatTier(x) {
  const v = n(x);
  if (v === null || v < 1.5) return { icon: "", label: null };
  if (v >= 15) return { icon: "💣💣", label: "15x+" };
  if (v >= 10) return { icon: "🚀🚀", label: "10x" };
  if (v >= 5) return { icon: "🚀", label: "5x" };
  if (v >= 4) return { icon: "🔥🔥", label: "4x" };
  if (v >= 3) return { icon: "🔥", label: "3x" };
  if (v >= 2) return { icon: "⚡", label: "2x" };
  return { icon: "👀", label: "1.5x+" };
}
function attachVolFloat(row) {
  const vol = n(row?.volume);
  const flt = n(row?.floatShares);
  if (vol === null || flt === null || flt <= 0) return { ...row, volFloatX: null, volFloatIcon: "", volFloatLabel: null };
  const x = vol / flt;
  const tier = volFloatTier(x);
  return { ...row, volFloatX: round2(x), volFloatIcon: tier.icon, volFloatLabel: tier.label };
}

// ============================================================================
// SECTION 11 — 5m Indicators (SMA26/EMA9/EMA34/VWAP) + Cache
// Debug tag: SECTION11_INDICATORS
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
  let ema = 0;
  for (let i = 0; i < len; i++) ema += closes[i];
  ema /= len;
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
const aggsCache = new Map(); // SYM|5m -> {ts,bars}
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
  const rvol = lastVol !== null && avgVol !== null && avgVol > 0 ? lastVol / avgVol : null;

  return { ...row, aboveVWAP_5m: aboveVWAP, volSpike_5m: volSpike, rvol_5m: rvol !== null ? round2(rvol) : null, paIcon: paSignalIcon({ aboveVWAP_5m: aboveVWAP, volSpike_5m: volSpike }) };
}

// ============================================================================
// SECTION 12 — Session Engine (Pre/RTH/After) + Ext%
// Debug tag: SECTION12_SESSION
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
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return { h, m };
  } catch { return { h: 0, m: 0 }; }
}
function sessionOfMs(ms) {
  const { h, m } = nyHM(ms);
  const mins = h * 60 + m;
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "pre";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "rth";
  if (mins >= 16 * 60 && mins < 20 * 60) return "after";
  return "off";
}
function snapshotTs(rawSnap) {
  const t = rawSnap?.lastTrade?.t ?? rawSnap?.lastQuote?.t ?? rawSnap?.updated ?? rawSnap?.timestamp ?? null;
  return toMs(t);
}
function addExtPct(row, rawSnap) {
  const prevClose = n(rawSnap?.prevDay?.c ?? rawSnap?.prevDay?.close) ?? null;
  const price = n(row?.price) ?? null;
  const extPct = price !== null && prevClose !== null && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null;
  return { ...row, extPct: extPct !== null ? round2(extPct) : null };
}

// ============================================================================
// SECTION 13 — HALT / RESUME WebSocket (LULD) + /halts
// Debug tag: SECTION13_HALT
// ============================================================================
let WebSocketLib = null;
try {
  WebSocketLib = require("ws");
  WebSocketLib = WebSocketLib.default || WebSocketLib.WebSocket || WebSocketLib;
} catch { WebSocketLib = null; }

const haltedMap = new Map(); // symbol -> { halted, lastEvent, tsMs, reason }
function nowMs() { return Date.now(); }
function setHalt(sym) { haltedMap.set(sym, { halted: true, lastEvent: "HALT", tsMs: nowMs(), reason: "LULD" }); }
function setResume(sym) { haltedMap.set(sym, { halted: false, lastEvent: "RESUME", tsMs: nowMs(), reason: "LULD" }); }
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
let wsInstance = null;
function startHaltWebSocket() {
  if (!ENABLE_HALT_WS) return;
  if (!WebSocketLib) { console.log("⚠️ HALT WS disabled: npm i ws"); return; }
  if (!MASSIVE_API_KEY) { console.log("⚠️ HALT WS disabled: missing MASSIVE_API_KEY"); return; }

  try { if (wsInstance && wsInstance.readyState === 1) return; } catch {}

  const ws = new WebSocketLib(MASSIVE_WS_URL);
  wsInstance = ws;

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
    try { handleWsPayload(JSON.parse(buf.toString("utf8"))); } catch {}
  });

  ws.on("close", () => {
    console.log("⚠️ HALT WS closed. Reconnect in 3s...");
    wsInstance = null;
    setTimeout(() => startHaltWebSocket(), 3000);
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
// SECTION 14 — Smart Filters (Server-side)
// Debug tag: SECTION14_FILTERS
// ============================================================================
function toNumQ(v) { const x = Number(String(v ?? "").trim()); return Number.isFinite(x) ? x : null; }
function applySmartFilters(rows, q) {
  const minPrice = toNumQ(q.minPrice), maxPrice = toNumQ(q.maxPrice), minVol = toNumQ(q.minVol), minRVOL = toNumQ(q.minRVOL);
  const minCapB = toNumQ(q.minCapB), maxCapB = toNumQ(q.maxCapB), minFloatM = toNumQ(q.minFloatM), maxFloatM = toNumQ(q.maxFloatM);

  return rows.filter((r) => {
    const price = n(r.price), vol = n(r.volume), capB = n(r.marketCapB), floatM = n(r.floatM), rvol = n(r.rvol_5m);
    if (minPrice !== null && (price === null || price < minPrice)) return false;
    if (maxPrice !== null && (price === null || price > maxPrice)) return false;
    if (minVol !== null && (vol === null || vol < minVol)) return false;
    if (minRVOL !== null && (rvol === null || rvol < minRVOL)) return false;
    if (minCapB !== null && (capB === null || capB < minCapB)) return false;
    if (maxCapB !== null && (capB === null || capB > maxCapB)) return false;
    if (minFloatM !== null && (floatM === null || floatM < minFloatM)) return false;
    if (maxFloatM !== null && (floatM === null || floatM > maxFloatM)) return false;
    return true;
  });
}

// ============================================================================
// SECTION 15 — Group Router + Builders
// Debug tag: SECTION15_GROUPS
// ============================================================================
function capPass(row, cap) {
  const c = String(cap || "all").toLowerCase();
  if (c === "all") return true;
  if (!row.cap) return false;
  return row.cap === c;
}
function groupToDirection(group) { return group === "topLosers" ? "losers" : "gainers"; }
function sortRowsByGroup(rows, group) {
  if (group === "topGappers") rows.sort((a, b) => Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0));
  else rows.sort((a, b) => Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0));
}
async function attachIndicatorsIfEnabled(rows, mode, errorsOut) {
  if (!shouldEnableIndicators(mode)) return rows;
  const ind = await mapPool(rows, SNAP_CONCURRENCY, async (r) => {
    const a = await fetchAggs5m(r.symbol);
    if (!a.ok) {
      errorsOut.push({ ticker: r.symbol, status: a.status, url: a.url, errorDetail: a.errorDetail });
      return { symbol: r.symbol, sma26_5m: null, ema9_5m: null, ema34_5m: null, vwap_5m: null, lastVol_5m: null, avgVol_5m: null };
    }
    return { symbol: r.symbol, ...indicatorsFromAggs5m(a.bars) };
  });
  const mapInd = new Map(ind.map((x) => [x.symbol, x]));
  let out = rows.map((r) => ({ ...r, ...(mapInd.get(r.symbol) || {}) }));
  out = out.map((r) => attach5mSignals(r));
  return out;
}
function finalizeRows(rows, mode) {
  let out = rows.map(attachVolFloat);
  out = out.map((r) => {
    const d = demandScore(r);
    return { ...r, demandScore: d, signalIcon: signalIcon(d), paIcon: r.paIcon || "" };
  });
  if (mode === "pro") out = out.map(attachHaltFlag);
  return out;
}
async function buildRowsFromMovers({ group, cap, limit, minGap, mode, query }) {
  const movers = await fetchMovers(groupToDirection(group));
  if (!movers.ok) return { ok: false, status: 500, body: { ok: false, error: "Movers failed", moverDebug: movers } };

  const lim = clamp(Number(limit || 50), 5, 200);
  const tickers = movers.rows
    .map((x) => String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase())
    .filter(Boolean)
    .slice(0, lim);

  const snaps = await mapPool(tickers, SNAP_CONCURRENCY, async (t) => ({ ticker: t, ...(await fetchTickerSnapshot(t)) }));
  const good = snaps.filter((x) => x.ok);
  const bad = snaps.filter((x) => !x.ok);

  let rows = good.map((x) => normalizeSnapshotAuto(x.ticker, x.data));
  rows = rows.filter((r) => capPass(r, cap));

  if (group === "topGappers") {
    const mg = n(minGap);
    if (mg !== null && Number.isFinite(mg)) rows = rows.filter((r) => (r.gapPct ?? 0) >= mg);
  }

  const aggsErrors = [];
  rows = await attachIndicatorsIfEnabled(rows, mode, aggsErrors);
  rows = applySmartFilters(rows, query || {});
  rows = finalizeRows(rows, mode);
  sortRowsByGroup(rows, group);

  return { ok: true, status: 200, body: { ok: true, mode, group, cap, limitRequested: lim, results: rows, snapshotErrors: DEBUG ? bad.slice(0, 10) : undefined, aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined } };
}
async function buildRowsFromSnapshotAll({ cap, limit, session, mode, query }) {
  if (!ENABLE_SNAPSHOT_ALL && (session || String(query?.group || "") === "snapshotAll")) {
    return { ok: false, status: 403, body: { ok: false, error: "Snapshot-All is disabled", hint: "Set ENABLE_SNAPSHOT_ALL=true to enable." } };
  }
  const snap = await fetchSnapshotAll();
  if (!snap.ok) return { ok: false, status: 500, body: { ok: false, error: "Snapshot-all failed", debug: snap } };

  const snapMap = new Map();
  for (const x of snap.rows) {
    const t = String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase();
    if (t) snapMap.set(t, x);
  }

  let rows = [];
  for (const [ticker, rawSnap] of snapMap.entries()) rows.push(addExtPct(normalizeSnapshotAuto(ticker, rawSnap), rawSnap));

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
  rows = await attachIndicatorsIfEnabled(rows, mode, aggsErrors);
  rows = applySmartFilters(rows, query || {});
  rows = finalizeRows(rows, mode);

  rows.sort(
    (a, b) =>
      Math.abs(b.extPct ?? 0) - Math.abs(a.extPct ?? 0) ||
      Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0) ||
      (b.volume ?? 0) - (a.volume ?? 0)
  );

  const lim = clamp(Number(limit || 100), 5, 500);
  rows = rows.slice(0, lim);

  return { ok: true, status: 200, body: { ok: true, mode, session: session || null, cap, results: rows, aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined } };
}

// ============================================================================
// SECTION 16 — UI Renderer (includes Top Movers + TradingView Chart)
// Debug tag: SECTION16_UI_RENDER
// ============================================================================
function disclaimerContent() {
  const simpleTitle = `⚠️ ${BRAND.name} Disclaimer`;
  const proTitle = `⚠️ Risk Disclosure & No Investment Advice`;

  const simpleVN = [
    `${BRAND.name} chỉ là công cụ scan dữ liệu để bạn tham khảo, không phải lời khuyên mua/bán.`,
    `Dữ liệu có thể trễ/thiếu/sai tuỳ nguồn API và điều kiện thị trường.`,
    `Day trading rủi ro cao — bạn tự chịu trách nhiệm với mọi quyết định.`,
    `Luôn kiểm tra lại trên chart/broker trước khi vào lệnh.`,
  ];
  const simpleEN = [
    `${BRAND.name} is a market scanner for reference only — not financial advice.`,
    `Data may be delayed, incomplete, or inaccurate due to third-party feeds.`,
    `Day trading is high risk. You are responsible for your trades.`,
    `Always confirm on your chart/broker before entering a position.`,
  ];
  const proVN = [
    `${BRAND.name} cung cấp dữ liệu thị trường và phân tích kỹ thuật cho mục đích tham khảo/giáo dục.`,
    `Nội dung hiển thị không cấu thành tư vấn đầu tư hay khuyến nghị mua/bán.`,
    `Dữ liệu phụ thuộc bên thứ ba (API) nên có thể trễ, thiếu hoặc sai.`,
    `Giao dịch có rủi ro cao và có thể mất toàn bộ vốn.`,
    `Bạn chịu trách nhiệm hoàn toàn cho mọi quyết định và rủi ro phát sinh.`,
  ];
  const proEN = [
    `${BRAND.name} provides market data and technical signals for informational/educational purposes only.`,
    `Nothing presented constitutes investment advice or a solicitation to buy/sell securities.`,
    `Data is sourced from third-party feeds and may be delayed, incomplete, or inaccurate.`,
    `Trading involves significant risk and may result in substantial losses, including total loss of capital.`,
    `You assume full responsibility for all trading decisions and outcomes.`,
  ];

  const title = DISCLAIMER_MODE === "pro" ? proTitle : simpleTitle;
  const bullets = DISCLAIMER_MODE === "pro" ? { vn: proVN, en: proEN } : { vn: simpleVN, en: simpleEN };
  return { title, bullets };
}

function renderUI(preset = {}) {
  const active = (path) => (preset.path === path ? "opacity:1" : "opacity:.65");
  const PRESET = {
    group: preset.group || "topGainers",
    cap: preset.cap || "all",
    limit: preset.limit || 50,
    minGap: preset.minGap ?? "",
    symbols: preset.symbols ?? "NVDA,TSLA,AAPL",
    platformMode: preset.mode || "daytrade",
  };
  const disc = disclaimerContent();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${BRAND.name} Scanner | ${BRAND.legal}</title>
<style>
:root { color-scheme: dark; }
body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b0d12; color:#e6e8ef;}
header { padding:16px 18px; border-bottom:1px solid rgba(255,255,255,.08); position:sticky; top:0; background:rgba(11,13,18,.92); backdrop-filter: blur(10px); z-index:20; }
.wrap { max-width:1400px; margin:0 auto; }

.brandRow{ display:flex; align-items:center; justify-content:space-between; gap:12px; }
.brandLeft{ display:flex; flex-direction:column; gap:4px; }
.brandTitle{ display:flex; align-items:center; gap:10px; }
.brandMark{ font-size:18px; }
.brandName{ font-weight:800; font-size:15px; letter-spacing:.3px; }
.brandSub{ font-size:12px; color:#a7adc2; }
.modePill{ font-size:12px; padding:6px 10px; border-radius:999px; background:#121622; border:1px solid rgba(255,255,255,.12); color:#c8cde0; white-space:nowrap; }

.panel { padding:14px 18px; border-bottom:1px solid rgba(255,255,255,.06); }
.row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
select, input, button { background:#121622; border:1px solid rgba(255,255,255,.12); color:#e6e8ef; border-radius:12px; padding:9px 10px; font-size:13px; outline:none; }
input { min-width:220px; }
#symbols { min-width:240px; flex:1; }
#minGap { min-width:200px; }
button { cursor:pointer; }
button:hover { border-color: rgba(255,255,255,.22); }
.hint { font-size:12px; color:#a7adc2; margin-top:10px; line-height:1.4; }
.badge { display:inline-flex; align-items:center; gap:8px; padding:6px 10px; border-radius:999px; background:#121622; border:1px solid rgba(255,255,255,.12); font-size:12px; color:#c8cde0; }
.grid { padding:14px 18px; }
.card { border:1px solid rgba(255,255,255,.10); border-radius:14px; overflow:hidden; }
.cardHead { padding:10px 12px; display:flex; align-items:center; justify-content:space-between; background:#121622; border-bottom:1px solid rgba(255,255,255,.08); }
.title { font-size:13px; font-weight:800; }
.meta { font-size:12px; color:#a7adc2; }
table { width:100%; border-collapse:collapse; }
th, td { padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.06); font-size:13px; }
th { text-align:left; color:#a7adc2; font-weight:700; position:sticky; top:0; background:#0b0d12; z-index:5; }
tr:hover td { background: rgba(255,255,255,.03); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.right { text-align:right; }
.err { white-space:pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size:12px; color:#ffb4b4; background:#1a0f12; border:1px solid rgba(255,128,128,.25); border-radius:12px; padding:10px 12px; margin-top:12px; display:none; }
.nav { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
.nav a { text-decoration:none; color:#c8cde0; background:#121622; border:1px solid rgba(255,255,255,.12); padding:8px 10px; border-radius:999px; font-size:12px; }
.nav a:hover { border-color: rgba(255,255,255,.22); }
.watermark{ position: fixed; bottom: 12px; right: 16px; font-size: 11px; color: rgba(230,232,239,.35); letter-spacing: .3px; pointer-events: none; user-select: none; z-index: 9999; }
.pill { display:inline-flex; align-items:center; gap:8px; padding:7px 10px; border-radius:999px; background:#121622; border:1px solid rgba(255,255,255,.12); font-size:12px; color:#c8cde0; }
.pill input[type="checkbox"]{ transform: translateY(1px); }
.symLink { color:#e6e8ef; text-decoration:none; border-bottom:1px dashed rgba(255,255,255,.25); cursor:pointer; }
.symLink:hover { border-bottom-color: rgba(255,255,255,.55); }

tr.haltRow td { background: rgba(255, 80, 80, .10) !important; }
tr.resumeFlash td { background: rgba(80, 255, 140, .12) !important; }

.modalBack { position:fixed; inset:0; background: rgba(0,0,0,.65); display:none; align-items:center; justify-content:center; z-index:50; }
.modal { width:min(1100px, 94vw); height:min(720px, 88vh); background:#0b0d12; border:1px solid rgba(255,255,255,.16); border-radius:16px; overflow:hidden; box-shadow: 0 18px 70px rgba(0,0,0,.55); }
.modalTop { display:flex; gap:10px; align-items:center; justify-content:space-between; padding:10px 12px; background:#121622; border-bottom:1px solid rgba(255,255,255,.10); }
.modalTitle { font-weight:800; font-size:13px; }
.modalTools { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.modalClose { cursor:pointer; border:1px solid rgba(255,255,255,.18); background:#121622; color:#e6e8ef; border-radius:10px; padding:8px 10px; }
.modalClose:hover { border-color: rgba(255,255,255,.28); }
.chartBox { width:100%; height: calc(100% - 52px); }

.discBack{ position:fixed; inset:0; background: rgba(0,0,0,.68); display:none; align-items:center; justify-content:center; z-index:80; }
.disc{ width:min(720px, 92vw); background:#0b0d12; border:1px solid rgba(255,255,255,.16); border-radius:16px; box-shadow: 0 18px 70px rgba(0,0,0,.60); overflow:hidden; }
.discTop{ padding:12px 14px; background:#121622; border-bottom:1px solid rgba(255,255,255,.10); display:flex; align-items:center; justify-content:space-between; gap:10px;}
.discTitle{ font-weight:900; font-size:13px; display:flex; gap:10px; align-items:center; }
.discBody{ padding:12px 14px; color:#cdd3ea; font-size:13px; line-height:1.45; }
.discBody ul{ margin:8px 0 0 18px; padding:0; }
.discBody li{ margin:6px 0; }
.discFoot{ padding:12px 14px; display:flex; align-items:center; justify-content:space-between; gap:10px; background:#0b0d12; border-top:1px solid rgba(255,255,255,.08); }
.discBtn{ cursor:pointer; border:1px solid rgba(255,255,255,.18); background:#121622; color:#e6e8ef; border-radius:10px; padding:9px 10px; font-size:13px; }
.discBtn:hover{ border-color: rgba(255,255,255,.28); }
.discNote{ font-size:12px; color:#a7adc2; display:flex; gap:8px; align-items:center; }
.fadeOut{ animation: fadeOut .28s ease forwards; }
@keyframes fadeOut { to { opacity: 0; transform: translateY(2px); } }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div class="brandRow">
      <div class="brandLeft">
        <div class="brandTitle">
          <span class="brandMark">${BRAND.mark}</span>
          <span class="brandName">${BRAND.legal}</span>
        </div>
        <div class="brandSub">${BRAND.subtitle} • Day Trade Core & Pro Modules • Vol/Float • HALT/RESUME • SMA/EMA/VWAP</div>
      </div>
      <div class="modePill">Mode: <b id="modePill">${PRESET.platformMode}</b></div>
    </div>

    <div class="nav">
      <a href="/ui" style="${active("/ui")}">Dashboard</a>
      <a href="/ui/top-movers" style="${active("/ui/top-movers")}">Top Movers</a>
      <a href="/ui/gainers" style="${active("/ui/gainers")}">Gainers</a>
      <a href="/ui/losers" style="${active("/ui/losers")}">Losers</a>
      <a href="/ui/gappers" style="${active("/ui/gappers")}">Gappers</a>
      <a href="/ui/smallcap" style="${active("/ui/smallcap")}">Small Cap</a>
      <a href="/ui/midcap" style="${active("/ui/midcap")}">Mid Cap</a>
      <a href="/ui/bigcap" style="${active("/ui/bigcap")}">Big Cap</a>
      <a href="/ui/premarket" style="${active("/ui/premarket")}">Pre-Market</a>
      <a href="/ui/aftermarket" style="${active("/ui/aftermarket")}">After-Hours</a>
      <a href="/ui/snapshot-all" style="${active("/ui/snapshot-all")}">Snapshot-All</a>
      <a href="/help" style="opacity:.85">Help</a>
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
        <option value="topMovers">Top Movers (Standalone)</option>
        <option value="premarket">Pre-Market (Snapshot-All)</option>
        <option value="aftermarket">After-Hours (Snapshot-All)</option>
        <option value="snapshotAll">Snapshot-All (All tickers)</option>
      </select>

      <select id="cap">
        <option value="all">Cap: All</option>
        <option value="small">Cap: Small (&lt;2B)</option>
        <option value="mid">Cap: Mid (2B–10B)</option>
        <option value="big">Cap: Big (&gt;10B)</option>
      </select>

      <select id="limit">
        <option>20</option><option>30</option><option>50</option><option selected>80</option><option>100</option><option>150</option>
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

    <div class="row" style="margin-top:10px;">
      <input id="fMinPrice" placeholder="Min Price" style="min-width:160px;" />
      <input id="fMaxPrice" placeholder="Max Price" style="min-width:160px;" />
      <input id="fMinVol" placeholder="Min Vol" style="min-width:190px;" />
      <input id="fMinRVOL" placeholder="Min RVOL" style="min-width:170px;" />
      <input id="fMinCapB" placeholder="Min Cap(B)" style="min-width:190px;" />
      <input id="fMaxCapB" placeholder="Max Cap(B)" style="min-width:190px;" />
      <input id="fMinFloatM" placeholder="Min Float(M)" style="min-width:200px;" />
      <input id="fMaxFloatM" placeholder="Max Float(M)" style="min-width:200px;" />
      <button id="presetMomentum">Preset: Momentum</button>
      <button id="presetPremarket">Preset: Premarket</button>
      <button id="presetHalt">Preset: Halt Play</button>
    </div>

    <div class="hint">
      ⛔ HALT row = red • 🟢 RESUME = green flash. Vol/Float icons show only when ≥ 1.5x.
      <br/>Indicators: SMA26 / EMA9 / EMA34 / VWAP are enabled by mode (Daytrade/Pro toggles via ENV).
      <br/>Click ticker: modal chart (default) or enable "Open new window" (or Ctrl/Cmd+Click).
    </div>

    <div class="err" id="errBox"></div>
  </div>
</div>

<div class="grid">
  <div class="wrap" id="out"></div>
</div>

<div class="watermark">${BRAND.watermark}</div>

<!-- Chart Modal -->
<div class="modalBack" id="modalBack" aria-hidden="true">
  <div class="modal" role="dialog" aria-modal="true">
    <div class="modalTop">
      <div class="modalTitle" id="modalTitle">${BRAND.mark} ${BRAND.name} Chart</div>
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

<!-- Disclaimer Popup -->
<div class="discBack" id="discBack" aria-hidden="true">
  <div class="disc" role="dialog" aria-modal="true">
    <div class="discTop">
      <div class="discTitle">${BRAND.mark} ${disc.title}</div>
      <button class="discBtn" id="discCloseBtn">I Understand</button>
    </div>
    <div class="discBody">
      <div style="font-weight:800; margin-bottom:6px;">${BRAND.legal}</div>
      <div style="color:#a7adc2; font-size:12px;">${BRAND.subtitle} • Data may be delayed (15s–60s). HALT/RESUME best-effort.</div>
      <div style="margin-top:10px; font-weight:800;">VI</div>
      <ul>${disc.bullets.vn.map((x) => `<li>${x}</li>`).join("")}</ul>
      <div style="margin-top:10px; font-weight:800;">EN</div>
      <ul>${disc.bullets.en.map((x) => `<li>${x}</li>`).join("")}</ul>
    </div>
    <div class="discFoot">
      <label class="discNote"><input id="discDontShow" type="checkbox" /> Don’t show again (${DISCLAIMER_TTL_DAYS} days)</label>
      <div class="discNote">Auto close in ${Math.round(DISCLAIMER_AUTO_CLOSE_MS / 1000)}s</div>
    </div>
  </div>
</div>

<script src="https://s3.tradingview.com/tv.js"></script>

<script>
const PRESET = ${JSON.stringify(PRESET)};
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

// Resume flash
const resumeFlash = new Map();
function nowMs(){ return Date.now(); }
function shouldFlash(sym){
  const exp = resumeFlash.get(sym);
  if (!exp) return false;
  if (nowMs() > exp){ resumeFlash.delete(sym); return false; }
  return true;
}

// Smart filter params
function valOrEmpty(id){ return String(byId(id)?.value ?? "").trim(); }
function addParam(u, k, v){
  if (!v) return u;
  return u + (u.includes("?") ? "&" : "?") + encodeURIComponent(k) + "=" + encodeURIComponent(v);
}
function applyFilterParams(url){
  url = addParam(url, "minPrice", valOrEmpty("fMinPrice"));
  url = addParam(url, "maxPrice", valOrEmpty("fMaxPrice"));
  url = addParam(url, "minVol", valOrEmpty("fMinVol"));
  url = addParam(url, "minRVOL", valOrEmpty("fMinRVOL"));
  url = addParam(url, "minCapB", valOrEmpty("fMinCapB"));
  url = addParam(url, "maxCapB", valOrEmpty("fMaxCapB"));
  url = addParam(url, "minFloatM", valOrEmpty("fMinFloatM"));
  url = addParam(url, "maxFloatM", valOrEmpty("fMaxFloatM"));
  return url;
}

// Presets
function presetMomentum(){
  byId("fMinPrice").value="1"; byId("fMaxPrice").value="";
  byId("fMinVol").value="1000000"; byId("fMinRVOL").value="2";
  byId("fMinCapB").value=""; byId("fMaxCapB").value="";
  byId("fMinFloatM").value=""; byId("fMaxFloatM").value="";
}
function presetPremarket(){
  byId("fMinPrice").value="0.5"; byId("fMaxPrice").value="20";
  byId("fMinVol").value="200000"; byId("fMinRVOL").value="1.5";
  byId("fMinCapB").value=""; byId("fMaxCapB").value="10";
  byId("fMinFloatM").value=""; byId("fMaxFloatM").value="200";
}
function presetHalt(){
  byId("fMinPrice").value=""; byId("fMaxPrice").value="";
  byId("fMinVol").value="500000"; byId("fMinRVOL").value="2";
  byId("fMinCapB").value=""; byId("fMaxCapB").value="";
  byId("fMinFloatM").value=""; byId("fMaxFloatM").value="";
}
byId("presetMomentum").addEventListener("click", ()=>{ presetMomentum(); run(); });
byId("presetPremarket").addEventListener("click", ()=>{ presetPremarket(); run(); });
byId("presetHalt").addEventListener("click", ()=>{ presetHalt(); run(); });

// Alerts
const alerted = new Set();
function toNumOrDefault(val, def){ const v=Number(String(val??"").trim()); return Number.isFinite(v)?v:def; }
function toBool01(val, def){
  const s=String(val??"").trim();
  if(s==="") return def;
  if(s==="1"||s.toLowerCase()==="true"||s.toLowerCase()==="yes") return true;
  if(s==="0"||s.toLowerCase()==="false"||s.toLowerCase()==="no") return false;
  return def;
}
function beep(){
  try{
    const AudioCtx=window.AudioContext||window.webkitAudioContext;
    if(!AudioCtx) return;
    const ctx=new AudioCtx();
    const o=ctx.createOscillator(); const g=ctx.createGain();
    o.type="sine"; o.frequency.value=880; g.gain.value=0.05;
    o.connect(g); g.connect(ctx.destination);
    o.start(); setTimeout(()=>{o.stop(); ctx.close();},160);
  }catch(e){}
}
function pushNotification(title, body){
  if(!("Notification" in window)) return;
  if(Notification.permission!=="granted") return;
  try{ new Notification(title,{body}); }catch(e){}
}
function getAlertCfg(){
  return {
    alertsOn: byId("alertsOn").checked,
    soundOn: byId("soundOn").checked,
    desktopOn: byId("desktopOn").checked,
    scoreTh: toNumOrDefault(byId("alertScore").value,4),
    gapTh: toNumOrDefault(byId("alertGap").value,20),
    priceTh: toNumOrDefault(byId("alertPrice").value,20),
    aboveVWAPOn: toBool01(byId("alertAboveVWAP").value,true),
    volSpikeOn: toBool01(byId("alertVolSpike").value,true),
  };
}
function shouldAlertRow(r,cfg){
  if(!cfg.alertsOn) return false;
  if(!r||!r.symbol) return false;
  if(r.halted) return false;
  if(alerted.has(r.symbol)) return false;
  const score=Number(r.demandScore??0);
  const gap=Number(r.gapPct??0);
  const pc=Number(r.pricePct??0);
  const ext=Number(r.extPct??0);
  const above=Boolean(r.aboveVWAP_5m);
  const spike=Boolean(r.volSpike_5m);
  const classic=(score>=cfg.scoreTh)||(gap>=cfg.gapTh)||(pc>=cfg.priceTh)||(Math.abs(ext)>=cfg.priceTh);
  const vwapHit=(cfg.aboveVWAPOn&&above)||(cfg.volSpikeOn&&spike);
  return classic||vwapHit;
}
function fireAlert(r,cfg){
  alerted.add(r.symbol);
  const parts=[];
  if(r.pricePct!=null) parts.push("Price%: "+r.pricePct+"%");
  if(r.extPct!=null) parts.push("Ext%: "+r.extPct+"%");
  if(r.gapPct!=null) parts.push("Gap%: "+r.gapPct+"%");
  if(r.volFloatX!=null && r.volFloatX>=1.5) parts.push("Vol/Float: "+(r.volFloatIcon||"")+" "+r.volFloatX+"x");
  if(r.rvol_5m!=null) parts.push("RVOL(5m): "+r.rvol_5m);
  if(r.aboveVWAP_5m) parts.push("Price>VWAP ✅");
  if(r.volSpike_5m) parts.push("VolSpike 🔊");
  const body=parts.join(" | ")||"Signal";
  if(cfg.soundOn) beep();
  if(cfg.desktopOn) pushNotification("${BRAND.mark} ${BRAND.name} | "+(r.haltIcon||"")+(r.signalIcon||"")+" "+r.symbol, body);
}
function runAlerts(data){
  const cfg=getAlertCfg();
  const rows=Array.isArray(data.results)?data.results:[];
  for(const r of rows){ if(shouldAlertRow(r,cfg)) fireAlert(r,cfg); }
}
async function enableNotifications(){
  if(!("Notification" in window)){ alert("Notifications not supported."); return; }
  const p=await Notification.requestPermission();
  if(p==="granted"){ try{ new Notification("${BRAND.mark} ${BRAND.name} Alerts enabled",{body:"Desktop notifications ON."}); }catch(e){} }
  else alert("Permission not granted.");
}

// TradingView chart
const modalBack=byId("modalBack");
const modalTitle=byId("modalTitle");
const chartBox=byId("chartBox");
const exSel=byId("exSel");
const tfSel=byId("tfSel");
let currentSymbol=null;

function openModal(){ modalBack.style.display="flex"; modalBack.setAttribute("aria-hidden","false"); }
function closeModal(){ modalBack.style.display="none"; modalBack.setAttribute("aria-hidden","true"); chartBox.innerHTML=""; currentSymbol=null; }
function buildTvSymbol(sym){ return (exSel.value||"NASDAQ")+":"+sym; }
function tvUrlFor(sym){
  const tvSymbol=buildTvSymbol(sym); const interval=tfSel.value||"5";
  return "https://www.tradingview.com/chart/?symbol="+encodeURIComponent(tvSymbol)+"&interval="+encodeURIComponent(interval);
}
function renderChart(sym){
  if(!window.TradingView||!window.TradingView.widget){ alert("TradingView failed to load."); return; }
  chartBox.innerHTML='<div id="tv_chart" style="width:100%;height:100%;"></div>';
  new TradingView.widget({
    autosize:true,
    symbol:buildTvSymbol(sym),
    interval:tfSel.value||"5",
    timezone:"America/New_York",
    theme:"dark",
    style:"1",
    locale:"en",
    enable_publishing:false,
    allow_symbol_change:true,
    container_id:"tv_chart"
  });
}
function openChart(sym){
  currentSymbol=sym;
  modalTitle.textContent="${BRAND.mark} ${BRAND.name} Chart — "+sym;
  openModal(); renderChart(sym);
}
window.handleTickerClick=function(ev,sym){
  const forceNew=byId("openNewWin")?.checked;
  const modifier=ev&&(ev.ctrlKey||ev.metaKey);
  if(forceNew||modifier){
    const url=tvUrlFor(sym);
    const newTab=byId("openNewTab")?.checked!==false;
    if(newTab) window.open(url,"_blank","noopener,noreferrer"); else window.location.href=url;
    return;
  }
  openChart(sym);
};
byId("closeBtn").addEventListener("click", closeModal);
modalBack.addEventListener("click",(e)=>{ if(e.target===modalBack) closeModal(); });
document.addEventListener("keydown",(e)=>{ if(e.key==="Escape") closeModal(); });
exSel.addEventListener("change",()=>{ if(currentSymbol) renderChart(currentSymbol); });
tfSel.addEventListener("change",()=>{ if(currentSymbol) renderChart(currentSymbol); });

// Render table
function renderList(data){
  const rows=Array.isArray(data.results)?data.results:[];
  for(const r of rows){
    if(!r||!r.symbol) continue;
    if(r.halted===false && r.lastEvent==="RESUME") resumeFlash.set(String(r.symbol), nowMs()+8000);
  }
  const titleRight = data.mode==="symbols"
    ? ("Symbols • "+rows.length+" rows")
    : ((data.group||data.session||"scan")+" • cap="+(data.cap||"all")+" • "+rows.length+" rows");

  out.innerHTML = \`
    <div class="card">
      <div class="cardHead">
        <div class="title">${BRAND.mark} \${data.mode==="symbols"?"Scan Symbols":"Scan Group"} — ${BRAND.name}</div>
        <div class="meta">\${titleRight}</div>
      </div>
      <div style="overflow:auto;">
      <table>
        <thead><tr>
          <th>Icon</th><th>PA</th><th>Symbol</th>
          <th class="right">Price</th><th class="right">Price%</th><th class="right">Ext%</th><th class="right">Gap%</th>
          <th class="right">Vol</th><th class="right">Vol/Float</th><th class="right">RVOL</th>
          <th class="right">Float(M)</th><th>FloatCat</th><th class="right">MCap(B)</th><th>Cap</th>
          <th class="right">Score</th><th class="right">SMA26</th><th class="right">EMA9</th><th class="right">EMA34</th><th class="right">VWAP</th>
        </tr></thead>
        <tbody>
          \${rows.map(r=>{
            const sym=String(r.symbol||"");
            const safeSym=sym.replace(/'/g,"");
            const isHalt=Boolean(r.halted);
            const flash=shouldFlash(sym);
            const rowClass=isHalt?"haltRow":(flash?"resumeFlash":"");
            const tip=isHalt?("HALT – "+(r.haltReason||"LULD")):(flash?("RESUME – "+(r.haltReason||"LULD")):"");
            const vf=(r.volFloatX!=null && Number(r.volFloatX)>=1.5) ? ((r.volFloatIcon||"")+" "+fmtNum(r.volFloatX,2)+"x") : "-";
            return \`
              <tr class="\${rowClass}" title="\${tip}">
                <td>\${(r.haltIcon||"")+(r.signalIcon||"")}</td>
                <td>\${r.paIcon||""}</td>
                <td class="mono"><a class="symLink" href="javascript:void(0)" onclick="handleTickerClick(event,'\${safeSym}')">\${sym}</a></td>
                <td class="right mono">\${fmtNum(r.price)}</td>
                <td class="right mono">\${fmtNum(r.pricePct)}%</td>
                <td class="right mono">\${fmtNum(r.extPct)}%</td>
                <td class="right mono">\${fmtNum(r.gapPct)}%</td>
                <td class="right mono">\${fmtInt(r.volume)}</td>
                <td class="right mono">\${vf}</td>
                <td class="right mono">\${fmtNum(r.rvol_5m,2)}</td>
                <td class="right mono">\${fmtNum(r.floatM)}</td>
                <td>\${r.floatCat||"-"}</td>
                <td class="right mono">\${fmtNum(r.marketCapB)}</td>
                <td>\${r.cap||"-"}</td>
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
    </div>\`;
}

// Auto refresh
let autoTimer=null, countdownTimer=null, countdown=0;
function stopAuto(){
  if(autoTimer) clearInterval(autoTimer);
  if(countdownTimer) clearInterval(countdownTimer);
  autoTimer=null; countdownTimer=null; countdown=0;
  countdownBadge.textContent="-";
  byId("autoOn").checked=false;
}
function startAuto(seconds){
  stopAuto();
  byId("autoOn").checked=true;
  countdown=seconds;
  countdownBadge.textContent="Next refresh in "+countdown+"s";
  countdownTimer=setInterval(()=>{
    countdown-=1;
    if(countdown<=0) countdown=seconds;
    countdownBadge.textContent="Next refresh in "+countdown+"s";
  },1000);
  autoTimer=setInterval(()=>{ run(); }, seconds*1000);
}
function applyAuto(){
  const on=byId("autoOn").checked;
  const sec=toNumOrDefault(byId("autoSec").value,30);
  const safeSec=Math.max(5,Math.min(3600,sec));
  if(!on){ stopAuto(); return; }
  startAuto(safeSec);
}

// Run
async function run(){
  clearError(); out.innerHTML=""; setStatus("Loading...");
  const uiMode=byId("mode").value;
  let url="";

  if(uiMode==="symbols"){
    const symbols=byId("symbols").value.trim()||"NVDA,TSLA,AAPL";
    url="/scan?symbols="+encodeURIComponent(symbols);
  } else {
    const group=byId("group").value;
    const cap=byId("cap").value;
    const limit=byId("limit").value;
    const minGap=byId("minGap").value.trim();

    if(group==="topMovers"){
      url="/top-movers?direction=all&limit="+encodeURIComponent(limit)+"&cap="+encodeURIComponent(cap)+"&sort=abs&indicators=1";
    } else if(group==="premarket"){
      url="/premarket?cap="+encodeURIComponent(cap)+"&limit="+encodeURIComponent(limit);
    } else if(group==="aftermarket"){
      url="/aftermarket?cap="+encodeURIComponent(cap)+"&limit="+encodeURIComponent(limit);
    } else if(group==="snapshotAll"){
      url="/snapshot-all?cap="+encodeURIComponent(cap)+"&limit="+encodeURIComponent(limit);
    } else {
      url="/list?group="+encodeURIComponent(group)+"&cap="+encodeURIComponent(cap)+"&limit="+encodeURIComponent(limit);
      if(minGap) url+="&minGap="+encodeURIComponent(minGap);
    }
  }

  url=applyFilterParams(url);

  try{
    const r=await fetch(url);
    const data=await r.json();
    if(!data.ok){ setStatus("Error"); showError(data); return; }
    setStatus("OK ("+data.results.length+" rows)");
    renderList(data);
    runAlerts(data);
    if(data.snapshotErrors && data.snapshotErrors.length) showError({snapshotErrors:data.snapshotErrors});
    if(data.aggsErrors && data.aggsErrors.length) showError({aggsErrors:data.aggsErrors});
  }catch(e){
    setStatus("Error"); showError(String(e?.message||e));
  }
}

function setPreset(){
  byId("group").value = PRESET.group;
  byId("cap").value = PRESET.cap;
  byId("limit").value = String(PRESET.limit);
  byId("minGap").value = PRESET.minGap ?? "";
  byId("symbols").value = PRESET.symbols ?? "NVDA,TSLA,AAPL";

  byId("alertScore").value="4";
  byId("alertGap").value="20";
  byId("alertPrice").value="20";
  byId("alertAboveVWAP").value="1";
  byId("alertVolSpike").value="1";

  byId("autoSec").value="30";
  countdownBadge.textContent="-";
  byId("modePill").textContent = PRESET.platformMode || "daytrade";
}

byId("runBtn").addEventListener("click", run);
byId("notifyBtn").addEventListener("click", enableNotifications);
byId("clearAlertsBtn").addEventListener("click", ()=>{ alerted.clear(); alert("Alert memory cleared."); });
byId("applyAutoBtn").addEventListener("click", applyAuto);
byId("stopAutoBtn").addEventListener("click", stopAuto);
byId("mode").addEventListener("change", ()=>{ stopAuto(); });

setPreset();
run();

// Disclaimer popup
const discBack=byId("discBack");
const discCloseBtn=byId("discCloseBtn");
const discDontShow=byId("discDontShow");
const DISC_KEY="algtp_disclaimer_until";

function showDisclaimer(){
  try{
    const until=Number(localStorage.getItem(DISC_KEY)||"0");
    if(Number.isFinite(until)&&until>Date.now()) return;
  }catch(e){}

  discBack.style.display="flex";
  discBack.setAttribute("aria-hidden","false");
  setTimeout(()=>{ closeDisclaimer(); }, ${DISCLAIMER_AUTO_CLOSE_MS});
}
function closeDisclaimer(){
  if(!discBack||discBack.style.display==="none") return;
  try{
    if(discDontShow && discDontShow.checked){
      const until=Date.now()+(${DISCLAIMER_TTL_DAYS}*24*60*60*1000);
      localStorage.setItem(DISC_KEY,String(until));
    }
  }catch(e){}
  const disc=discBack.querySelector(".disc");
  if(disc){
    disc.classList.add("fadeOut");
    setTimeout(()=>{
      discBack.style.display="none";
      discBack.setAttribute("aria-hidden","true");
      disc.classList.remove("fadeOut");
    },280);
  }else{
    discBack.style.display="none";
    discBack.setAttribute("aria-hidden","true");
  }
}
discCloseBtn.addEventListener("click", closeDisclaimer);
discBack.addEventListener("click",(e)=>{ if(e.target===discBack) closeDisclaimer(); });
showDisclaimer();
</script>
</body>
</html>`;
}

// ============================================================================
// SECTION 17 — UI Routes (includes /ui/top-movers)
// Debug tag: SECTION17_UI_ROUTES
// ============================================================================
app.get("/ui", (req, res) => res.type("html").send(renderUI({ path: "/ui", group: "topGainers", cap: "all", limit: 50, mode: "daytrade" })));
app.get("/ui/top-movers", (req, res) => res.type("html").send(renderUI({ path: "/ui/top-movers", group: "topMovers", cap: "all", limit: 80, mode: "pro" })));
app.get("/ui/gainers", (req, res) => res.type("html").send(renderUI({ path: "/ui/gainers", group: "topGainers", cap: "all", limit: 50, mode: "daytrade" })));
app.get("/ui/losers", (req, res) => res.type("html").send(renderUI({ path: "/ui/losers", group: "topLosers", cap: "all", limit: 50, mode: "daytrade" })));
app.get("/ui/gappers", (req, res) => res.type("html").send(renderUI({ path: "/ui/gappers", group: "topGappers", cap: "all", limit: 80, minGap: 10, mode: "daytrade" })));
app.get("/ui/smallcap", (req, res) => res.type("html").send(renderUI({ path: "/ui/smallcap", group: "topGainers", cap: "small", limit: 80, mode: "daytrade" })));
app.get("/ui/midcap", (req, res) => res.type("html").send(renderUI({ path: "/ui/midcap", group: "topGainers", cap: "mid", limit: 80, mode: "daytrade" })));
app.get("/ui/bigcap", (req, res) => res.type("html").send(renderUI({ path: "/ui/bigcap", group: "topGainers", cap: "big", limit: 80, mode: "daytrade" })));
app.get("/ui/premarket", (req, res) => res.type("html").send(renderUI({ path: "/ui/premarket", group: "premarket", cap: "all", limit: 80, mode: "pro" })));
app.get("/ui/aftermarket", (req, res) => res.type("html").send(renderUI({ path: "/ui/aftermarket", group: "aftermarket", cap: "all", limit: 80, mode: "pro" })));
app.get("/ui/snapshot-all", (req, res) => res.type("html").send(renderUI({ path: "/ui/snapshot-all", group: "snapshotAll", cap: "all", limit: 100, mode: "pro" })));

// ============================================================================
// SECTION 18 — Base API Routes (/ /api)
// Debug tag: SECTION18_API_HEALTH
// ============================================================================
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: `${BRAND.legal} running ✅`,
    ui: "/ui",
    endpoints: ["/scan", "/list", "/premarket", "/aftermarket", "/snapshot-all", "/halts", "/top-movers", "/help"],
  });
});
app.get("/api", (req, res) => {
  res.json({
    ok: true,
    config: {
      port: PORT,
      debug: DEBUG,
      includeOtc: INCLUDE_OTC,
      snapConcurrency: SNAP_CONCURRENCY,
      enableSnapshotAll: ENABLE_SNAPSHOT_ALL,
      enable5mIndicatorsDaytrade: ENABLE_5M_INDICATORS_DAYTRADE,
      enable5mIndicatorsPro: ENABLE_5M_INDICATORS_PRO,
      enableHaltWs: ENABLE_HALT_WS,
      disclaimerMode: DISCLAIMER_MODE,
      disclaimerTtlDays: DISCLAIMER_TTL_DAYS,
      disclaimerAutoCloseMs: DISCLAIMER_AUTO_CLOSE_MS,
    },
  });
});

// ============================================================================
// SECTION 19 — /scan (symbols)
// Debug tag: SECTION19_SCAN
// ============================================================================
app.get("/scan", async (req, res) => {
  try {
    const mode = String(req.query.mode || "daytrade").toLowerCase() === "pro" ? "pro" : "daytrade";
    const needAggs = shouldEnableIndicators(mode);
    const miss = envMissingFor({ needAggs, needSnapshotAll: false });
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const symbols = parseSymbols(req.query.symbols || "NVDA,TSLA,AAPL").slice(0, 100);
    const snaps = await mapPool(symbols, SNAP_CONCURRENCY, async (t) => ({ ticker: t, ...(await fetchTickerSnapshot(t)) }));

    const good = snaps.filter((x) => x.ok);
    const bad = snaps.filter((x) => !x.ok);

    let rows = good.map((x) => normalizeSnapshotAuto(x.ticker, x.data));
    const aggsErrors = [];
    rows = await attachIndicatorsIfEnabled(rows, mode, aggsErrors);
    rows = applySmartFilters(rows, req.query);
    rows = finalizeRows(rows, mode);

    rows.sort((a, b) => (b.demandScore ?? 0) - (a.demandScore ?? 0));
    res.json({ ok: true, mode: "symbols", platformMode: mode, results: rows, snapshotErrors: DEBUG ? bad.slice(0, 10) : undefined, aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Scan failed", detail: String(e?.message || e) });
  }
});

// ============================================================================
// SECTION 20 — /list + /premarket + /aftermarket + /snapshot-all
// Debug tag: SECTION20_GROUP_ENDPOINTS
// ============================================================================
app.get("/list", async (req, res) => {
  try {
    const group = String(req.query.group || "topGainers").trim();
    const cap = String(req.query.cap || "all").trim().toLowerCase();
    const limit = clamp(Number(req.query.limit || 50), 5, 200);
    const minGap = req.query.minGap;
    const mode = String(req.query.mode || "daytrade").toLowerCase() === "pro" ? "pro" : "daytrade";

    const needAggs = shouldEnableIndicators(mode);
    const miss = envMissingFor({ needAggs, needSnapshotAll: false });
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const out = await buildRowsFromMovers({ group, cap, limit, minGap, mode, query: req.query });
    res.status(out.status).json(out.body);
  } catch (e) {
    res.status(500).json({ ok: false, error: "List failed", detail: String(e?.message || e) });
  }
});

app.get("/snapshot-all", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = req.query.limit;
  const out = await buildRowsFromSnapshotAll({ cap, limit, session: null, mode: "pro", query: req.query });
  res.status(out.status).json(out.body);
});
app.get("/premarket", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = req.query.limit;
  const out = await buildRowsFromSnapshotAll({ cap, limit, session: "pre", mode: "pro", query: req.query });
  res.status(out.status).json(out.body);
});
app.get("/aftermarket", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = req.query.limit;
  const out = await buildRowsFromSnapshotAll({ cap, limit, session: "after", mode: "pro", query: req.query });
  res.status(out.status).json(out.body);
});

// ============================================================================
// SECTION 21 — /top-movers (Standalone)
// Debug tag: SECTION21_TOP_MOVERS
// ============================================================================
function topMoversSort(rows, sort) {
  const s = String(sort || "abs").toLowerCase();
  if (s === "gap") rows.sort((a, b) => Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0));
  else if (s === "score") rows.sort((a, b) => (b.demandScore ?? 0) - (a.demandScore ?? 0));
  else if (s === "price") rows.sort((a, b) => (b.pricePct ?? 0) - (a.pricePct ?? 0));
  else rows.sort((a, b) => Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0));
}
app.get("/top-movers", async (req, res) => {
  try {
    const direction = String(req.query.direction || "all").toLowerCase();
    const limit = clamp(Number(req.query.limit || 80), 5, 200);
    const cap = String(req.query.cap || "all").toLowerCase();
    const sort = String(req.query.sort || "abs").toLowerCase();
    const indicatorsOn =
      String(req.query.indicators ?? "").trim() === ""
        ? ENABLE_5M_INDICATORS_PRO
        : (String(req.query.indicators).toLowerCase() === "true" || String(req.query.indicators) === "1");

    const miss = envMissingFor({ needAggs: indicatorsOn, needSnapshotAll: false });
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    let moverTickers = [];
    if (direction === "gainers" || direction === "losers") {
      const mv = await fetchMovers(direction);
      if (!mv.ok) return res.status(500).json({ ok: false, error: "Movers failed", moverDebug: mv });
      moverTickers = mv.rows.map(x => String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase()).filter(Boolean).slice(0, limit);
    } else {
      const [g, l] = await Promise.all([fetchMovers("gainers"), fetchMovers("losers")]);
      if (!g.ok || !l.ok) return res.status(500).json({ ok: false, error: "Movers failed", moverDebug: {gainers:g, losers:l} });
      moverTickers = Array.from(new Set([
        ...g.rows.slice(0, limit).map(x => String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase()),
        ...l.rows.slice(0, limit).map(x => String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase())
      ].filter(Boolean)));
    }

    const snaps = await mapPool(moverTickers, SNAP_CONCURRENCY, async (t) => ({ ticker: t, ...(await fetchTickerSnapshot(t)) }));
    const good = snaps.filter((x) => x.ok);
    const bad = snaps.filter((x) => !x.ok);

    let rows = good.map((x) => normalizeSnapshotAuto(x.ticker, x.data));
    if (cap !== "all") rows = rows.filter(r => r.cap === cap);

    const aggsErrors = [];
    if (indicatorsOn) rows = await attachIndicatorsIfEnabled(rows, "pro", aggsErrors);
    rows = rows.map(attachVolFloat).map(r => ({ ...r, demandScore: demandScore(r), signalIcon: signalIcon(demandScore(r)), paIcon: r.paIcon || "" }));
    topMoversSort(rows, sort);
    rows = rows.slice(0, limit);

    res.json({ ok: true, module: "top-movers", direction, cap, sort, limit, indicatorsOn, results: rows, snapshotErrors: DEBUG ? bad.slice(0, 10) : undefined, aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Top movers failed", detail: String(e?.message || e) });
  }
});

// ============================================================================
// SECTION 22 — Help + Listen (ONLY ONE LISTEN)
// Debug tag: SECTION22_LISTEN
// ============================================================================
app.get("/help", (req, res) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${BRAND.name} Help | ${BRAND.legal}</title>
  <style>
    :root{ color-scheme: dark; }
    body{ margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b0d12; color:#e6e8ef; }
    .wrap{ max-width:980px; margin:0 auto; padding:18px; }
    .card{ border:1px solid rgba(255,255,255,.10); border-radius:14px; padding:14px 16px; background:#0b0d12; }
    h1{ margin:0 0 8px 0; font-size:18px; }
    h2{ margin:18px 0 8px 0; font-size:14px; color:#cfd5ea; }
    p,li{ color:#c1c7de; line-height:1.5; font-size:13px; }
    code{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; background:#121622; padding:2px 6px; border-radius:8px; border:1px solid rgba(255,255,255,.10); }
    a{ color:#c8cde0; }
  </style></head><body>
  <div class="wrap"><div class="card">
    <h1>${BRAND.mark} ${BRAND.legal}</h1>
    <p>Open <a href="/ui">/ui</a> for the platform. Top Movers tab is also available.</p>
    <h2>Snapshot-All</h2>
    <ul><li>Enable: <code>ENABLE_SNAPSHOT_ALL=true</code></li></ul>
    <h2>HALT WS</h2>
    <ul><li>Install: <code>npm i ws</code></li></ul>
  </div></div></body></html>`;
  res.type("html").send(html);
});

startHaltWebSocket();

app.listen(PORT, () => {
  console.log(`✅ ${BRAND.legal} running http://localhost:${PORT}`);
  console.log(`🚀 UI: http://localhost:${PORT}/ui`);
  console.log(`🧭 Top Movers UI: http://localhost:${PORT}/ui/top-movers`);
  console.log(`🧭 Top Movers API: http://localhost:${PORT}/top-movers?direction=all&limit=80&sort=abs&indicators=1`);
  console.log(`⛔ HALTS: http://localhost:${PORT}/halts`);
  console.log(`📘 Help: http://localhost:${PORT}/help`);
  if (!ENABLE_SNAPSHOT_ALL) console.log(`⚠️ Snapshot-All is OFF (ENABLE_SNAPSHOT_ALL=false).`);
});
