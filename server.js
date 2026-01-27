// ============================================================================
// 🔥 ALGTP™ — Massive Scanner (REST + WS HALT + WS AM fallback + Mini Chart Hover)
// Single-file Node.js (ESM)
// ----------------------------------------------------------------------------
// UI:  /ui   (Dashboard: Symbols + Max Stepper + Roller + Box matrix)
// API:
//   /list
//   /scan
//   /snapshot-all
//   /premarket
//   /aftermarket
//   /movers-premarket        (Massive movers list -> filter by session -> rank by Gap% + Float Turnover %)
//   /movers-afterhours       (Massive movers list -> filter by session -> rank by Gap% + Float Turnover %)
//   /most-active
//   /unusual-volume
//   /most-volatile
//   /most-lately
//   /halts
//   /api
// Extra:
//   /mini-chart?symbol=AAPL&tf=1   (hover mini chart)
// ----------------------------------------------------------------------------
// Data priority (most important parts):
// - Gap% (Regular Trading Hours gap) is computed from Polygon daily aggregates:
//     GapPercent = ((RegularTradingHoursOpen - PreviousClose) / PreviousClose) * 100
// - Float is enriched from Financial Modeling Prep "shares-float" endpoint (best-effort).
// - Float Turnover Percent is computed as:
//     FloatTurnoverPercent = (Volume / FloatShares) * 100
// - Movers Premarket / After-hours use Massive Movers list as the fastest "fragment":
//     1) Massive movers list (fast ticker list)
//     2) Enrich with Massive ticker snapshot (price/volume/basic fields)
//     3) Overwrite Gap% using Polygon daily aggregates (Regular Trading Hours open / previous close)
//     4) Enrich Float using Financial Modeling Prep shares-float
//     5) Rank: highest absolute Gap% first, then highest Float Turnover Percent, then highest Volume
// ============================================================================

import "dotenv/config";
import express from "express";
import axios from "axios";
import WebSocket from "ws";

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
// SECTION 01 — ENV / CONFIG
// ============================================================================
const PORT = Number(process.env.PORT || 3000);
const DEBUG = String(process.env.DEBUG || "true").toLowerCase() === "true";

// Massive REST
const MASSIVE_API_KEY = String(process.env.MASSIVE_API_KEY || "").trim();
const MASSIVE_AUTH_TYPE = String(process.env.MASSIVE_AUTH_TYPE || "query").trim(); // query | xapi | bearer
const MASSIVE_QUERY_KEYNAME = String(process.env.MASSIVE_QUERY_KEYNAME || "apiKey").trim();
const MASSIVE_MOVER_URL = String(process.env.MASSIVE_MOVER_URL || "https://api.massive.com/v2/snapshot/locale/us/markets/stocks").trim();
const MASSIVE_TICKER_SNAPSHOT_URL = String(process.env.MASSIVE_TICKER_SNAPSHOT_URL || "https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers").trim();
const MASSIVE_SNAPSHOT_ALL_URL = String(process.env.MASSIVE_SNAPSHOT_ALL_URL || "https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers").trim();
const MASSIVE_AGGS_URL = String(process.env.MASSIVE_AGGS_URL || "https://api.massive.com/v2/aggs/ticker").trim();

// Massive WS
const MASSIVE_WS_URL = String(process.env.MASSIVE_WS_URL || "wss://socket.massive.com/stocks").trim();
const ENABLE_HALT_WS = String(process.env.ENABLE_HALT_WS || "true").toLowerCase() === "true";
const ENABLE_AM_WS = String(process.env.ENABLE_AM_WS || "true").toLowerCase() === "true";
const AM_WS_SUBS = String(process.env.AM_WS_SUBS || "AM.*").trim();

// UI / Limits
const UI_AUTO_REFRESH_MS = Math.max(0, Math.min(600000, Number(process.env.UI_AUTO_REFRESH_MS || 15000)));
const IMPORTANT_SYMBOLS = String(process.env.IMPORTANT_SYMBOLS || "NVDA,TSLA,AAPL,AMD,META").trim();
const SYMBOL_DOT_TO_DASH = String(process.env.SYMBOL_DOT_TO_DASH || "false").toLowerCase() === "true";
const SCAN_MAX_SYMBOLS = Math.max(20, Math.min(10000, Number(process.env.SCAN_MAX_SYMBOLS || 200)));
const SCAN_HARD_MAX = Math.max(50, Math.min(10000, Number(process.env.SCAN_HARD_MAX || 1000)));

// Snapshot-all mode (optional)
const ENABLE_SNAPSHOT_ALL = String(process.env.ENABLE_SNAPSHOT_ALL || "false").toLowerCase() === "true";

// Aggs / Indicators
const AGGS_INCLUDE_PREPOST = String(process.env.AGGS_INCLUDE_PREPOST || "true").toLowerCase() === "true";
const ENABLE_5M_INDICATORS = String(process.env.ENABLE_5M_INDICATORS || "true").toLowerCase() === "true";
const AGGS_5M_LIMIT = Math.max(40, Math.min(5000, Number(process.env.AGGS_5M_LIMIT || 120)));
const VOL_SPIKE_MULT = Math.max(1.1, Math.min(10, Number(process.env.VOL_SPIKE_MULT || 1.5)));
const VOL_AVG_LEN_5M = Math.max(5, Math.min(200, Number(process.env.VOL_AVG_LEN_5M || 20)));
const SNAP_CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.SNAP_CONCURRENCY || 4)));
const INCLUDE_OTC = String(process.env.INCLUDE_OTC || "false").toLowerCase() === "true";

// AO Filter
const ENABLE_AO_FILTER = String(process.env.ENABLE_AO_FILTER || "false").toLowerCase() === "true";
const AO_MODE = String(process.env.AO_MODE || "above_zero").toLowerCase(); // above_zero | rising

// AM cache / enrich
const AM_CACHE_MAX = Math.max(200, Math.min(20000, Number(process.env.AM_CACHE_MAX || 8000)));
const AM_ENRICH_LIMIT = Math.max(50, Math.min(1000, Number(process.env.AM_ENRICH_LIMIT || 200)));
const AM_ENRICH_TTL_MS = Math.max(5000, Math.min(300000, Number(process.env.AM_ENRICH_TTL_MS || 60000)));

// Mini chart cache
const MINI_CACHE_TTL_MS = Math.max(2000, Math.min(120000, Number(process.env.MINI_CACHE_TTL_MS || 15000)));

// Polygon daily open/prevClose for Regular Trading Hours Gap%
const POLYGON_BASE_URL = String(process.env.POLYGON_BASE_URL || "https://api.polygon.io").trim();
const POLYGON_API_KEY = String(process.env.POLYGON_API_KEY || process.env.MASSIVE_API_KEY || "").trim();

// Float enrich (Financial Modeling Prep)
const ENABLE_FLOAT_ENRICH = String(process.env.ENABLE_FLOAT_ENRICH || "false").toLowerCase() === "true";
const FMP_API_KEY = String(process.env.FMP_API_KEY || "").trim();
const FLOAT_TTL_MS = Math.max(60_000, Math.min(7 * 86400000, Number(process.env.FLOAT_TTL_MS || 86400000)));

if (!MASSIVE_API_KEY || !MASSIVE_MOVER_URL || !MASSIVE_TICKER_SNAPSHOT_URL) {
  console.error("❌ Missing ENV. Required:");
  console.error(" - MASSIVE_API_KEY");
  console.error(" - MASSIVE_MOVER_URL");
  console.error(" - MASSIVE_TICKER_SNAPSHOT_URL");
  process.exit(1);
}

// ============================================================================
// SECTION 02 — App + Helpers
// ============================================================================
const app = express();
app.use(express.json());

function dlog(...args) {
  if (DEBUG) console.log(...args);
}

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
  return SYMBOL_DOT_TO_DASH ? s.replace(/\./g, "-") : s;
}

function parseSymbols(input) {
  return String(input || "")
    .replace(/[\n\r\t;]/g, ",")
    .replace(/\s+/g, "")
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

// ----------------------------------------------------------------------------
// Session time (New York)
// ----------------------------------------------------------------------------
function toMs(ts) {
  const x = n(ts);
  if (x === null) return null;
  if (x > 1e14) return Math.floor(x / 1e6); // nanoseconds -> milliseconds
  if (x > 1e12) return Math.floor(x); // milliseconds
  if (x > 1e9) return Math.floor(x * 1000); // seconds -> milliseconds
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
  // Premarket: 04:00–09:29
  // Regular trading hours: 09:30–15:59
  // After-hours: 16:00–19:59
  const { h, m } = nyHM(ms);
  const mins = h * 60 + m;
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "pre";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "rth";
  if (mins >= 16 * 60 && mins < 20 * 60) return "after";
  return "off";
}

function extractSnapshotTimestampMs(snap) {
  const root = snap?.results ?? snap ?? {};
  const ms =
    toMs(root?.lastTrade?.t) ??
    toMs(root?.lastQuote?.t) ??
    toMs(root?.updated) ??
    toMs(root?.timestamp) ??
    toMs(root?.e) ??
    toMs(root?.s) ??
    null;
  return ms;
}

// group helpers
function groupToDirection(group) {
  if (String(group || "").trim() === "topLosers") return "losers";
  return "gainers";
}
function sortRowsByGroup(rows, group) {
  if (!Array.isArray(rows)) return;
  if (group === "topGappers") rows.sort((a, b) => Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0));
  else rows.sort((a, b) => Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0));
}
function capPass(row, cap) {
  const want = String(cap || "all").toLowerCase();
  if (want === "all" || want === "") return true;
  return String(row?.cap || "").toLowerCase() === want;
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
function readRowsFromAnySnapshotShape(data) {
  if (Array.isArray(data?.tickers)) return data.tickers;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

async function fetchMovers(direction = "gainers") {
  const d = String(direction || "gainers").toLowerCase().trim();
  const directionSafe = d === "losers" ? "losers" : "gainers";
  const base = MASSIVE_MOVER_URL.replace(/\/+$/, "");
  const url = `${base}/${directionSafe}`;

  const params = {};
  if (INCLUDE_OTC) params.include_otc = "true";

  const a = auth(params, {});
  const r = await safeGet(url, { params: a.params, headers: a.headers });

  const rows = readRowsFromAnySnapshotShape(r.data);
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
  const rows = readRowsFromAnySnapshotShape(r.data);
  return { ok: r.ok && Array.isArray(rows), url, status: r.status, rows, errorDetail: r.errorDetail };
}

// Aggs cache
const aggsCache = new Map(); // key -> {ts, bars}
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
// SECTION 05 — Normalize Snapshot (price/open/prevClose/gap/float/marketCap)
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
  if (open === null) open = findFirstNumberByKeys(root, ["open", "o", "dayopen", "openprice"]).value;

  let prevClose = prevClose0;
  if (prevClose === null) prevClose = findFirstNumberByKeys(root, ["prevclose", "previousclose", "pc", "prevc"]).value;
  if (volume === null) volume = findFirstNumberByKeys(root, ["volume", "v", "dayvolume"]).value;

  if (pricePct === null && price !== null && prevClose !== null && prevClose > 0) {
    pricePct = ((price - prevClose) / prevClose) * 100;
  }

  // Gap% here is best-effort; final correct Regular Trading Hours gap is overwritten later by Polygon.
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

  // Market capitalization estimation if missing:
  // MarketCapitalization = LastPrice * FloatShares
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
  };
}

function addExtPctFromPrevClose(row) {
  const price = n(row?.price);
  const prevClose = n(row?.prevClose);
  const extPct = price !== null && prevClose !== null && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null;
  return { ...row, extPct: extPct !== null ? round2(extPct) : null };
}

// Float Turnover Percent: (Volume / FloatShares) * 100
function addFloatTurnoverPct(row) {
  const volume = n(row?.volume);
  const floatShares = n(row?.floatShares);
  const floatTurnoverPct =
    volume !== null && floatShares !== null && floatShares > 0
      ? (volume / floatShares) * 100
      : null;
  return { ...row, floatTurnoverPct: floatTurnoverPct !== null ? round2(floatTurnoverPct) : null };
}

// ============================================================================
// SECTION 05.5 — Float Enrich (Financial Modeling Prep shares-float)
// ============================================================================
const floatCache = new Map(); // sym -> {ts, floatShares}
async function fetchFloatSharesFMP(sym) {
  if (!ENABLE_FLOAT_ENRICH) return { ok: false, floatShares: null, reason: "disabled" };
  const ticker = String(sym || "").trim().toUpperCase();
  if (!ticker) return { ok: false, floatShares: null, reason: "no_symbol" };
  if (!FMP_API_KEY) return { ok: false, floatShares: null, reason: "missing_FMP_API_KEY" };

  const hit = floatCache.get(ticker);
  if (hit && Date.now() - hit.ts < FLOAT_TTL_MS) return { ok: true, floatShares: hit.floatShares, cached: true };

  const url = "https://financialmodelingprep.com/stable/shares-float";
  const r = await safeGet(url, {
    params: { symbol: ticker, apikey: FMP_API_KEY },
    headers: { "user-agent": "ALGTP" },
  });

  const arr = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.data) ? r.data.data : [];
  const row = arr && arr.length ? arr[0] : null;

  const fs =
    n(row?.floatShares) ??
    n(row?.float) ??
    n(row?.sharesFloat) ??
    n(row?.freeFloat) ??
    null;

  if (!r.ok || fs === null) return { ok: false, floatShares: null, detail: r.errorDetail || r.data };

  floatCache.set(ticker, { ts: Date.now(), floatShares: Math.round(fs) });
  return { ok: true, floatShares: Math.round(fs), cached: false };
}

async function enrichRowsWithFloat(rows, maxN = 200) {
  if (!ENABLE_FLOAT_ENRICH) return rows;

  const top = rows.slice(0, maxN);
  const needSymbols = top
    .filter((r) => r && (r.floatShares == null || r.floatM == null))
    .map((r) => r.symbol)
    .filter(Boolean);

  const symbols = Array.from(new Set(needSymbols));
  if (!symbols.length) return rows;

  const fetched = await mapPool(symbols, Math.min(6, SNAP_CONCURRENCY), async (sym) => {
    const x = await fetchFloatSharesFMP(sym);
    return { sym, ...x };
  });

  const map = new Map(fetched.filter((x) => x.ok && x.floatShares != null).map((x) => [x.sym, x.floatShares]));

  return rows.map((r) => {
    const fmpFloatShares = map.get(r.symbol);
    if (!fmpFloatShares) return r;

    const floatShares = r.floatShares ?? fmpFloatShares;
    const floatM = r.floatM ?? round2(floatShares / 1_000_000);
    const floatCat = r.floatCat ?? floatCategory(floatShares);

    // If market capitalization is missing, estimate:
    // MarketCapitalization = LastPrice * FloatShares
    const price = n(r?.price);
    const marketCapExisting = n(r?.marketCap);

    const marketCap =
      marketCapExisting != null
        ? Math.round(marketCapExisting)
        : (price != null ? Math.round(price * floatShares) : (r.marketCap ?? null));

    const marketCapB = marketCap != null ? round2(marketCap / 1_000_000_000) : (r.marketCapB ?? null);
    const cap = capCategory(marketCap);

    return addFloatTurnoverPct({
      ...r,
      floatShares,
      floatM,
      floatCat,
      floatSource: "financialmodelingprep_shares_float",
      marketCap,
      marketCapB,
      cap,
      capSource: (marketCapExisting != null) ? (r.capSource || "snapshot") : "last_price_times_float_shares",
    });
  });
}

// ============================================================================
// SECTION 06 — Signals (icons)
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
// SECTION 07 — Indicators (EMA/SMA/VWAP) + Awesome Oscillator
// ============================================================================
function computeSMA(arr, len) {
  if (!Array.isArray(arr) || arr.length < len) return null;
  let sum = 0;
  for (let i = arr.length - len; i < arr.length; i++) sum += arr[i];
  return sum / len;
}
function computeEMA(arr, len) {
  if (!Array.isArray(arr) || arr.length < len) return null;
  const k = 2 / (len + 1);
  let ema = computeSMA(arr.slice(0, len), len);
  if (ema === null) return null;
  for (let i = len; i < arr.length; i++) ema = arr[i] * k + ema * (1 - k);
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
    s += v;
    c++;
  }
  if (c === 0) return null;
  return s / c;
}

function indicatorsFromAggs5m(barsDesc) {
  if (!Array.isArray(barsDesc) || barsDesc.length === 0) {
    return { sma26_5m: null, ema9_5m: null, ema34_5m: null, vwap_5m: null, lastVol_5m: null, avgVol_5m: null };
  }
  const bars = barsDesc
    .map((b) => ({
      c: n(b?.c ?? b?.close),
      v: n(b?.v ?? b?.volume),
      h: n(b?.h ?? b?.high),
      l: n(b?.l ?? b?.low),
    }))
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
    _bars5m_forAwesomeOscillator: bars,
  };
}

function computeAwesomeOscillatorFrom5mBars(bars) {
  // Awesome Oscillator = SimpleMovingAverage(5, median) - SimpleMovingAverage(34, median)
  if (!Array.isArray(bars) || bars.length < 34) return { ao: null, aoPrev: null };

  const medianPriceSeries = bars
    .filter((b) => n(b?.h) !== null && n(b?.l) !== null)
    .map((b) => (Number(b.h) + Number(b.l)) / 2)
    .reverse();

  if (medianPriceSeries.length < 35) return { ao: null, aoPrev: null };

  const simpleMovingAverageAt = (arr, len, idx) => {
    if (idx + len > arr.length) return null;
    let s = 0;
    for (let i = idx; i < idx + len; i++) s += arr[i];
    return s / len;
  };

  const aoNow = simpleMovingAverageAt(medianPriceSeries, 5, 0) - simpleMovingAverageAt(medianPriceSeries, 34, 0);
  const aoPrev = simpleMovingAverageAt(medianPriceSeries, 5, 1) - simpleMovingAverageAt(medianPriceSeries, 34, 1);

  return { ao: aoNow !== null ? round2(aoNow) : null, aoPrev: aoPrev !== null ? round2(aoPrev) : null };
}

function attach5mSignals(row) {
  const price = n(row?.price);
  const vwap = n(row?.vwap_5m);
  const lastVol = n(row?.lastVol_5m);
  const avgVol = n(row?.avgVol_5m);

  const aboveVWAP = price !== null && vwap !== null ? price > vwap : false;
  const volSpike = lastVol !== null && avgVol !== null && avgVol > 0 ? lastVol >= avgVol * VOL_SPIKE_MULT : false;

  const volRatio = lastVol !== null && avgVol !== null && avgVol > 0 ? lastVol / avgVol : null;

  return {
    ...row,
    aboveVWAP_5m: aboveVWAP,
    volSpike_5m: volSpike,
    volRatio_5m: volRatio !== null ? Number(volRatio.toFixed(2)) : null,
    paIcon: paSignalIcon({ aboveVWAP_5m: aboveVWAP, volSpike_5m: volSpike }),
  };
}

function aoPass(row) {
  if (!ENABLE_AO_FILTER) return true;
  const ao = n(row?.ao);
  const aoPrev = n(row?.aoPrev);
  if (ao === null) return false;
  if (AO_MODE === "above_zero") return ao > 0;
  if (AO_MODE === "rising") return aoPrev !== null && ao > aoPrev;
  return true;
}

async function attachIndicatorsIfEnabled(rows) {
  if (!ENABLE_5M_INDICATORS) return { rows, aggsErrors: [] };

  const aggsErrors = [];
  const ind = await mapPool(rows, SNAP_CONCURRENCY, async (r) => {
    const a = await fetchAggs5m(r.symbol);
    if (!a.ok) {
      aggsErrors.push({ ticker: r.symbol, status: a.status, url: a.url, errorDetail: a.errorDetail });
      return { symbol: r.symbol };
    }
    const base = indicatorsFromAggs5m(a.bars);
    const aoData = computeAwesomeOscillatorFrom5mBars(base._bars5m_forAwesomeOscillator || []);
    delete base._bars5m_forAwesomeOscillator;
    return { symbol: r.symbol, ...base, ...aoData };
  });

  const mapInd = new Map(ind.map((x) => [x.symbol, x]));
  let out = rows.map((r) => ({ ...r, ...(mapInd.get(r.symbol) || {}) }));
  out = out.map(attach5mSignals);

  if (ENABLE_AO_FILTER) out = out.filter(aoPass);

  return { rows: out, aggsErrors };
}

// ============================================================================
// SECTION 08 — HALT WebSocket + /halts
// ============================================================================
const haltedMap = new Map(); // sym -> { halted, lastEvent, tsMs, reason }

function setHalt(sym) {
  haltedMap.set(sym, { halted: true, lastEvent: "HALT", tsMs: Date.now(), reason: "LimitUpLimitDown" });
}
function setResume(sym) {
  haltedMap.set(sym, { halted: false, lastEvent: "RESUME", tsMs: Date.now(), reason: "LimitUpLimitDown" });
}

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
  if (!WebSocket) return console.log("⚠️ HALT WebSocket disabled: npm i ws");
  if (!MASSIVE_API_KEY) return console.log("⚠️ HALT WebSocket disabled: missing MASSIVE_API_KEY");

  const ws = new WebSocket(MASSIVE_WS_URL);
  let subscribed = false;

  ws.on("open", () => {
    ws.send(JSON.stringify({ action: "auth", params: MASSIVE_API_KEY }));
    console.log("✅ HALT WebSocket connected (waiting auth_success...)");
  });

  ws.on("message", (buf) => {
    try {
      const parsed = JSON.parse(buf.toString("utf8"));
      const msgs = Array.isArray(parsed) ? parsed : [parsed];

      const st = msgs.find((x) => x && String(x.ev || "").toLowerCase() === "status");
      if (st && String(st.status || "").toLowerCase() === "auth_success" && !subscribed) {
        subscribed = true;
        ws.send(JSON.stringify({ action: "subscribe", params: "LULD.*" }));
        console.log("✅ HALT WebSocket auth_success → subscribed LULD.*");
      }
      handleLULD(parsed);
    } catch {}
  });

  ws.on("close", () => {
    console.log("⚠️ HALT WebSocket closed. Reconnect in 3 seconds...");
    setTimeout(startHaltWebSocket, 3000);
  });

  ws.on("error", (err) => console.log("⚠️ HALT WebSocket error:", String(err?.message || err)));
}

function attachHaltFlag(row) {
  const sym = String(row?.symbol || "").trim().toUpperCase();
  if (!sym) return row;
  const x = haltedMap.get(sym);
  return {
    ...row,
    halted: Boolean(x?.halted),
    haltIcon: x?.halted ? "⛔" : "",
    haltTsMs: x?.tsMs ?? null,
  };
}

app.get("/halts", (req, res) => {
  const only = String(req.query.only || "all").toLowerCase(); // all | halted
  const out = [];
  for (const [symbol, v] of haltedMap.entries()) {
    if (only === "halted" && !v.halted) continue;
    out.push({ symbol, ...v });
  }
  out.sort((a, b) => (b.tsMs ?? 0) - (a.tsMs ?? 0));
  res.json({ ok: true, count: out.length, results: out.slice(0, 500) });
});

// ============================================================================
// SECTION 09 — AM WebSocket (minute aggregates) + enrich cache
// ============================================================================
const amMap = new Map(); // sym -> AM payload

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
  if (!WebSocket) return console.log("⚠️ AM WebSocket disabled: npm i ws");
  if (!MASSIVE_API_KEY) return console.log("⚠️ AM WebSocket disabled: missing MASSIVE_API_KEY");

  const ws = new WebSocket(MASSIVE_WS_URL);
  let subscribed = false;

  ws.on("open", () => {
    ws.send(JSON.stringify({ action: "auth", params: MASSIVE_API_KEY }));
    console.log("✅ AM WebSocket connected (waiting auth_success...)");
  });

  ws.on("message", (buf) => {
    try {
      const parsed = JSON.parse(buf.toString("utf8"));
      const msgs = Array.isArray(parsed) ? parsed : [parsed];

      const st = msgs.find((x) => x && String(x.ev || "").toLowerCase() === "status");
      if (st && String(st.status || "").toLowerCase() === "auth_success" && !subscribed) {
        subscribed = true;
        ws.send(JSON.stringify({ action: "subscribe", params: AM_WS_SUBS }));
        console.log(`✅ AM WebSocket auth_success → subscribed: ${AM_WS_SUBS}`);
      }

      handleAMPayload(parsed);
    } catch {}
  });

  ws.on("close", () => {
    console.log("⚠️ AM WebSocket closed. Reconnect in 3 seconds...");
    setTimeout(startAMWebSocket, 3000);
  });

  ws.on("error", (err) => console.log("⚠️ AM WebSocket error:", String(err?.message || err)));
}

// AM enrich snapshot cache
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
  const openMinute = n(am?.op) ?? null; // AM minute "open"
  const extPct = price !== null && openMinute !== null && openMinute > 0 ? ((price - openMinute) / openMinute) * 100 : null;
  const vol = n(am?.av) ?? n(am?.v) ?? null;
  const ms = toMs(am?.e) || toMs(am?.s);

  return {
    symbol: sym,
    price: price !== null ? round2(price) : null,
    open: openMinute !== null ? round2(openMinute) : null,
    pricePct: null,
    gapPct: null,
    extPct: extPct !== null ? round2(extPct) : null,
    volume: vol !== null ? Math.round(vol) : null,
    floatShares: null,
    floatM: null,
    marketCap: null,
    marketCapB: null,
    cap: null,
    source: "AM_WebSocket",
    am_ts: ms,
  };
}

function mergeAMWithSnapshot(amRow, snapRow) {
  const price = n(amRow?.price) ?? n(snapRow?.price);
  const prevClose = n(snapRow?.prevClose);

  // open: snapshot first, fallback to AM openMinute
  let open = n(snapRow?.open);
  if (open === null) open = n(amRow?.open);

  const pricePct =
    price !== null && prevClose !== null && prevClose > 0
      ? ((price - prevClose) / prevClose) * 100
      : n(snapRow?.pricePct);

  const gapPct =
    open !== null && prevClose !== null && prevClose > 0
      ? ((open - prevClose) / prevClose) * 100
      : n(snapRow?.gapPct);

  const extPct =
    price !== null && prevClose !== null && prevClose > 0
      ? ((price - prevClose) / prevClose) * 100
      : n(amRow?.extPct);

  const volA = n(amRow?.volume);
  const volS = n(snapRow?.volume);
  const volume = volA !== null && volS !== null ? Math.max(volA, volS) : volA ?? volS ?? null;

  return {
    ...snapRow,
    price: price !== null ? round2(price) : null,
    open: open !== null ? round2(open) : snapRow?.open ?? null,
    prevClose: prevClose !== null ? round2(prevClose) : snapRow?.prevClose ?? null,
    pricePct: pricePct !== null ? round2(pricePct) : null,
    gapPct: gapPct !== null ? round2(gapPct) : null,
    extPct: extPct !== null ? round2(extPct) : null,
    volume: volume !== null ? Math.round(volume) : null,
    source: "AM_WebSocket_plus_Snapshot",
    am_ts: amRow?.am_ts ?? null,
  };
}

// ============================================================================
// SECTION 09.5 — Polygon daily aggregates (Regular Trading Hours open / previous close)
// ============================================================================
const dailyOpenCache = new Map(); // sym -> {ymd, open, prevClose, ts}

function todayYMD_NY() {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);

    const y = parts.find((p) => p.type === "year")?.value || "1970";
    const m = parts.find((p) => p.type === "month")?.value || "01";
    const d = parts.find((p) => p.type === "day")?.value || "01";
    return `${y}-${m}-${d}`;
  } catch {
    return ymd(new Date());
  }
}

async function fetchDailyOpenPrevClose(sym) {
  const ticker = String(sym || "").trim().toUpperCase();
  if (!ticker) return { ok: false, open: null, prevClose: null };

  const ymdNY = todayYMD_NY();
  const hit = dailyOpenCache.get(ticker);
  if (hit && hit.ymd === ymdNY && Date.now() - hit.ts < 6 * 60 * 60 * 1000) {
    return { ok: true, open: hit.open, prevClose: hit.prevClose, cached: true };
  }

  if (!POLYGON_API_KEY) return { ok: false, open: null, prevClose: null, error: "missing_POLYGON_API_KEY" };

  const base = POLYGON_BASE_URL.replace(/\/+$/, "");
  const to = ymdNY;
  const from = ymd(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)); // buffer for weekends/holidays
  const url = `${base}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}`;

  const r = await safeGet(url, {
    params: { adjusted: "true", sort: "asc", limit: "10", apiKey: POLYGON_API_KEY },
    headers: { "user-agent": "ALGTP" },
  });

  const bars = Array.isArray(r.data?.results) ? r.data.results : [];
  if (!r.ok || bars.length < 1) return { ok: false, open: null, prevClose: null, detail: r.errorDetail || r.data };

  const last = bars[bars.length - 1];
  const prev = bars.length >= 2 ? bars[bars.length - 2] : null;

  const open = n(last?.o);
  const prevClose = n(prev?.c) ?? n(last?.c) ?? null;

  dailyOpenCache.set(ticker, { ymd: ymdNY, open: open ?? null, prevClose, ts: Date.now() });
  return { ok: true, open: open ?? null, prevClose, cached: false };
}

async function enrichRowsWithDailyOpen(rows, maxN = 200) {
  // GapPercent (Regular Trading Hours) = ((RegularTradingHoursOpen - PreviousClose) / PreviousClose) * 100
  // Always prefer Polygon daily aggregates because snapshot open or AM minute open can be NOT Regular Trading Hours open.

  const top = rows.slice(0, maxN);
  const symbols = Array.from(new Set(top.map((r) => r?.symbol).filter(Boolean)));
  if (!symbols.length) return rows;

  const fetched = await mapPool(symbols, Math.min(6, SNAP_CONCURRENCY), async (sym) => {
    const x = await fetchDailyOpenPrevClose(sym);
    return { sym, ...x };
  });

  const map = new Map(fetched.filter((x) => x.ok).map((x) => [x.sym, x]));

  return rows.map((r) => {
    const x = map.get(r.symbol);
    if (!x) return r;

    const polygonOpen = x.open != null ? round2(x.open) : null;
    const polygonPrevClose = x.prevClose != null ? round2(x.prevClose) : null;

    const open = polygonOpen ?? r.open ?? null;
    const prevClose = polygonPrevClose ?? r.prevClose ?? null;

    const gapPct =
      open !== null && prevClose !== null && prevClose > 0
        ? round2(((open - prevClose) / prevClose) * 100)
        : r.gapPct;

    return {
      ...r,
      open,
      prevClose,
      gapPct,
      gapSource:
        (polygonOpen != null || polygonPrevClose != null)
          ? "polygon_daily_aggregates_regular_trading_hours_open_previous_close"
          : (r.gapSource ?? null),
    };
  });
}

// ============================================================================
// SECTION 10 — Builders + Sorting
// - Movers ranking uses Gap% (Regular Trading Hours) + Float Turnover Percent + Volume
// - Gap% is overwritten later by Polygon daily aggregates (Regular Trading Hours open / previous close)
// - Float is enriched later by Financial Modeling Prep shares-float
// - Float Turnover Percent = (Volume / FloatShares) * 100
// - IMPORTANT FIX: when snapshot timestamp is missing, we DO NOT drop the ticker
// ============================================================================

function finalizeRows(rows) {
  // Attach score + icons + halt flag + float turnover percent
  let out = rows.map((r) => {
    const d = demandScore(r);
    return {
      ...r,
      demandScore: d,
      signalIcon: signalIcon(d),
      paIcon: r.paIcon || "",
    };
  });

  out = out.map(attachHaltFlag);
  out = out.map(addFloatTurnoverPct);

  return out;
}

function prelimScoreVolatile(row) {
  // Volatility score uses the largest absolute move among:
  // - GapPercent
  // - PricePercent
  // - ExtendedHoursPercent
  const gapAbs = Math.abs(n(row?.gapPct) ?? 0);
  const priceAbs = Math.abs(n(row?.pricePct) ?? 0);
  const extAbs = Math.abs(n(row?.extPct) ?? 0);
  return Math.max(gapAbs, priceAbs, extAbs);
}

function sortForPrepick(rows, mode) {
  // Used to reduce universe size BEFORE indicators to save API calls
  const safeN = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

  if (mode === "active") {
    return [...rows].sort((a, b) => safeN(b.volume) - safeN(a.volume));
  }

  if (mode === "volatile") {
    return [...rows].sort(
      (a, b) => prelimScoreVolatile(b) - prelimScoreVolatile(a) || safeN(b.volume) - safeN(a.volume)
    );
  }

  if (mode === "gap") {
    return [...rows].sort(
      (a, b) => Math.abs(safeN(b.gapPct)) - Math.abs(safeN(a.gapPct)) || safeN(b.volume) - safeN(a.volume)
    );
  }

  if (mode === "gapFloatRank") {
    // Movers special rank: Gap% (abs) desc -> FloatTurnoverPercent desc -> Volume desc
    return [...rows].sort((a, b) => {
      const aGap = Math.abs(safeN(a.gapPct));
      const bGap = Math.abs(safeN(b.gapPct));

      const aFloatTurn = safeN(a.floatTurnoverPct);
      const bFloatTurn = safeN(b.floatTurnoverPct);

      const aVol = safeN(a.volume);
      const bVol = safeN(b.volume);

      return bGap - aGap || bFloatTurn - aFloatTurn || bVol - aVol;
    });
  }

  // default: active
  return [...rows].sort((a, b) => safeN(b.volume) - safeN(a.volume));
}

function sortGapFloatVolume(rows) {
  // Movers ranking rule (most important for "mover"):
  // 1) Highest absolute GapPercent first (GapPercent is Regular Trading Hours gap after Polygon overwrite)
  //    GapPercent = ((RegularTradingHoursOpen - PreviousClose) / PreviousClose) * 100
  // 2) Highest FloatTurnoverPercent next
  //    FloatTurnoverPercent = (Volume / FloatShares) * 100
  // 3) Highest Volume last
  rows.sort((a, b) => {
    const gapA = Math.abs(n(a?.gapPct) ?? 0);
    const gapB = Math.abs(n(b?.gapPct) ?? 0);

    const floatTurnA = n(a?.floatTurnoverPct) ?? 0;
    const floatTurnB = n(b?.floatTurnoverPct) ?? 0;

    const volA = n(a?.volume) ?? 0;
    const volB = n(b?.volume) ?? 0;

    return gapB - gapA || floatTurnB - floatTurnA || volB - volA;
  });
}

async function buildRowsFromSnapshotAll({ cap = "all", limit = 120, session = null, sortMode = "gap" } = {}) {
  if (!ENABLE_SNAPSHOT_ALL) {
    return {
      ok: false,
      status: 403,
      body: {
        ok: false,
        error: "Snapshot-All is OFF",
        hint: "Set ENABLE_SNAPSHOT_ALL=true or use WebSocket fallback (AM cache).",
      },
    };
  }

  const miss = envMissingFor({ needSnapshotAll: true, needAggs: ENABLE_5M_INDICATORS });
  if (miss.length) return { ok: false, status: 400, body: { ok: false, error: "Missing env", miss } };

  const snap = await fetchSnapshotAll();
  if (!snap.ok) return { ok: false, status: 500, body: { ok: false, error: "Snapshot-all failed", debug: snap } };

  // Build map ticker -> raw snapshot object
  const snapMap = new Map();
  for (const x of snap.rows) {
    const t = String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase();
    if (t) snapMap.set(t, x);
  }

  // Normalize to standard row objects
  let rows = [];
  for (const [ticker, raw] of snapMap.entries()) {
    let r = normalizeSnapshotAuto(ticker, raw);
    r = addExtPctFromPrevClose(r);
    rows.push(r);
  }

  // Session filter:
  // IMPORTANT: if timestamp missing, do not drop (keep the ticker).
  if (session) {
    rows = rows.filter((r) => {
      const raw = snapMap.get(r.symbol);
      const ms = extractSnapshotTimestampMs(raw);

      // If we cannot determine timestamp, keep it (better than losing movers).
      if (!ms) return true;

      return sessionOfMs(ms) === session;
    });
  }

  rows = rows.filter((r) => capPass(r, cap));

  // Overwrite open/prevClose/gapPct using Polygon daily aggregates (Regular Trading Hours open / previous close)
  rows = await enrichRowsWithDailyOpen(rows, 200);

  // Enrich float using Financial Modeling Prep shares-float
  rows = await enrichRowsWithFloat(rows, 200);

  // Reduce before indicators
  const lim = clamp(Number(limit || 120), 10, 500);
  const prepickN = Math.max(250, lim * 5);
  rows = sortForPrepick(rows, sortMode).slice(0, prepickN);

  // Indicators
  const { rows: withInd, aggsErrors } = await attachIndicatorsIfEnabled(rows);
  rows = finalizeRows(withInd);

  // Final sort
  if (sortMode === "active") {
    rows.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  } else if (sortMode === "volatile") {
    rows.sort((a, b) => prelimScoreVolatile(b) - prelimScoreVolatile(a) || (b.volume ?? 0) - (a.volume ?? 0));
  } else if (sortMode === "gapFloatRank") {
    sortGapFloatVolume(rows);
  } else {
    rows.sort(
      (a, b) =>
        Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0) ||
        Math.abs(b.extPct ?? 0) - Math.abs(a.extPct ?? 0) ||
        Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0) ||
        (b.volume ?? 0) - (a.volume ?? 0)
    );
  }

  rows = rows.slice(0, lim);

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      source: "SNAPSHOT_ALL",
      session: session || null,
      cap,
      results: rows,
      aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined,
    },
  };
}

async function buildRowsFromAMCache({ cap = "all", limit = 120, session = null, sortMode = "gap" } = {}) {
  // Base from AM WebSocket cache
  let base = [];
  for (const [sym, am] of amMap.entries()) {
    const ms = toMs(am?.e) || toMs(am?.s);
    if (!ms) continue;
    if (session && sessionOfMs(ms) !== session) continue;
    base.push(normalizeFromAMOnly(sym, am));
  }

  if (!base.length) {
    return { ok: true, status: 200, body: { ok: true, source: "AM_WebSocket", session, cap, results: [] } };
  }

  const lim = clamp(Number(limit || 120), 10, 500);

  // Pick top candidates to enrich by snapshot (limit REST load)
  const candidates = sortForPrepick(base, sortMode);
  const pick = candidates.slice(0, AM_ENRICH_LIMIT).map((x) => x.symbol);

  // Fetch snapshots for missing ones
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

  // Merge AM + Snapshot (best-effort)
  let rows = base.map((r) => {
    const snapRow = getSnapCached(r.symbol);
    return snapRow ? mergeAMWithSnapshot(r, snapRow) : r;
  });

  if (String(cap || "all").toLowerCase() !== "all") rows = rows.filter((r) => capPass(r, cap));

  // Overwrite open/prevClose/gapPct using Polygon daily aggregates (Regular Trading Hours open / previous close)
  rows = await enrichRowsWithDailyOpen(rows, 200);

  // Enrich float using Financial Modeling Prep shares-float
  rows = await enrichRowsWithFloat(rows, 200);

  // Reduce before indicators
  rows = sortForPrepick(rows, sortMode).slice(0, Math.max(200, lim * 4));

  const { rows: withInd, aggsErrors } = await attachIndicatorsIfEnabled(rows);
  rows = finalizeRows(withInd);

  // Final sort
  if (sortMode === "active") {
    rows.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  } else if (sortMode === "volatile") {
    rows.sort((a, b) => prelimScoreVolatile(b) - prelimScoreVolatile(a) || (b.volume ?? 0) - (a.volume ?? 0));
  } else if (sortMode === "gapFloatRank") {
    sortGapFloatVolume(rows);
  } else {
    rows.sort(
      (a, b) =>
        Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0) ||
        (b.demandScore ?? 0) - (a.demandScore ?? 0) ||
        Math.abs(b.extPct ?? 0) - Math.abs(a.extPct ?? 0) ||
        (b.volume ?? 0) - (a.volume ?? 0)
    );
  }

  rows = rows.slice(0, lim);

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      source: "AM_FALLBACK",
      session,
      cap,
      results: rows,
      aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined,
    },
  };
}

async function buildRowsFromMoversUnion({ cap = "all", limit = 120, sortMode = "active" } = {}) {
  // Universe fallback when snapshot-all is OFF:
  // Use Massive movers list (gainers + losers) -> fetch snapshots -> normalize -> enrich -> rank
  const lim = clamp(Number(limit || 120), 10, 500);

  const g = await fetchMovers("gainers");
  const l = await fetchMovers("losers");

  const pool = [...(g.ok ? g.rows : []), ...(l.ok ? l.rows : [])]
    .map((x) => String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase())
    .filter(Boolean);

  const tickers = Array.from(new Set(pool)).slice(0, Math.max(400, lim * 8));

  const snaps = await mapPool(tickers, SNAP_CONCURRENCY, async (t) => {
    const r = await fetchTickerSnapshot(t);
    return { ticker: t, ...r };
  });

  const good = snaps.filter((x) => x.ok);
  let rows = good.map((x) => normalizeSnapshotAuto(x.ticker, x.data)).map(addExtPctFromPrevClose);

  if (String(cap || "all").toLowerCase() !== "all") rows = rows.filter((r) => capPass(r, cap));

  rows = await enrichRowsWithDailyOpen(rows, 200);
  rows = await enrichRowsWithFloat(rows, 200);

  // Reduce before indicators
  rows = sortForPrepick(rows, sortMode).slice(0, Math.max(250, lim * 5));

  const { rows: withInd, aggsErrors } = await attachIndicatorsIfEnabled(rows);
  rows = finalizeRows(withInd);

  if (sortMode === "gapFloatRank") sortGapFloatVolume(rows);
  else if (sortMode === "volatile") rows.sort((a, b) => prelimScoreVolatile(b) - prelimScoreVolatile(a) || (b.volume ?? 0) - (a.volume ?? 0));
  else if (sortMode === "active") rows.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  else rows.sort((a, b) => Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0) || (b.volume ?? 0) - (a.volume ?? 0));

  rows = rows.slice(0, lim);

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      source: "MOVERS_UNION",
      cap,
      results: rows,
      aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined,
    },
  };
}

async function buildRowsFromMoversUnionBySession({ session, limit = 120 } = {}) {
  // Movers list is the fastest data fragment:
  // 1) Massive movers list -> candidate tickers
  // 2) Massive ticker snapshot -> normalize
  // 3) Polygon daily aggregates -> overwrite Regular Trading Hours open and previous close -> compute Gap%
  // 4) Financial Modeling Prep shares-float -> enrich Float -> compute Float Turnover Percent
  // 5) Rank: highest absolute Gap% first, then highest Float Turnover Percent, then Volume

  const lim = clamp(Number(limit || 120), 10, 500);

  const g = await fetchMovers("gainers");
  const l = await fetchMovers("losers");

  const pool = [...(g.ok ? g.rows : []), ...(l.ok ? l.rows : [])]
    .map((x) => String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase())
    .filter(Boolean);

  const tickers = Array.from(new Set(pool)).slice(0, Math.max(400, lim * 10));

  const snaps = await mapPool(tickers, SNAP_CONCURRENCY, async (t) => {
    const r = await fetchTickerSnapshot(t);
    return { ticker: t, ...r };
  });

  const good = snaps.filter((x) => x.ok);
  const snapDataMap = new Map(good.map((x) => [x.ticker, x.data]));

  let rows = good
    .map((x) => normalizeSnapshotAuto(x.ticker, x.data))
    .map(addExtPctFromPrevClose);

  // ✅ CRITICAL FIX:
  // When timestamp is missing in snapshot, DO NOT drop the mover.
  // If timestamp exists, use it to filter by requested session.
  rows = rows.filter((r) => {
    const raw = snapDataMap.get(r.symbol);
    const ms = extractSnapshotTimestampMs(raw);

    // Missing timestamp → keep it (this prevents empty movers)
    if (!ms) return true;

    return sessionOfMs(ms) === session;
  });

  rows = await enrichRowsWithDailyOpen(rows, 200);
  rows = await enrichRowsWithFloat(rows, 200);

  const { rows: withInd } = await attachIndicatorsIfEnabled(rows);
  rows = finalizeRows(withInd);

  sortGapFloatVolume(rows);

  return rows.slice(0, lim);
}

// ============================================================================
// SECTION 11 — Mini Chart endpoint (hover)
// ============================================================================
const miniCache = new Map(); // key -> {ts, payload}

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
    endpoints: [
      "/list",
      "/scan",
      "/snapshot-all",
      "/premarket",
      "/aftermarket",
      "/movers-premarket",
      "/movers-afterhours",
      "/most-active",
      "/unusual-volume",
      "/most-volatile",
      "/most-lately",
      "/mini-chart",
      "/halts",
      "/api",
    ],
  });
});

app.get("/api", (req, res) => {
  res.json({
    ok: true,
    config: {
      port: PORT,
      snapshotAllEnabled: ENABLE_SNAPSHOT_ALL,
      indicators5mEnabled: ENABLE_5M_INDICATORS,
      awesomeOscillatorFilterEnabled: ENABLE_AO_FILTER,
      haltWebSocketEnabled: ENABLE_HALT_WS,
      amWebSocketEnabled: ENABLE_AM_WS,
      amSubscriptions: AM_WS_SUBS,
      amCacheSize: amMap.size,
      amSnapCacheSize: amSnapCache.size,
      miniCacheSize: miniCache.size,
      uiAutoRefreshMs: UI_AUTO_REFRESH_MS,
      polygonApiKeyPresent: Boolean(POLYGON_API_KEY),
      floatEnrichEnabled: ENABLE_FLOAT_ENRICH,
      financialModelingPrepApiKeyPresent: Boolean(FMP_API_KEY),
    },
  });
});

app.get("/scan", async (req, res) => {
  try {
    const miss = envMissingFor({ needAggs: ENABLE_5M_INDICATORS });
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const ALL = parseSymbols(req.query.symbols || IMPORTANT_SYMBOLS);

    const MAX_FROM_UI = Number(req.query.max);
    const ENV_MAX = Number(process.env.SCAN_MAX_SYMBOLS || SCAN_MAX_SYMBOLS);
    const HARD_MAX = Number(process.env.SCAN_HARD_MAX || SCAN_HARD_MAX);

    const maxN = (() => {
      const base = Number.isFinite(MAX_FROM_UI) ? MAX_FROM_UI : ENV_MAX;
      return Math.max(20, Math.min(HARD_MAX, Math.floor(base)));
    })();

    const symbols = ALL.slice(0, maxN);

    const snaps = await mapPool(symbols, SNAP_CONCURRENCY, async (t) => {
      const r = await fetchTickerSnapshot(t);
      return { ticker: t, ...r };
    });

    const good = snaps.filter((x) => x.ok);
    const bad = snaps.filter((x) => !x.ok);

    let rows = good.map((x) => normalizeSnapshotAuto(x.ticker, x.data)).map(addExtPctFromPrevClose);

    // Overwrite open/prevClose/gapPct using Polygon daily aggregates (Regular Trading Hours open / previous close)
    rows = await enrichRowsWithDailyOpen(rows, 200);

    // Enrich float using Financial Modeling Prep shares-float
    rows = await enrichRowsWithFloat(rows, 200);

    const badRows = bad.map((x) => ({
      symbol: x.ticker,
      price: null,
      open: null,
      prevClose: null,
      pricePct: null,
      gapPct: null,
      extPct: null,
      volume: null,
      floatShares: null,
      floatM: null,
      floatTurnoverPct: null,
      marketCapB: null,
      cap: null,
      demandScore: 0,
      signalIcon: "⚠️",
      paIcon: "",
      source: "SNAPSHOT_FAILED",
    }));

    rows = rows.concat(badRows);

    const { rows: withInd, aggsErrors } = await attachIndicatorsIfEnabled(rows);
    rows = finalizeRows(withInd);

    rows.sort((a, b) => Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0) || Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0));

    res.json({
      ok: true,
      mode: "symbols",
      scanned: symbols.length,
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
    const miss = envMissingFor({ needAggs: ENABLE_5M_INDICATORS });
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const group = String(req.query.group || "topGainers").trim(); // topGainers | topLosers | topGappers
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

    rows = await enrichRowsWithDailyOpen(rows, 200);
    rows = await enrichRowsWithFloat(rows, 200);

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
      snapshotErrors: DEBUG
        ? bad.slice(0, 10).map((x) => ({ ticker: x.ticker, status: x.status, url: x.url, errorDetail: x.errorDetail }))
        : undefined,
      aggsErrors: DEBUG ? aggsErrors.slice(0, 10) : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "List failed", detail: String(e?.message || e) });
  }
});

app.get("/snapshot-all", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = req.query.limit;
  const out = await buildRowsFromSnapshotAll({ cap, limit, session: null, sortMode: "gap" });
  return res.status(out.status).json(out.body);
});

app.get("/premarket", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = req.query.limit;

  if (ENABLE_SNAPSHOT_ALL) {
    const out = await buildRowsFromSnapshotAll({ cap, limit, session: "pre", sortMode: "gap" });
    return res.status(out.status).json(out.body);
  }

  const out = await buildRowsFromAMCache({ cap, limit, session: "pre", sortMode: "gap" });
  return res.status(out.status).json(out.body);
});

app.get("/aftermarket", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = req.query.limit;

  if (ENABLE_SNAPSHOT_ALL) {
    const out = await buildRowsFromSnapshotAll({ cap, limit, session: "after", sortMode: "gap" });
    return res.status(out.status).json(out.body);
  }

  const out = await buildRowsFromAMCache({ cap, limit, session: "after", sortMode: "gap" });
  return res.status(out.status).json(out.body);
});

// Movers Premarket / After-hours (Massive Movers list is the fastest source) with ranking by Gap% + Float Turnover %
app.get("/movers-premarket", async (req, res) => {
  try {
    const limit = clamp(Number(req.query.limit || 120), 10, 500);
    const rows = await buildRowsFromMoversUnionBySession({ session: "pre", limit });
    res.json({ ok: true, session: "premarket", source: "massive_movers_list", rank: "gap_percent_then_float_turnover_percent_then_volume", results: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: "movers-premarket failed", detail: String(e?.message || e) });
  }
});

app.get("/movers-afterhours", async (req, res) => {
  try {
    const limit = clamp(Number(req.query.limit || 120), 10, 500);
    const rows = await buildRowsFromMoversUnionBySession({ session: "after", limit });
    res.json({ ok: true, session: "afterhours", source: "massive_movers_list", rank: "gap_percent_then_float_turnover_percent_then_volume", results: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: "movers-afterhours failed", detail: String(e?.message || e) });
  }
});

// Most Active / Unusual Volume / Most Volatile / Most Lately
app.get("/most-active", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = req.query.limit;
  const out = ENABLE_SNAPSHOT_ALL
    ? await buildRowsFromSnapshotAll({ cap, limit, session: null, sortMode: "active" })
    : await buildRowsFromMoversUnion({ cap, limit, sortMode: "active" });
  return res.status(out.status).json(out.body);
});

app.get("/most-volatile", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = req.query.limit;
  const out = ENABLE_SNAPSHOT_ALL
    ? await buildRowsFromSnapshotAll({ cap, limit, session: null, sortMode: "volatile" })
    : await buildRowsFromMoversUnion({ cap, limit, sortMode: "volatile" });
  return res.status(out.status).json(out.body);
});

app.get("/most-lately", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = clamp(Number(req.query.limit || 120), 10, 500);

  const lastTimestampMsOfRow = (r) => {
    const a = toMs(r?.am_ts) ?? null;
    const b = n(r?.haltTsMs) ?? null;
    return a ?? b ?? 0;
  };

  const out = ENABLE_SNAPSHOT_ALL
    ? await buildRowsFromSnapshotAll({ cap, limit: Math.max(250, limit * 3), session: null, sortMode: "active" })
    : await buildRowsFromMoversUnion({ cap, limit: Math.max(250, limit * 3), sortMode: "active" });

  if (!out.ok) return res.status(out.status).json(out.body);

  let rows = Array.isArray(out.body?.results) ? out.body.results : [];
  rows = rows
    .map((r) => ({ ...r, lastTsMs: lastTimestampMsOfRow(r) }))
    .sort((a, b) => (b.lastTsMs ?? 0) - (a.lastTsMs ?? 0))
    .slice(0, limit);

  return res.json({ ok: true, cap, results: rows });
});

app.get("/unusual-volume", async (req, res) => {
  try {
    const cap = String(req.query.cap || "all").toLowerCase();
    const limit = clamp(Number(req.query.limit || 120), 10, 500);

    const base = ENABLE_SNAPSHOT_ALL
      ? await buildRowsFromSnapshotAll({ cap, limit: Math.max(250, limit * 5), session: null, sortMode: "active" })
      : await buildRowsFromMoversUnion({ cap, limit: Math.max(250, limit * 5), sortMode: "active" });

    if (!base.ok) return res.status(base.status).json(base.body);

    let rows = Array.isArray(base.body?.results) ? base.body.results : [];

    if (!ENABLE_5M_INDICATORS) {
      rows.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
      rows = rows.slice(0, limit);
      return res.json({
        ok: true,
        cap,
        note: "ENABLE_5M_INDICATORS is false, fallback ranking by volume",
        results: rows,
      });
    }

    rows = rows
      .filter((r) => r && (r.volSpike_5m || (n(r.volRatio_5m) ?? 0) >= 2))
      .sort((a, b) => (n(b.volRatio_5m) ?? 0) - (n(a.volRatio_5m) ?? 0) || (b.volume ?? 0) - (a.volume ?? 0))
      .slice(0, limit);

    res.json({ ok: true, cap, results: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: "unusual-volume failed", detail: String(e?.message || e) });
  }
});

// ============================================================================
// SECTION 13 — UI (Dashboard)
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

  const importantDefault = IMPORTANT_SYMBOLS || "NVDA,TSLA,AAPL,AMD,META";
  const autoMs = UI_AUTO_REFRESH_MS;
  const autoSec = Math.max(1, Math.round(autoMs / 1000));

  const snapAllOn = ENABLE_SNAPSHOT_ALL ? "ON" : "OFF";
  const vwapOn = ENABLE_5M_INDICATORS ? "ON" : "OFF";

  const envMax = Number(process.env.SCAN_MAX_SYMBOLS || SCAN_MAX_SYMBOLS);
  const hardMax = Number(process.env.SCAN_HARD_MAX || SCAN_HARD_MAX);
  const initMax = Math.max(20, Math.min(hardMax, Number.isFinite(envMax) ? envMax : 200));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${BRAND?.name || "ALGTP™"} Dashboard</title>
<style>
:root{ color-scheme: dark; }
body{ margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b0d12; color:#e6e8ef; }
.wrap{ max-width:1900px; margin:0 auto; padding:0 12px; }
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
.tag{
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

/* ===== TOP BAR ===== */
.topBar{ display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.topBar .left{ display:flex; align-items:center; gap:10px; flex:1; min-width: 720px; flex-wrap:wrap; }
.topBar .right{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }

.symbolsInput{
  flex:1; min-width:520px;
  background:#0f1320; border:1px solid rgba(255,255,255,.14);
  border-radius:16px;
  padding:11px 14px;
  color:#e6e8ef;
}
.hintMini{ font-size:12px; color:#a7adc2; white-space:nowrap; }

.btnTiny{
  font-size:12px;
  padding:7px 10px;
  border-radius:999px;
  background:#121622;
  border:1px solid rgba(255,255,255,.12);
  color:#c8cde0;
  cursor:pointer;
  user-select:none;
}
.btnTiny:hover{ border-color: rgba(255,255,255,.22); }

.stepper{
  display:inline-flex;
  align-items:center;
  gap:8px;
  padding:7px 10px;
  border-radius:999px;
  background:#121622;
  border:1px solid rgba(255,255,255,.12);
  color:#c8cde0;
}
.stepper label{ font-size:12px; color:#a7adc2; }
.stepper input{
  width:72px;
  background:#0f1320;
  border:1px solid rgba(255,255,255,.14);
  border-radius:12px;
  padding:7px 10px;
  color:#e6e8ef;
  outline:none;
  font-size:12px;
}
.stepBtns{ display:flex; gap:6px; }
.stepBtn{
  width:28px; height:28px;
  border-radius:10px;
  border:1px solid rgba(255,255,255,.12);
  background:#0f1320;
  color:#e6e8ef;
  cursor:pointer;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  user-select:none;
}
.stepBtn:hover{ border-color: rgba(255,255,255,.22); }

@media (max-width: 1050px){
  .symbolsInput{ min-width:100%; }
}

/* ===== SYMBOLS ROLLER ===== */
.rollerWrap{
  margin-top:10px;
  border:1px solid rgba(255,255,255,.10);
  background:#0f1320;
  border-radius:14px;
  padding:8px 10px;
}
.rollerHead{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  margin-bottom:8px;
}
.rollerTitle{ font-size:12px; font-weight:900; color:#c8cde0; }
.rollerHint{ font-size:12px; color:#a7adc2; }
.roller{
  display:flex;
  gap:8px;
  overflow-x:auto;
  padding-bottom:4px;
  scrollbar-width: thin;
}
.chip{
  display:inline-flex;
  align-items:center;
  gap:8px;
  padding:7px 10px;
  border-radius:999px;
  background:#121622;
  border:1px solid rgba(255,255,255,.12);
  color:#e6e8ef;
  font-size:12px;
  white-space:nowrap;
  cursor:pointer;
  user-select:none;
}
.chip:hover{ border-color: rgba(255,255,255,.22); }
.chip small{ color:#a7adc2; font-size:11px; }

/* ===== GRID ===== */
.grid{ display:grid; grid-template-columns: repeat(12, 1fr); gap:8px; padding:12px 0 18px; }
.box{ grid-column: span 3; border:1px solid rgba(255,255,255,.14); border-radius:10px; overflow:hidden; background:#0b0d12; min-height:180px; }
.box.cols2{ grid-column: span 4; }
.box.cols3{ grid-column: span 4; }
.box.cols4{ grid-column: span 6; }
.box.cols6{ grid-column: span 12; }

.boxHead{ background:#121622; border-bottom:1px solid rgba(255,255,255,.10); padding:6px 10px; display:flex; align-items:center; justify-content:space-between; font-weight:900; font-size:12px; letter-spacing:.3px; }
.boxMeta{ font-weight:600; font-size:11px; color:#a7adc2; }
.boxBody{ overflow:auto; max-height:420px; }
.box table{ width:100%; border-collapse:collapse; }
.box th,.box td{ padding:6px 8px; border-bottom:1px solid rgba(255,255,255,.06); font-size:12px; white-space:nowrap; }
.box th{ position:sticky; top:0; background:#0b0d12; color:#a7adc2; }
.box tr:hover td{ background: rgba(255,255,255,.03); }

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

.watermark{ position: fixed; bottom: 10px; right: 12px; font-size: 11px; color: rgba(230,232,239,.30); pointer-events:none; user-select:none; z-index:9999; }
</style>
</head>

<body>
<header>
  <div class="wrap">
    <div class="brandRow">
      <div>
        <div class="brandTitle">
          <span class="brandMark">${BRAND?.mark || "🔥"}</span>
          <span class="brandName">${BRAND?.legal || "ALGTP™"}</span>
        </div>
        <div class="brandSub">Movers ranked by Gap% + Float Turnover % • Hover mini-chart</div>
      </div>
      <div class="pill">Auto: <b>${autoSec}s</b></div>
    </div>
  </div>
</header>

<div class="panel">
  <div class="wrap">
    <div class="topBar">
      <div class="left">
        <span class="tag">🔎 SYMBOLS</span>
        <input id="symbols" class="symbolsInput"
               value="${String(importantDefault).replace(/"/g, "&quot;")}"
               placeholder="Paste many symbols... (Enter)" />

        <div class="stepper" title="Max symbols to scan from your list">
          <label>Max</label>
          <div class="stepBtns">
            <div class="stepBtn" id="maxDown">−</div>
            <div class="stepBtn" id="maxUp">+</div>
          </div>
          <input id="maxSymbols" type="number" min="20" max="${hardMax}" step="20" value="${initMax}" />
        </div>

        <button class="btnTiny" id="btnApply">Apply</button>
        <button class="btnTiny" id="btnClear">Clear</button>
        <span class="hintMini">Enter/Apply → update IMPORTANT_STOCKS</span>
      </div>

      <div class="right">
        <span class="pill" id="statusPill">Dashboard</span>
        <span class="pill">Snapshot-All: <b>${snapAllOn}</b></span>
        <span class="pill">Indicators: <b>${vwapOn}</b></span>
      </div>
    </div>

    <div class="rollerWrap">
      <div class="rollerHead">
        <div class="rollerTitle">SYMBOL ROLLER</div>
        <div class="rollerHint">Scroll → hover chip = mini chart • click chip = TradingView</div>
      </div>
      <div class="roller" id="roller"></div>
    </div>

    <div class="hint">
      Movers boxes rank: highest absolute Gap% first, then highest Float Turnover %, then Volume.
      Gap% uses Polygon Regular Trading Hours open and previous close. Float uses Financial Modeling Prep shares-float.
    </div>

    <div class="err" id="errBox"></div>
  </div>
</div>

<div class="wrap">
  <div class="grid" id="grid"></div>
</div>

<div class="watermark">${BRAND?.watermark || ""}</div>

<!-- Risk popup -->
<div class="riskBack" id="riskBack" aria-hidden="true">
  <div class="riskBox" role="dialog" aria-modal="true">
    <div class="riskTop"><div class="riskTitle">${risk.title}</div></div>
    <div class="riskBody">
      <div style="font-weight:900; margin-bottom:6px;">${BRAND?.legal || "ALGTP™"}</div>
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
const roller = byId("roller");

let riskAccepted = false;
(function riskNotice(){
  const back = byId("riskBack");
  const agree = byId("riskAgree");
  const btn = byId("riskContinueBtn");
  const hint = byId("riskHint");
  back.style.display = "flex";
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

// ===== Dashboard sections =====
let importantSymbols = byId("symbols").value || "";
let scanMax = Number(byId("maxSymbols").value || 200);

const REFRESH_MS = ${UI_AUTO_REFRESH_MS};

const SECTIONS = [
  { id:"pm_movers", title:"PREMARKET MOVERS (Gap% + Float Turnover %)", url:"/movers-premarket?limit=200", cols:3, limit:40, sort:"gapFloatRank" },
  { id:"ah_movers", title:"AFTER HOURS MOVERS (Gap% + Float Turnover %)", url:"/movers-afterhours?limit=200", cols:3, limit:40, sort:"gapFloatRank" },

  { id:"gappers", title:"GAPPERS", url:"/list?group=topGappers&cap=all&limit=200&minGap=5", cols:3, limit:20, sort:"gapDesc" },
  { id:"unusual", title:"UNUSUAL VOLUME", url:"/unusual-volume?cap=all&limit=200", cols:3, limit:20, sort:"uv" },
  { id:"most_active", title:"MOST ACTIVE", url:"/most-active?cap=all&limit=200", cols:3, limit:20, sort:"active" },
  { id:"most_volatile", title:"MOST VOLATILE", url:"/most-volatile?cap=all&limit=200", cols:3, limit:20, sort:"volatile" },

  // IMPORTANT (big) — hide ticker text but keep hover/click
  { id:"important", title:"IMPORTANT_STOCKS", url:"/scan?symbols="+encodeURIComponent(importantSymbols)+"&max="+encodeURIComponent(scanMax), cols:6, limit:200, sort:"gapDesc", hideSymbol:true },

  { id:"halts", title:"HALT (Limit Up / Limit Down)", url:"/halts?only=all", cols:6, limit:120, type:"halts" },
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
  if (mode==="gapDesc") return [...rows].sort((a,b)=> (safe(b.gapPct)??-1e18)-(safe(a.gapPct)??-1e18));
  if (mode==="active")  return [...rows].sort((a,b)=> (safe(b.volume)??-1e18)-(safe(a.volume)??-1e18));
  if (mode==="volatile")return [...rows].sort((a,b)=> (safe(Math.abs(b.gapPct??0))??-1e18)-(safe(Math.abs(a.gapPct??0))??-1e18));
  if (mode==="uv")      return [...rows].sort((a,b)=> (safe(b.volRatio_5m)??-1e18)-(safe(a.volRatio_5m)??-1e18) || (safe(b.volume)??-1e18)-(safe(a.volume)??-1e18));
  if (mode==="gapFloatRank"){
    return [...rows].sort((a,b)=>
      Math.abs((safe(b.gapPct)??0)) - Math.abs((safe(a.gapPct)??0)) ||
      ((safe(b.floatTurnoverPct)??0)) - ((safe(a.floatTurnoverPct)??0)) ||
      ((safe(b.volume)??0)) - ((safe(a.volume)??0))
    );
  }
  return rows;
}

function rowsTable(rowsRaw, sec){
  const rows = sortRows(rowsRaw, sec.sort).slice(0, sec.limit ?? 40);
  return \`
  <table>
    <thead>
      <tr>
        <th>Sig</th>
        <th>PA</th>
        <th>Symbol</th>
        <th class="right">Price</th>
        <th class="right">Regular Open</th>
        <th class="right">Previous Close</th>
        <th class="right">Gap%</th>
        <th class="right">VWAP</th>
        <th class="right">Vol</th>
        <th class="right">Float(M)</th>
        <th class="right">Float%</th>
      </tr>
    </thead>
    <tbody>
      \${rows.map(r=>{
        const sym=String(r.symbol||"");
        const safeSym=sym.replace(/'/g,"");
        const label = sec.hideSymbol ? "•" : sym;
        return \`
        <tr>
          <td>\${r.signalIcon||""}</td>
          <td>\${r.paIcon||""}</td>
          <td class="mono">
            <a class="symLink" data-sym="\${safeSym}" href="javascript:void(0)" onclick="handleTickerClick(event,'\${safeSym}')">\${label}</a>
          </td>
          <td class="right mono">\${fmtNum(r.price)}</td>
          <td class="right mono">\${fmtNum(r.open)}</td>
          <td class="right mono">\${fmtNum(r.prevClose)}</td>
          <td class="right mono">\${fmtNum(r.gapPct)}%</td>
          <td class="right mono">\${fmtNum(r.vwap_5m)}</td>
          <td class="right mono">\${fmtInt(r.volume)}</td>
          <td class="right mono">\${fmtNum(r.floatM)}</td>
          <td class="right mono">\${fmtNum(r.floatTurnoverPct)}%</td>
        </tr>\`;
      }).join("")}
    </tbody>
  </table>\`;
}

function haltsTable(rows){
  const top = rows.slice(0, 200);
  return \`
  <table>
    <thead><tr><th>Symbol</th><th>Time</th><th>Status</th></tr></thead>
    <tbody>
      \${top.map(x=>{
        const t = x.tsMs ? new Date(x.tsMs).toLocaleTimeString() : "-";
        const desc = x.halted ? "HALT" : "RESUME";
        return \`<tr><td class="mono">\${x.symbol||""}</td><td class="mono">\${t}</td><td>\${desc}</td></tr>\`;
      }).join("")}
    </tbody>
  </table>\`;
}

function renderRoller(symbols){
  const list = String(symbols||"")
    .replace(/\\n/g,",")
    .split(",")
    .map(s=>s.trim().toUpperCase())
    .filter(Boolean);

  roller.innerHTML = list.slice(0, 2000).map(sym => {
    const safe = sym.replace(/'/g,"");
    return \`<div class="chip" data-sym="\${safe}">\${safe} <small>hover</small></div>\`;
  }).join("");

  roller.querySelectorAll(".chip").forEach(ch => {
    const sym = ch.getAttribute("data-sym");
    ch.addEventListener("mouseenter",(ev)=>{
      clearTimeout(hoverTimer);
      hoverTimer=setTimeout(()=>showMini(ev, sym),120);
    });
    ch.addEventListener("mousemove",(ev)=>{
      if (miniBox && miniBox.style.display==="block") posMini(ev);
    });
    ch.addEventListener("mouseleave",()=>{
      clearTimeout(hoverTimer);
      hideMini();
    });
    ch.addEventListener("click",()=> window.open(tvUrlFor(sym), "_blank", "noopener,noreferrer"));
  });
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
      body.innerHTML = "<div style='padding:10px;color:#ffb4b4;font-size:12px;'>"+(JSON.stringify(j).slice(0,900))+"</div>";
      return;
    }

    meta.textContent = (j.results?.length ?? j.count ?? 0) + " rows • " + new Date().toLocaleTimeString();

    if (sec.type==="halts"){
      const rows = Array.isArray(j.results) ? j.results : [];
      body.innerHTML = haltsTable(rows);
    } else {
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

// ===== Apply changes (symbols + max) =====
function applyImportant(){
  const input = byId("symbols");
  const maxInput = byId("maxSymbols");

  importantSymbols = String(input.value||"").trim();
  scanMax = Number(maxInput.value || 200);
  if (!Number.isFinite(scanMax)) scanMax = 200;
  scanMax = Math.max(20, Math.min(${hardMax}, Math.floor(scanMax)));

  maxInput.value = String(scanMax);
  renderRoller(importantSymbols);

  const sec = SECTIONS.find(s=>s.id==="important");
  if (!sec) return;

  sec.url = "/scan?symbols=" + encodeURIComponent(importantSymbols) + "&max=" + encodeURIComponent(scanMax);
  loadSection(sec);

  statusPill.textContent = "Updated";
  setTimeout(()=>statusPill.textContent="Dashboard", 900);
}

(function bindControls(){
  const input = byId("symbols");
  const maxInput = byId("maxSymbols");
  const btnApply = byId("btnApply");
  const btnClear = byId("btnClear");
  const maxUp = byId("maxUp");
  const maxDown = byId("maxDown");

  renderRoller(importantSymbols);

  btnApply.addEventListener("click", applyImportant);

  btnClear.addEventListener("click", ()=>{
    input.value = "";
    input.focus();
    renderRoller("");
    statusPill.textContent = "Cleared";
    setTimeout(()=>statusPill.textContent="Dashboard", 600);
  });

  input.addEventListener("keydown",(e)=>{
    if (e.key === "Enter") applyImportant();
  });

  const step = 20;

  maxUp.addEventListener("click", ()=>{
    let v = Number(maxInput.value || 200);
    if (!Number.isFinite(v)) v = 200;
    v = Math.min(${hardMax}, v + step);
    maxInput.value = String(v);
    applyImportant();
  });

  maxDown.addEventListener("click", ()=>{
    let v = Number(maxInput.value || 200);
    if (!Number.isFinite(v)) v = 200;
    v = Math.max(20, v - step);
    maxInput.value = String(v);
    applyImportant();
  });

  maxInput.addEventListener("change", ()=>{
    applyImportant();
  });
})();

// init
renderGrid();
loadAll();
renderRoller(importantSymbols);

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
// SECTION 14 — Start WebSockets + Listen
// ============================================================================
startHaltWebSocket();
startAMWebSocket();

app.listen(PORT, () => {
  const base = `http://localhost:${PORT}`;
  console.log(`\n✅ ${BRAND.legal} running`);
  console.log(`🚀 UI: ${base}/ui`);
  console.log(`📈 Mini chart: ${base}/mini-chart?symbol=AAPL&tf=1`);
  console.log(`⛔ Halts: ${base}/halts`);
  console.log(`📌 Movers Premarket: ${base}/movers-premarket?limit=50`);
  console.log(`📌 Movers After-hours: ${base}/movers-afterhours?limit=50`);
  console.log(`ℹ️ API: ${base}/api`);
  console.log("");
});
