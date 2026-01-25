/**
 * ============================================================================
 * 🔥 ALGTP™ – Smart Market Scanner (Massive v2)
 * Focus: Premarket / After-hours + Small-cap signals + Daytrade core
 * ----------------------------------------------------------------------------
 * Single-file Node.js server (CommonJS)
 *
 * UI:
 *  - /ui (Dashboard) + tabs
 *  - /ui/gainers /ui/losers /ui/gappers
 *  - /ui/smallcap /ui/midcap /ui/bigcap
 *  - /ui/premarket /ui/afterhours  (Snapshot-All v2 required)
 *
 * API:
 *  - /list?group=gainers|losers|gappers&cap=all|small|mid|big&limit=80
 *  - /top-movers?direction=all|gainers|losers&cap=...&limit=80&sort=score|abs|price|gap
 *  - /scan?symbols=NVDA,TSLA,AAPL
 *  - /premarket?cap=...&limit=80&sort=score
 *  - /afterhours?cap=...&limit=80&sort=score
 *  - /snapshot-all?cap=...&limit=80&sort=score   (optional)
 *  - /help
 *
 * ENV minimum:
 *  - PORT=3000
 *  - MASSIVE_API_KEY=...
 *  - MASSIVE_AUTH_TYPE=query|xapi|bearer
 *  - MASSIVE_QUERY_KEYNAME=apiKey
 *  - MASSIVE_MOVER_URL=https://api.massive.com/v2/snapshot/locale/us/markets/stocks
 *  - MASSIVE_TICKER_SNAPSHOT_URL=https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers
 *
 * ENV pro (Snapshot-All v2):
 *  - MASSIVE_SNAPSHOT_ALL_URL=https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers
 *  - ENABLE_SNAPSHOT_ALL=false|true
 *
 * Other:
 *  - INCLUDE_OTC=false|true
 *  - SNAP_CONCURRENCY=4
 *  - DEBUG=true|false
 *
 * Disclaimer:
 *  - DISCLAIMER_MODE=simple|pro
 *  - DISCLAIMER_TTL_DAYS=7
 *  - DISCLAIMER_AUTO_CLOSE_MS=5000
 * ============================================================================
 */

// ============================================================================
// SECTION 00 — Brand
// ============================================================================
const BRAND = {
  mark: "🔥",
  name: "ALGTP™",
  legal: "ALGTP™ – Algorithmic Trading Platform",
  subtitle: "Smart Market Scanner (Massive v2)",
  watermark: "Powered by ALGTP™",
};

// ============================================================================
// SECTION 01 — Imports + App Boot
// ============================================================================
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ============================================================================
// SECTION 02 — ENV
// ============================================================================
const PORT = Number(process.env.PORT || 3000);

const MASSIVE_API_KEY = String(process.env.MASSIVE_API_KEY || "").trim();
const MASSIVE_AUTH_TYPE = String(process.env.MASSIVE_AUTH_TYPE || "query").trim(); // query|xapi|bearer
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

const INCLUDE_OTC = String(process.env.INCLUDE_OTC || "false").toLowerCase() === "true";
const SNAP_CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.SNAP_CONCURRENCY || 4)));
const DEBUG = String(process.env.DEBUG || "true").toLowerCase() === "true";

// Disclaimer
const DISCLAIMER_MODE = String(process.env.DISCLAIMER_MODE || "simple").toLowerCase(); // simple|pro
const DISCLAIMER_TTL_DAYS = Math.max(1, Math.min(365, Number(process.env.DISCLAIMER_TTL_DAYS || 7)));
const DISCLAIMER_AUTO_CLOSE_MS = Math.max(1000, Math.min(30000, Number(process.env.DISCLAIMER_AUTO_CLOSE_MS || 5000)));

// Fail-fast core env
if (!MASSIVE_API_KEY || !MASSIVE_MOVER_URL || !MASSIVE_TICKER_SNAPSHOT_URL) {
  console.error("❌ Missing ENV. Required:");
  console.error(" - MASSIVE_API_KEY");
  console.error(" - MASSIVE_MOVER_URL");
  console.error(" - MASSIVE_TICKER_SNAPSHOT_URL");
  process.exit(1);
}

// ============================================================================
// SECTION 03 — Helpers
// ============================================================================
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}
function n(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}
function round2(x) {
  const v = n(x);
  return v === null ? null : Number(v.toFixed(2));
}
function parseSymbols(input) {
  return String(input || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 200);
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

function axiosFail(e) {
  if (!e || !e.isAxiosError) return { kind: "unknown", message: String(e?.message || e) };
  const code = e.code || null;
  const url = e.config?.url || null;
  if (!e.response) return { kind: "network", code, message: e.message || "network", url };
  const status = e.response.status;
  const data = e.response.data;
  const bodyPreview = typeof data === "string" ? data.slice(0, 800) : JSON.stringify(data).slice(0, 800);
  return { kind: "http", status, message: e.message || "http", url, bodyPreview };
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
// SECTION 04 — Massive v2 Sources
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

  return { ok: r.ok && Array.isArray(rows), url, status: r.status, rows: Array.isArray(rows) ? rows : [], errorDetail: r.errorDetail };
}

async function fetchTickerSnapshot(symbol) {
  const base = MASSIVE_TICKER_SNAPSHOT_URL.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(String(symbol || "").trim().toUpperCase())}`;
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

  return { ok: r.ok && Array.isArray(rows), url, status: r.status, rows: Array.isArray(rows) ? rows : [], errorDetail: r.errorDetail };
}

// ============================================================================
// SECTION 05 — Normalize + Buckets + Signals
// ============================================================================
function capBucket(marketCap) {
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

function normalizeSnapshot(symbol, snap) {
  const root = snap?.results ?? snap ?? {};
  const day = root?.day ?? root?.today ?? root?.todays ?? {};
  const prev = root?.prevDay ?? root?.previousDay ?? root?.prev ?? {};

  const price =
    n(root?.lastTrade?.p) ??
    n(root?.lastTrade?.price) ??
    n(day?.c ?? day?.close) ??
    n(root?.price) ??
    null;

  const open = n(day?.o ?? day?.open) ?? null;
  const volume = n(day?.v ?? day?.volume ?? root?.volume) ?? null;

  const prevClose = n(prev?.c ?? prev?.close ?? root?.prevClose) ?? null;

  const pricePct =
    price !== null && prevClose !== null && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null;

  const gapPct =
    open !== null && prevClose !== null && prevClose > 0 ? ((open - prevClose) / prevClose) * 100 : null;

  const floatShares =
    n(root?.float) ??
    n(root?.freeFloat) ??
    n(root?.sharesFloat) ??
    n(root?.floatShares) ??
    null;

  const marketCapApi =
    n(root?.marketCap) ??
    n(root?.marketcap) ??
    n(root?.mktcap) ??
    n(root?.market_cap) ??
    null;

  const marketCapEst = marketCapApi === null && price !== null && floatShares !== null ? price * floatShares : null;
  const marketCap = marketCapApi ?? marketCapEst;

  const vf = volume !== null && floatShares !== null && floatShares > 0 ? volume / floatShares : null;
  const tier = volFloatTier(vf);

  return {
    symbol: String(symbol || "").trim().toUpperCase(),
    price: price !== null ? round2(price) : null,
    pricePct: pricePct !== null ? round2(pricePct) : null,
    gapPct: gapPct !== null ? round2(gapPct) : null,
    volume: volume !== null ? Math.round(volume) : null,

    floatShares: floatShares !== null ? Math.round(floatShares) : null,
    floatM: floatShares !== null ? round2(floatShares / 1_000_000) : null,
    floatCat: floatCategory(floatShares),

    marketCap: marketCap !== null ? Math.round(marketCap) : null,
    marketCapB: marketCap !== null ? round2(marketCap / 1_000_000_000) : null,
    cap: capBucket(marketCap),

    volFloatX: vf !== null ? round2(vf) : null,
    volFloatIcon: tier.icon,
    volFloatLabel: tier.label,
    marketCapSource: marketCapApi !== null ? "api" : marketCapEst !== null ? "est_float" : null,
  };
}

// timestamp/session for snapshot-all filtering (Pre/After)
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
function snapshotTs(rawSnap) {
  const t = rawSnap?.lastTrade?.t ?? rawSnap?.lastQuote?.t ?? rawSnap?.updated ?? rawSnap?.timestamp ?? null;
  return toMs(t);
}
function addExtPct(row, rawSnap) {
  const prevClose = n(rawSnap?.prevDay?.c ?? rawSnap?.prevDay?.close ?? rawSnap?.prevClose) ?? null;
  const price = n(row?.price) ?? null;
  const extPct = price !== null && prevClose !== null && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null;
  return { ...row, extPct: extPct !== null ? round2(extPct) : null };
}

// Small-cap signal scoring (simple, ổn định)
function demandScore(row) {
  const gap = Math.abs(n(row?.gapPct) ?? 0);
  const pc = Math.abs(n(row?.pricePct) ?? 0);
  const ext = Math.abs(n(row?.extPct) ?? 0);
  const vf = n(row?.volFloatX) ?? 0;

  let s = 0;
  if (vf >= 1.5) s += 1;
  if (vf >= 3) s += 1;
  if (vf >= 5) s += 1;

  if (gap >= 10) s += 1;
  if (gap >= 20) s += 1;

  if (pc >= 10) s += 1;
  if (pc >= 20) s += 1;

  if (ext >= 10) s += 1;
  if (ext >= 20) s += 1;

  return clamp(s, 0, 9);
}
function signalIcon(score) {
  if (score >= 8) return "🚀";
  if (score >= 6) return "🔥";
  if (score >= 4) return "👀";
  return "⛔";
}

function capPass(row, cap) {
  const c = String(cap || "all").toLowerCase();
  if (c === "all") return true;
  if (!row.cap) return false;
  return row.cap === c;
}

// server-side filters (optional)
function toNumQ(v) {
  const x = Number(String(v ?? "").trim());
  return Number.isFinite(x) ? x : null;
}
function applyFilters(rows, q) {
  const minPrice = toNumQ(q.minPrice);
  const maxPrice = toNumQ(q.maxPrice);
  const minVol = toNumQ(q.minVol);
  const minVF = toNumQ(q.minVF);
  const maxCapB = toNumQ(q.maxCapB);
  const maxFloatM = toNumQ(q.maxFloatM);

  return rows.filter((r) => {
    const price = n(r.price);
    const vol = n(r.volume);
    const vf = n(r.volFloatX);
    const capB = n(r.marketCapB);
    const floatM = n(r.floatM);

    if (minPrice !== null && (price === null || price < minPrice)) return false;
    if (maxPrice !== null && (price === null || price > maxPrice)) return false;
    if (minVol !== null && (vol === null || vol < minVol)) return false;
    if (minVF !== null && (vf === null || vf < minVF)) return false;
    if (maxCapB !== null && (capB === null || capB > maxCapB)) return false;
    if (maxFloatM !== null && (floatM === null || floatM > maxFloatM)) return false;
    return true;
  });
}

function finalizeRows(rows) {
  return rows.map((r) => {
    const s = demandScore(r);
    return { ...r, demandScore: s, signalIcon: signalIcon(s) };
  });
}

function sortByMode(rows, sort) {
  const s = String(sort || "score").toLowerCase();
  if (s === "gap") rows.sort((a, b) => Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0));
  else if (s === "price") rows.sort((a, b) => Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0));
  else if (s === "abs") rows.sort((a, b) => Math.abs(b.extPct ?? b.pricePct ?? 0) - Math.abs(a.extPct ?? a.pricePct ?? 0));
  else rows.sort((a, b) => (b.demandScore ?? 0) - (a.demandScore ?? 0));
}

// ============================================================================
// SECTION 06 — Builders
// ============================================================================
async function buildFromMovers({ group, cap, limit, query }) {
  const lim = clamp(Number(limit || 50), 5, 200);

  // movers direction
  const dir = group === "losers" ? "losers" : "gainers";
  const mv = await fetchMovers(dir);
  if (!mv.ok) {
    return { ok: false, status: 500, body: { ok: false, error: "Movers failed", debug: mv } };
  }

  const symbols = mv.rows
    .map((x) => String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase())
    .filter(Boolean)
    .slice(0, lim);

  const snaps = await mapPool(symbols, SNAP_CONCURRENCY, async (t) => {
    const r = await fetchTickerSnapshot(t);
    return { ticker: t, ...r };
  });

  const good = snaps.filter((x) => x.ok);
  const bad = snaps.filter((x) => !x.ok);

  let rows = good.map((x) => normalizeSnapshot(x.ticker, x.data));
  rows = rows.filter((r) => capPass(r, cap));

  if (group === "gappers") {
    // gappers = sort by |gap|, still use movers list but gap sort
    rows.sort((a, b) => Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0));
  } else {
    rows.sort((a, b) => Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0));
  }

  rows = applyFilters(rows, query || {});
  rows = finalizeRows(rows);

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      source: "movers",
      group,
      cap,
      limitRequested: lim,
      results: rows,
      snapshotErrors: DEBUG ? bad.slice(0, 10).map((x) => ({ ticker: x.ticker, status: x.status, url: x.url, errorDetail: x.errorDetail })) : undefined,
    },
  };
}

async function buildTopMovers({ direction, cap, limit, sort, query }) {
  const lim = clamp(Number(limit || 80), 5, 200);
  const dir = String(direction || "all").toLowerCase();

  let tickers = [];
  if (dir === "gainers" || dir === "losers") {
    const mv = await fetchMovers(dir);
    if (!mv.ok) return { ok: false, status: 500, body: { ok: false, error: "Movers failed", debug: mv } };
    tickers = mv.rows
      .map((x) => String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase())
      .filter(Boolean)
      .slice(0, lim);
  } else {
    const [g, l] = await Promise.all([fetchMovers("gainers"), fetchMovers("losers")]);
    if (!g.ok || !l.ok) return { ok: false, status: 500, body: { ok: false, error: "Movers failed", debug: { gainers: g, losers: l } } };
    const mix = [
      ...g.rows.slice(0, lim).map((x) => String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase()),
      ...l.rows.slice(0, lim).map((x) => String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase()),
    ].filter(Boolean);
    tickers = Array.from(new Set(mix)).slice(0, lim);
  }

  const snaps = await mapPool(tickers, SNAP_CONCURRENCY, async (t) => {
    const r = await fetchTickerSnapshot(t);
    return { ticker: t, ...r };
  });

  const good = snaps.filter((x) => x.ok);
  const bad = snaps.filter((x) => !x.ok);

  let rows = good.map((x) => normalizeSnapshot(x.ticker, x.data));
  rows = rows.filter((r) => capPass(r, cap));

  rows = applyFilters(rows, query || {});
  rows = finalizeRows(rows);
  sortByMode(rows, sort);
  rows = rows.slice(0, lim);

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      source: "top-movers",
      direction: dir,
      cap,
      sort: sort || "score",
      limitRequested: lim,
      results: rows,
      snapshotErrors: DEBUG ? bad.slice(0, 10).map((x) => ({ ticker: x.ticker, status: x.status, url: x.url, errorDetail: x.errorDetail })) : undefined,
    },
  };
}

async function buildScanSymbols({ symbols, query }) {
  const syms = parseSymbols(symbols).slice(0, 100);
  if (!syms.length) return { ok: false, status: 400, body: { ok: false, error: "No symbols provided" } };

  const snaps = await mapPool(syms, SNAP_CONCURRENCY, async (t) => {
    const r = await fetchTickerSnapshot(t);
    return { ticker: t, ...r };
  });

  const good = snaps.filter((x) => x.ok);
  const bad = snaps.filter((x) => !x.ok);

  let rows = good.map((x) => normalizeSnapshot(x.ticker, x.data));
  rows = applyFilters(rows, query || {});
  rows = finalizeRows(rows);
  rows.sort((a, b) => (b.demandScore ?? 0) - (a.demandScore ?? 0) || Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0));

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      source: "scan",
      results: rows,
      snapshotErrors: DEBUG ? bad.slice(0, 10).map((x) => ({ ticker: x.ticker, status: x.status, url: x.url, errorDetail: x.errorDetail })) : undefined,
    },
  };
}

function keepTopKByScore(items, k, scoreFn) {
  const out = [];
  for (const it of items) {
    out.push(it);
    out.sort((a, b) => scoreFn(b) - scoreFn(a));
    if (out.length > k) out.pop();
  }
  return out;
}

async function buildFromSnapshotAll({ session, cap, limit, sort, query }) {
  if (!ENABLE_SNAPSHOT_ALL) {
    return {
      ok: false,
      status: 403,
      body: { ok: false, error: "Snapshot-All is disabled", hint: "Set ENABLE_SNAPSHOT_ALL=true to enable /premarket /afterhours /snapshot-all." },
    };
  }

  const lim = clamp(Number(limit || 80), 5, 500);
  const snap = await fetchSnapshotAll();
  if (!snap.ok) {
    return { ok: false, status: 500, body: { ok: false, error: "Snapshot-all failed", debug: snap } };
  }

  // Build a map symbol -> raw snap
  const snapMap = new Map();
  for (const x of snap.rows) {
    const t = String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase();
    if (t) snapMap.set(t, x);
  }

  // We do "top-K selection" to avoid sorting the entire market every time.
  const wantK = Math.max(lim * 6, 600); // keep more candidates then final slice
  let candidates = [];

  for (const [ticker, raw] of snapMap.entries()) {
    const ms = snapshotTs(raw);
    if (!ms) continue;

    const sess = sessionOfMs(ms);
    if (session && sess !== session) continue;

    let row = normalizeSnapshot(ticker, raw);
    row = addExtPct(row, raw);
    if (!capPass(row, cap)) continue;

    candidates.push(row);
    if (candidates.length >= wantK) break; // limit scanning for speed
  }

  candidates = applyFilters(candidates, query || {});
  candidates = finalizeRows(candidates);

  // score preference for pre/after
  const scoreFn = (r) => (r.demandScore ?? 0) * 10 + Math.abs(r.extPct ?? 0) * 2 + Math.abs(r.pricePct ?? 0) + Math.log10((r.volume ?? 0) + 1);
  candidates = keepTopKByScore(candidates, Math.max(lim * 3, 200), scoreFn);

  sortByMode(candidates, sort || "score");
  candidates = candidates.slice(0, lim);

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      source: "snapshot-all",
      session: session || null,
      cap,
      sort: sort || "score",
      limitRequested: lim,
      results: candidates,
    },
  };
}

// ============================================================================
// SECTION 07 — UI (HTML)
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
    `${BRAND.name} cung cấp dữ liệu thị trường cho mục đích tham khảo/giáo dục.`,
    `Không cấu thành tư vấn đầu tư hay khuyến nghị mua/bán.`,
    `Dữ liệu phụ thuộc bên thứ ba nên có thể trễ, thiếu hoặc sai.`,
    `Giao dịch có rủi ro cao và có thể mất toàn bộ vốn.`,
    `Bạn chịu trách nhiệm hoàn toàn cho mọi quyết định và rủi ro phát sinh.`,
  ];
  const proEN = [
    `${BRAND.name} provides market data for informational/educational purposes only.`,
    `Nothing presented constitutes investment advice.`,
    `Data may be delayed or inaccurate due to third-party sources.`,
    `Trading involves significant risk, including total loss of capital.`,
    `You assume full responsibility for all trading decisions and outcomes.`,
  ];

  const title = DISCLAIMER_MODE === "pro" ? proTitle : simpleTitle;
  const bullets = DISCLAIMER_MODE === "pro" ? { vn: proVN, en: proEN } : { vn: simpleVN, en: simpleEN };
  return { title, bullets };
}

function renderUI(preset = {}) {
  const disc = disclaimerContent();
  const P = {
    path: preset.path || "/ui",
    title: preset.title || "Dashboard",
    mode: preset.mode || "list", // list|top-movers|scan|premarket|afterhours|snapshotall
    group: preset.group || "gainers",
    direction: preset.direction || "all",
    cap: preset.cap || "all",
    limit: preset.limit || 80,
    sort: preset.sort || "score",
  };

  const nav = [
    { href: "/ui", k: "dash", label: "Dashboard" },
    { href: "/ui/gainers", k: "gainers", label: "Gainers" },
    { href: "/ui/losers", k: "losers", label: "Losers" },
    { href: "/ui/gappers", k: "gappers", label: "Gappers" },
    { href: "/ui/smallcap", k: "smallcap", label: "Small Cap" },
    { href: "/ui/midcap", k: "midcap", label: "Mid Cap" },
    { href: "/ui/bigcap", k: "bigcap", label: "Big Cap" },
    { href: "/ui/top-movers", k: "topm", label: "Top Movers" },
    { href: "/ui/premarket", k: "pre", label: "Pre-Market" },
    { href: "/ui/afterhours", k: "after", label: "After-Hours" },
    { href: "/help", k: "help", label: "Help" },
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${BRAND.name} | ${BRAND.legal}</title>
<style>
:root{ color-scheme: dark; }
body{ margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b0d12; color:#e6e8ef; }
.wrap{ max-width:1400px; margin:0 auto; padding:0 16px; }
header{ position:sticky; top:0; background:rgba(11,13,18,.92); backdrop-filter: blur(10px); border-bottom:1px solid rgba(255,255,255,.08); z-index:20; }
.brandRow{ display:flex; align-items:center; justify-content:space-between; gap:10px; padding:14px 0; }
.brandTitle{ display:flex; align-items:center; gap:10px; }
.brandMark{ font-size:18px; }
.brandName{ font-weight:900; font-size:14px; letter-spacing:.3px; }
.brandSub{ font-size:12px; color:#a7adc2; margin-top:3px; }
.pill{ font-size:12px; padding:6px 10px; border-radius:999px; background:#121622; border:1px solid rgba(255,255,255,.12); color:#c8cde0; white-space:nowrap; }

.nav{ display:flex; gap:10px; flex-wrap:wrap; padding-bottom:14px; }
.nav a{ text-decoration:none; color:#c8cde0; background:#121622; border:1px solid rgba(255,255,255,.12); padding:8px 10px; border-radius:999px; font-size:12px; opacity:.70; }
.nav a.active{ opacity:1; border-color: rgba(255,255,255,.22); }
.nav a:hover{ opacity:1; }

.panel{ border-bottom:1px solid rgba(255,255,255,.06); padding:14px 0; }
.row{ display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
select,input,button{ background:#121622; border:1px solid rgba(255,255,255,.12); color:#e6e8ef; border-radius:12px; padding:9px 10px; font-size:13px; outline:none; }
button{ cursor:pointer; }
button:hover{ border-color: rgba(255,255,255,.22); }
.hint{ font-size:12px; color:#a7adc2; margin-top:10px; line-height:1.4; }

.card{ border:1px solid rgba(255,255,255,.10); border-radius:14px; overflow:hidden; margin:16px 0; }
.cardHead{ background:#121622; border-bottom:1px solid rgba(255,255,255,.08); padding:10px 12px; display:flex; align-items:center; justify-content:space-between; gap:10px;}
.title{ font-size:13px; font-weight:900; }
.meta{ font-size:12px; color:#a7adc2; }

table{ width:100%; border-collapse:collapse; }
th,td{ padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.06); font-size:13px; }
th{ text-align:left; color:#a7adc2; font-weight:700; position:sticky; top:0; background:#0b0d12; z-index:5; }
tr:hover td{ background: rgba(255,255,255,.03); }
.right{ text-align:right; }
.mono{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.symLink{ color:#e6e8ef; text-decoration:none; border-bottom:1px dashed rgba(255,255,255,.25); cursor:pointer; }
.symLink:hover{ border-bottom-color: rgba(255,255,255,.55); }

.err{ white-space:pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size:12px; color:#ffb4b4; background:#1a0f12; border:1px solid rgba(255,128,128,.25); border-radius:12px; padding:10px 12px; margin-top:12px; display:none; }

.watermark{ position: fixed; bottom: 12px; right: 16px; font-size: 11px; color: rgba(230,232,239,.35); letter-spacing: .3px; pointer-events:none; user-select:none; z-index:9999; }

.modalBack{ position:fixed; inset:0; background: rgba(0,0,0,.65); display:none; align-items:center; justify-content:center; z-index:60; }
.modal{ width:min(1100px, 94vw); height:min(720px, 88vh); background:#0b0d12; border:1px solid rgba(255,255,255,.16); border-radius:16px; overflow:hidden; box-shadow: 0 18px 70px rgba(0,0,0,.55); }
.modalTop{ display:flex; gap:10px; align-items:center; justify-content:space-between; padding:10px 12px; background:#121622; border-bottom:1px solid rgba(255,255,255,.10); }
.modalTitle{ font-weight:900; font-size:13px; }
.modalClose{ cursor:pointer; border:1px solid rgba(255,255,255,.18); background:#121622; color:#e6e8ef; border-radius:10px; padding:8px 10px; }
.modalClose:hover{ border-color: rgba(255,255,255,.28); }
.chartBox{ width:100%; height: calc(100% - 52px); }
.chartBox iframe{ width:100%; height:100%; border:0; }

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
.banner{ margin-top:10px; padding:10px 12px; border:1px solid rgba(255,180,180,.25); background:#1a0f12; border-radius:12px; color:#ffb4b4; font-size:12px; display:none; }
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
        <div class="brandSub">${BRAND.subtitle} • Premarket/After-hours • Small-cap signals • Vol/Float tiers</div>
      </div>
      <div class="pill">${P.title}</div>
    </div>

    <div class="nav">
      ${nav.map(x => `<a href="${x.href}" class="${x.href === P.path ? "active" : ""}">${x.label}</a>`).join("")}
    </div>
  </div>
</header>

<div class="panel">
  <div class="wrap">
    <div class="row">
      <select id="cap">
        <option value="all">Cap: All</option>
        <option value="small">Cap: Small (&lt;2B)</option>
        <option value="mid">Cap: Mid (2B–10B)</option>
        <option value="big">Cap: Big (&gt;10B)</option>
      </select>

      <select id="limit">
        <option>20</option><option>30</option><option>50</option><option selected>80</option><option>100</option><option>150</option><option>200</option>
      </select>

      <select id="sort">
        <option value="score" selected>Sort: Score</option>
        <option value="abs">Sort: Abs Move</option>
        <option value="price">Sort: Price%</option>
        <option value="gap">Sort: Gap%</option>
      </select>

      <input id="symbols" placeholder="Symbols (for /scan): NVDA,TSLA,AAPL" style="min-width:320px; flex:1;" />
      <input id="minPrice" placeholder="minPrice" style="min-width:120px;" />
      <input id="maxPrice" placeholder="maxPrice" style="min-width:120px;" />
      <input id="minVol" placeholder="minVol" style="min-width:130px;" />
      <input id="minVF" placeholder="minVF (Vol/Float)" style="min-width:160px;" />
      <input id="maxCapB" placeholder="maxCap(B)" style="min-width:140px;" />
      <input id="maxFloatM" placeholder="maxFloat(M)" style="min-width:160px;" />

      <button id="runBtn">Run</button>
      <span class="pill" id="status">Idle</span>
    </div>

    <div class="banner" id="snapBanner">⚠️ Snapshot-All OFF → /premarket & /afterhours sẽ không chạy. Bật ENABLE_SNAPSHOT_ALL=true trong .env</div>

    <div class="hint">
      Icons: 🚀/🔥/👀 dựa trên Score (Vol/Float + %move + gap + ext%). Click ticker → chart modal. Ctrl/Cmd+Click → mở tab TradingView.
    </div>

    <div class="err" id="errBox"></div>
  </div>
</div>

<div class="wrap">
  <div id="out"></div>
</div>

<div class="watermark">${BRAND.watermark}</div>

<!-- Chart Modal -->
<div class="modalBack" id="modalBack" aria-hidden="true">
  <div class="modal" role="dialog" aria-modal="true">
    <div class="modalTop">
      <div class="modalTitle" id="modalTitle">${BRAND.mark} ${BRAND.name} Chart</div>
      <button class="modalClose" id="closeBtn">Close</button>
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
      <div style="font-weight:900; margin-bottom:6px;">${BRAND.legal}</div>
      <div style="color:#a7adc2; font-size:12px;">${BRAND.subtitle} • Data may be delayed • Use at your own risk</div>
      <div style="margin-top:10px; font-weight:900;">VI</div>
      <ul>${disc.bullets.vn.map((x) => `<li>${x}</li>`).join("")}</ul>
      <div style="margin-top:10px; font-weight:900;">EN</div>
      <ul>${disc.bullets.en.map((x) => `<li>${x}</li>`).join("")}</ul>
    </div>
    <div class="discFoot">
      <label class="discNote"><input id="discDontShow" type="checkbox" /> Don’t show again (${DISCLAIMER_TTL_DAYS} days)</label>
      <div class="discNote">Auto close in ${Math.round(DISCLAIMER_AUTO_CLOSE_MS / 1000)}s</div>
    </div>
  </div>
</div>

<script>
const PRESET = ${JSON.stringify(P)};
const SNAPSHOT_ALL_ENABLED = ${JSON.stringify(ENABLE_SNAPSHOT_ALL)};

const byId = (id)=>document.getElementById(id);
const out = byId("out");
const errBox = byId("errBox");
const statusEl = byId("status");
const banner = byId("snapBanner");

function setStatus(t){ statusEl.textContent = t; }
function showError(obj){
  errBox.style.display="block";
  errBox.textContent = typeof obj==="string" ? obj : JSON.stringify(obj,null,2);
}
function clearError(){ errBox.style.display="none"; errBox.textContent=""; }

function fmtNum(x, d=2){
  if (x===null || x===undefined) return "-";
  const nn = Number(x);
  if (!Number.isFinite(nn)) return "-";
  return nn.toFixed(d);
}
function fmtInt(x){
  if (x===null || x===undefined) return "-";
  const nn = Number(x);
  if (!Number.isFinite(nn)) return "-";
  return Math.round(nn).toLocaleString();
}

function tvUrl(symbol, tf){
  const sym = encodeURIComponent("NASDAQ:"+symbol);
  const interval = encodeURIComponent(String(tf || "5"));
  const tz = encodeURIComponent("America/New_York");
  return "https://s.tradingview.com/widgetembed/"+
    "?symbol="+sym+
    "&interval="+interval+
    "&hidesidetoolbar=0&symboledit=1&toolbarbg=rgba(18,22,34,1)"+
    "&theme=dark&style=1&timezone="+tz+"&withdateranges=1&hideideas=1";
}

// Chart modal
const modalBack = byId("modalBack");
const modalTitle = byId("modalTitle");
const chartBox = byId("chartBox");
let currentSymbol = null;

function openModal(){ modalBack.style.display="flex"; modalBack.setAttribute("aria-hidden","false"); }
function closeModal(){ modalBack.style.display="none"; modalBack.setAttribute("aria-hidden","true"); chartBox.innerHTML=""; currentSymbol=null; }

window.handleTickerClick = function(ev, sym){
  const modifier = ev && (ev.ctrlKey || ev.metaKey);
  const tf = "5";

  if (modifier){
    const url = "https://www.tradingview.com/chart/?symbol="+encodeURIComponent("NASDAQ:"+sym)+"&interval="+encodeURIComponent(tf);
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  currentSymbol = sym;
  modalTitle.textContent = "${BRAND.mark} ${BRAND.name} Chart — " + sym;
  openModal();
  chartBox.innerHTML = '<iframe loading="lazy" src="'+tvUrl(sym, tf)+'"></iframe>';
};
byId("closeBtn").addEventListener("click", closeModal);
modalBack.addEventListener("click",(e)=>{ if(e.target===modalBack) closeModal(); });
document.addEventListener("keydown",(e)=>{ if(e.key==="Escape") closeModal(); });

function addParam(u,k,v){
  if (!v) return u;
  return u + (u.includes("?") ? "&" : "?") + encodeURIComponent(k) + "=" + encodeURIComponent(v);
}
function applyFiltersToUrl(url){
  url = addParam(url, "minPrice", byId("minPrice").value.trim());
  url = addParam(url, "maxPrice", byId("maxPrice").value.trim());
  url = addParam(url, "minVol", byId("minVol").value.trim());
  url = addParam(url, "minVF", byId("minVF").value.trim());
  url = addParam(url, "maxCapB", byId("maxCapB").value.trim());
  url = addParam(url, "maxFloatM", byId("maxFloatM").value.trim());
  return url;
}

function renderTable(data){
  const rows = Array.isArray(data.results) ? data.results : [];
  const meta = (data.source||"scan") + (data.session ? (" • session="+data.session) : "") + " • " + rows.length + " rows";

  out.innerHTML = \`
  <div class="card">
    <div class="cardHead">
      <div class="title">${BRAND.mark} ${BRAND.name} — \${PRESET.title}</div>
      <div class="meta">\${meta}</div>
    </div>
    <div style="overflow:auto;">
    <table>
      <thead><tr>
        <th>Sig</th>
        <th>Symbol</th>
        <th class="right">Price</th>
        <th class="right">Price%</th>
        <th class="right">Ext%</th>
        <th class="right">Gap%</th>
        <th class="right">Vol</th>
        <th class="right">Vol/Float</th>
        <th class="right">Float(M)</th>
        <th class="right">MCap(B)</th>
        <th>Cap</th>
        <th class="right">Score</th>
      </tr></thead>
      <tbody>
      \${rows.map(r=>{
        const sym = String(r.symbol||"");
        const safe = sym.replace(/'/g,"");
        const vf = (r.volFloatX!=null && Number(r.volFloatX)>=1.5) ? ((r.volFloatIcon||"")+" "+fmtNum(r.volFloatX,2)+"x") : "-";
        return \`
          <tr>
            <td>\${(r.signalIcon||"")}</td>
            <td class="mono"><a class="symLink" href="javascript:void(0)" onclick="handleTickerClick(event,'\${safe}')">\${sym}</a></td>
            <td class="right mono">\${fmtNum(r.price)}</td>
            <td class="right mono">\${fmtNum(r.pricePct)}%</td>
            <td class="right mono">\${fmtNum(r.extPct)}%</td>
            <td class="right mono">\${fmtNum(r.gapPct)}%</td>
            <td class="right mono">\${fmtInt(r.volume)}</td>
            <td class="right mono">\${vf}</td>
            <td class="right mono">\${fmtNum(r.floatM)}</td>
            <td class="right mono">\${fmtNum(r.marketCapB)}</td>
            <td>\${r.cap || "-"}</td>
            <td class="right mono">\${r.demandScore ?? "-"}</td>
          </tr>\`;
      }).join("")}
      </tbody>
    </table>
    </div>
  </div>\`;
}

async function run(){
  clearError();
  out.innerHTML="";
  setStatus("Loading...");

  const cap = byId("cap").value;
  const limit = byId("limit").value;
  const sort = byId("sort").value;

  let url = "";
  if (PRESET.mode === "top-movers"){
    url = "/top-movers?direction="+encodeURIComponent(PRESET.direction||"all")+"&cap="+encodeURIComponent(cap)+"&limit="+encodeURIComponent(limit)+"&sort="+encodeURIComponent(sort);
  } else if (PRESET.mode === "scan"){
    const symbols = (byId("symbols").value || "NVDA,TSLA,AAPL").trim();
    url = "/scan?symbols="+encodeURIComponent(symbols);
  } else if (PRESET.mode === "premarket"){
    url = "/premarket?cap="+encodeURIComponent(cap)+"&limit="+encodeURIComponent(limit)+"&sort="+encodeURIComponent(sort);
  } else if (PRESET.mode === "afterhours"){
    url = "/afterhours?cap="+encodeURIComponent(cap)+"&limit="+encodeURIComponent(limit)+"&sort="+encodeURIComponent(sort);
  } else {
    url = "/list?group="+encodeURIComponent(PRESET.group||"gainers")+"&cap="+encodeURIComponent(cap)+"&limit="+encodeURIComponent(limit);
  }

  url = applyFiltersToUrl(url);

  try{
    const r = await fetch(url);
    const data = await r.json();
    if (!data.ok){
      setStatus("Error");
      showError(data);
      return;
    }
    setStatus("OK ("+(data.results?.length||0)+" rows)");
    renderTable(data);
  }catch(e){
    setStatus("Error");
    showError(String(e?.message||e));
  }
}

function setPreset(){
  byId("cap").value = PRESET.cap || "all";
  byId("limit").value = String(PRESET.limit || 80);
  byId("sort").value = String(PRESET.sort || "score");

  if (!SNAPSHOT_ALL_ENABLED && (PRESET.mode==="premarket" || PRESET.mode==="afterhours")) {
    banner.style.display = "block";
  }
}
byId("runBtn").addEventListener("click", run);

setPreset();
run();

// Disclaimer
const discBack=byId("discBack");
const discCloseBtn=byId("discCloseBtn");
const discDontShow=byId("discDontShow");
const DISC_KEY="algtp_disclaimer_until";

function showDisclaimer(){
  try{
    const until=Number(localStorage.getItem(DISC_KEY)||"0");
    if(Number.isFinite(until) && until>Date.now()) return;
  }catch(e){}
  discBack.style.display="flex";
  discBack.setAttribute("aria-hidden","false");
  setTimeout(()=>{ closeDisclaimer(); }, ${DISCLAIMER_AUTO_CLOSE_MS});
}
function closeDisclaimer(){
  if(!discBack || discBack.style.display==="none") return;
  try{
    if(discDontShow && discDontShow.checked){
      const until=Date.now()+(${DISCLAIMER_TTL_DAYS}*24*60*60*1000);
      localStorage.setItem(DISC_KEY,String(until));
    }
  }catch(e){}
  const disc = discBack.querySelector(".disc");
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
// SECTION 08 — UI Routes
// ============================================================================
app.get("/ui", (req, res) => res.type("html").send(renderUI({ path: "/ui", title: "Dashboard (Gainers)", mode: "list", group: "gainers", cap: "all", limit: 80 })));
app.get("/ui/gainers", (req, res) => res.type("html").send(renderUI({ path: "/ui/gainers", title: "Top Gainers", mode: "list", group: "gainers", cap: "all", limit: 80 })));
app.get("/ui/losers", (req, res) => res.type("html").send(renderUI({ path: "/ui/losers", title: "Top Losers", mode: "list", group: "losers", cap: "all", limit: 80 })));
app.get("/ui/gappers", (req, res) => res.type("html").send(renderUI({ path: "/ui/gappers", title: "Top Gappers", mode: "list", group: "gappers", cap: "all", limit: 120, sort: "gap" })));
app.get("/ui/smallcap", (req, res) => res.type("html").send(renderUI({ path: "/ui/smallcap", title: "Small Cap Signals", mode: "list", group: "gainers", cap: "small", limit: 120 })));
app.get("/ui/midcap", (req, res) => res.type("html").send(renderUI({ path: "/ui/midcap", title: "Mid Cap", mode: "list", group: "gainers", cap: "mid", limit: 120 })));
app.get("/ui/bigcap", (req, res) => res.type("html").send(renderUI({ path: "/ui/bigcap", title: "Big Cap", mode: "list", group: "gainers", cap: "big", limit: 120 })));
app.get("/ui/top-movers", (req, res) => res.type("html").send(renderUI({ path: "/ui/top-movers", title: "Top Movers (Standalone)", mode: "top-movers", direction: "all", cap: "all", limit: 120 })));
app.get("/ui/premarket", (req, res) => res.type("html").send(renderUI({ path: "/ui/premarket", title: "Pre-Market (Snapshot-All)", mode: "premarket", cap: "small", limit: 120 })));
app.get("/ui/afterhours", (req, res) => res.type("html").send(renderUI({ path: "/ui/afterhours", title: "After-Hours (Snapshot-All)", mode: "afterhours", cap: "small", limit: 120 })));

// ============================================================================
// SECTION 09 — API Routes
// ============================================================================
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: `${BRAND.legal} running ✅`,
    ui: "/ui",
    endpoints: ["/list", "/top-movers", "/scan", "/premarket", "/afterhours", "/snapshot-all", "/help"],
    snapshotAllEnabled: ENABLE_SNAPSHOT_ALL,
  });
});

app.get("/list", async (req, res) => {
  try {
    const groupRaw = String(req.query.group || "gainers").toLowerCase();
    const group = groupRaw === "losers" ? "losers" : groupRaw === "gappers" ? "gappers" : "gainers";
    const cap = String(req.query.cap || "all").toLowerCase();
    const limit = req.query.limit;

    const out = await buildFromMovers({ group, cap, limit, query: req.query });
    return res.status(out.status).json(out.body);
  } catch (e) {
    res.status(500).json({ ok: false, error: "List failed", detail: String(e?.message || e) });
  }
});

app.get("/top-movers", async (req, res) => {
  try {
    const direction = String(req.query.direction || "all").toLowerCase();
    const cap = String(req.query.cap || "all").toLowerCase();
    const limit = req.query.limit;
    const sort = String(req.query.sort || "score").toLowerCase();

    const out = await buildTopMovers({ direction, cap, limit, sort, query: req.query });
    return res.status(out.status).json(out.body);
  } catch (e) {
    res.status(500).json({ ok: false, error: "Top-movers failed", detail: String(e?.message || e) });
  }
});

app.get("/scan", async (req, res) => {
  try {
    const out = await buildScanSymbols({ symbols: req.query.symbols || "", query: req.query });
    return res.status(out.status).json(out.body);
  } catch (e) {
    res.status(500).json({ ok: false, error: "Scan failed", detail: String(e?.message || e) });
  }
});

app.get("/snapshot-all", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = req.query.limit;
  const sort = String(req.query.sort || "score").toLowerCase();
  const out = await buildFromSnapshotAll({ session: null, cap, limit, sort, query: req.query });
  return res.status(out.status).json(out.body);
});

app.get("/premarket", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = req.query.limit;
  const sort = String(req.query.sort || "score").toLowerCase();
  const out = await buildFromSnapshotAll({ session: "pre", cap, limit, sort, query: req.query });
  return res.status(out.status).json(out.body);
});

app.get("/afterhours", async (req, res) => {
  const cap = String(req.query.cap || "all").toLowerCase();
  const limit = req.query.limit;
  const sort = String(req.query.sort || "score").toLowerCase();
  const out = await buildFromSnapshotAll({ session: "after", cap, limit, sort, query: req.query });
  return res.status(out.status).json(out.body);
});

app.get("/help", (req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${BRAND.name} Help</title>
<style>
:root{color-scheme:dark;}
body{margin:0;font-family:ui-sans-serif,system-ui;background:#0b0d12;color:#e6e8ef}
.wrap{max-width:980px;margin:0 auto;padding:18px}
.card{border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:14px 16px;background:#0b0d12}
h1{margin:0 0 10px 0;font-size:18px}
p,li{color:#c1c7de;line-height:1.5;font-size:13px}
code{font-family:ui-monospace;background:#121622;padding:2px 6px;border-radius:8px;border:1px solid rgba(255,255,255,.10)}
a{color:#c8cde0}
</style></head>
<body><div class="wrap"><div class="card">
<h1>${BRAND.mark} ${BRAND.legal}</h1>
<p>Open <a href="/ui">/ui</a> to start.</p>

<h2 style="margin:16px 0 8px 0;font-size:14px;color:#cfd5ea;">Key pages</h2>
<ul>
  <li><a href="/ui/smallcap">/ui/smallcap</a> (Small-cap signals)</li>
  <li><a href="/ui/premarket">/ui/premarket</a> & <a href="/ui/afterhours">/ui/afterhours</a> (need Snapshot-All)</li>
  <li><a href="/ui/top-movers">/ui/top-movers</a> (standalone)</li>
</ul>

<h2 style="margin:16px 0 8px 0;font-size:14px;color:#cfd5ea;">API tests</h2>
<ul>
  <li><code>/list?group=gainers&cap=small&limit=80</code></li>
  <li><code>/top-movers?direction=all&cap=small&limit=80&sort=score</code></li>
  <li><code>/scan?symbols=NVDA,TSLA,AAPL</code></li>
  <li><code>/premarket?cap=small&limit=120</code> (requires <code>ENABLE_SNAPSHOT_ALL=true</code>)</li>
</ul>

<p style="margin-top:14px;">Signals: Score = Vol/Float + Gap% + Price% + Ext% (pre/after).</p>
</div></div></body></html>`);
});

// ============================================================================
// SECTION 10 — Listen logs (focus pre/after + smallcap)
// ============================================================================
app.listen(PORT, () => {
  const base = `http://localhost:${PORT}`;
  console.log(`\n✅ ${BRAND.legal} LIVE`);
  console.log(`🚀 UI: ${base}/ui`);
  console.log(`💎 SmallCap: ${base}/ui/smallcap`);
  console.log(`🌅 Pre-Market: ${base}/ui/premarket`);
  console.log(`🌙 After-Hours: ${base}/ui/afterhours`);
  console.log(`🧭 Top Movers: ${base}/ui/top-movers`);
  console.log(`📘 Help: ${base}/help`);
  if (!ENABLE_SNAPSHOT_ALL) console.log(`⚠️ Snapshot-All OFF → /premarket & /afterhours will return 403. (ENABLE_SNAPSHOT_ALL=false)\n`);
  else console.log(`✅ Snapshot-All ON\n`);
});
