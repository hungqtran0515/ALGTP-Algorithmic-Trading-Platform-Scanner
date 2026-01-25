/**
 * ============================================================================
 * 🔥 ALGTP™ – Algorithmic Trading Platform
 * Smart Market Scanner — Day Trade Matrix (PHASE 3: UI + Chart)
 * ----------------------------------------------------------------------------
 * Single-file Node.js server (CommonJS)
 *
 * ✅ Stable core (no indicators / no WS / no snapshot-all)
 * ✅ Vol/Float tier icons (>=1.5x)
 * ✅ Cap buckets (small/mid/big)
 * ✅ Independent scanners (each page has its own preset)
 * ✅ TradingView chart (click ticker → modal / Ctrl+click → new tab)
 * ✅ Disclaimer popup auto-close 5s (simple/pro)
 *
 * UI pages (independent):
 *  - /ui (Dashboard)
 *  - /ui/top-movers
 *  - /ui/gainers
 *  - /ui/losers
 *  - /ui/gappers
 *  - /ui/smallcap
 *  - /ui/midcap
 *  - /ui/bigcap
 *
 * API:
 *  - /list        (gainers/losers/gappers + cap + limit)
 *  - /top-movers  (standalone)
 *  - /scan        (symbols)
 *  - /help
 *
 * ENV (minimum):
 *  - PORT=3000
 *  - MASSIVE_API_KEY=...
 *  - MASSIVE_AUTH_TYPE=query|xapi|bearer
 *  - MASSIVE_QUERY_KEYNAME=apiKey
 *  - MASSIVE_MOVER_URL=...
 *  - MASSIVE_TICKER_SNAPSHOT_URL=...
 *
 * Disclaimer:
 *  - DISCLAIMER_MODE=simple|pro   (default simple)
 *  - DISCLAIMER_TTL_DAYS=7
 *  - DISCLAIMER_AUTO_CLOSE_MS=5000
 * ============================================================================
 */

// ============================================================================
// SECTION 01 — Brand Identity & Logo System
// What it is: Brand constants used in UI + headers
// Feature: mark/name/legal/subtitle/watermark
// Key kỹ thuật: single source of truth for branding
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
// SECTION 02 — Imports + App Boot (CommonJS)
// What it is: init express + axios
// Feature: JSON middleware
// Key kỹ thuật: keep runtime small + stable
// Debug tag: SECTION02_BOOT_IMPORTS
// ============================================================================
require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ============================================================================
// SECTION 03 — ENV Config
// What it is: read env + validate minimum
// Feature: API auth + URLs + disclaimer config
// Key kỹ thuật: fail fast if missing
// Debug tag: SECTION03_ENV_CONFIG
// ============================================================================
const PORT = Number(process.env.PORT || 3000);

const API_KEY = String(process.env.MASSIVE_API_KEY || "").trim();
const AUTH_TYPE = String(process.env.MASSIVE_AUTH_TYPE || "query").trim();
const QUERY_KEY = String(process.env.MASSIVE_QUERY_KEYNAME || "apiKey").trim();

const MOVERS_URL = String(process.env.MASSIVE_MOVER_URL || "").trim();
const SNAP_URL = String(process.env.MASSIVE_TICKER_SNAPSHOT_URL || "").trim();

const DISCLAIMER_MODE = String(process.env.DISCLAIMER_MODE || "simple").toLowerCase();
const DISCLAIMER_TTL_DAYS = Math.max(1, Math.min(365, Number(process.env.DISCLAIMER_TTL_DAYS || 7)));
const DISCLAIMER_AUTO_CLOSE_MS = Math.max(1000, Math.min(30000, Number(process.env.DISCLAIMER_AUTO_CLOSE_MS || 5000)));

if (!API_KEY || !MOVERS_URL || !SNAP_URL) {
  console.error("❌ Missing ENV. Required:");
  console.error(" - MASSIVE_API_KEY");
  console.error(" - MASSIVE_MOVER_URL");
  console.error(" - MASSIVE_TICKER_SNAPSHOT_URL");
  process.exit(1);
}

// ============================================================================
// SECTION 04 — Helpers (auth, safeGet, number)
// What it is: small helpers for stability
// Feature: auth modes + safeGet + num
// Key kỹ thuật: validateStatus to avoid throw on 4xx
// Debug tag: SECTION04_HELPERS
// ============================================================================
function auth(params = {}, headers = {}) {
  if (AUTH_TYPE === "query") params[QUERY_KEY] = API_KEY;
  else if (AUTH_TYPE === "xapi") headers["x-api-key"] = API_KEY;
  else if (AUTH_TYPE === "bearer") headers["authorization"] = `Bearer ${API_KEY}`;
  return { params, headers };
}

async function safeGet(url, params = {}) {
  try {
    const a = auth(params, {});
    const r = await axios.get(url, {
      params: a.params,
      headers: a.headers,
      timeout: 20000,
      validateStatus: () => true,
    });
    if (r.status >= 400) return null;
    return r.data;
  } catch {
    return null;
  }
}

function num(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function parseSymbols(input) {
  return String(input || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 100);
}

// ============================================================================
// SECTION 05 — Data Sources (Movers + Snapshot)
// What it is: fetch movers list + per-ticker snapshot
// Feature: gainers/losers + snapshot(ticker)
// Key kỹ thuật: resilient parsing of response arrays
// Debug tag: SECTION05_SOURCES
// ============================================================================
async function fetchMovers(direction = "gainers") {
  const dir = direction === "losers" ? "losers" : "gainers";
  const url = `${MOVERS_URL.replace(/\/+$/, "")}/${dir}`;
  const d = await safeGet(url);
  return Array.isArray(d?.tickers) ? d.tickers : Array.isArray(d?.results) ? d.results : [];
}

async function fetchSnapshot(symbol) {
  const url = `${SNAP_URL.replace(/\/+$/, "")}/${encodeURIComponent(symbol)}`;
  const d = await safeGet(url);
  return d?.results || null;
}

// ============================================================================
// SECTION 06 — Normalize + Cap Bucket + Vol/Float tier icons
// What it is: stable row schema for UI/API
// Feature: price/price%/gap%/vol/float/mcap + cap + VF tiers
// Key kỹ thuật: marketCap fallback = price*float; VF icon only if >=1.5
// Debug tag: SECTION06_NORMALIZE_VF_CAP
// ============================================================================
function capBucket(marketCap) {
  const mc = num(marketCap);
  if (mc === null) return null;
  if (mc < 2_000_000_000) return "small";
  if (mc < 10_000_000_000) return "mid";
  return "big";
}

function volFloatTier(x) {
  if (x < 1.5) return { icon: "", label: null };
  if (x >= 15) return { icon: "💣💣", label: "15x+" };
  if (x >= 10) return { icon: "🚀🚀", label: "10x" };
  if (x >= 5) return { icon: "🚀", label: "5x" };
  if (x >= 4) return { icon: "🔥🔥", label: "4x" };
  if (x >= 3) return { icon: "🔥", label: "3x" };
  if (x >= 2) return { icon: "⚡", label: "2x" };
  return { icon: "👀", label: "1.5x+" };
}

function normalize(symbol, snap) {
  const day = snap?.day || {};
  const prev = snap?.prevDay || {};

  const price = num(snap?.lastTrade?.p) ?? num(day?.c) ?? null;
  const prevClose = num(prev?.c) ?? null;
  const open = num(day?.o) ?? null;
  const volume = num(day?.v) ?? null;

  const floatShares =
    num(snap?.float) ??
    num(snap?.sharesFloat) ??
    num(snap?.floatShares) ??
    num(snap?.freeFloat) ??
    null;

  const marketCap =
    num(snap?.marketCap) ??
    num(snap?.marketcap) ??
    (price !== null && floatShares !== null ? price * floatShares : null);

  const pricePct =
    price !== null && prevClose !== null && prevClose > 0
      ? ((price - prevClose) / prevClose) * 100
      : null;

  const gapPct =
    open !== null && prevClose !== null && prevClose > 0
      ? ((open - prevClose) / prevClose) * 100
      : null;

  const vf = volume !== null && floatShares !== null && floatShares > 0 ? volume / floatShares : null;
  const tier = vf !== null ? volFloatTier(vf) : { icon: "", label: null };

  return {
    symbol,
    price: price !== null ? Number(price.toFixed(2)) : null,
    pricePct: pricePct !== null ? Number(pricePct.toFixed(2)) : null,
    gapPct: gapPct !== null ? Number(gapPct.toFixed(2)) : null,
    volume: volume !== null ? Math.round(volume) : null,

    floatShares: floatShares !== null ? Math.round(floatShares) : null,
    floatM: floatShares !== null ? Number((floatShares / 1_000_000).toFixed(2)) : null,

    marketCap: marketCap !== null ? Math.round(marketCap) : null,
    marketCapB: marketCap !== null ? Number((marketCap / 1_000_000_000).toFixed(2)) : null,

    cap: capBucket(marketCap),

    volFloatX: vf !== null ? Number(vf.toFixed(2)) : null,
    volFloatIcon: tier.icon,
    volFloatLabel: tier.label,
  };
}

// ============================================================================
// SECTION 07 — Daytrade builders (list + top-movers)
// What it is: scanner pipelines (independent)
// Feature: /list, /top-movers, /scan
// Key kỹ thuật: each endpoint handles its own flow (no shared heavy deps)
// Debug tag: SECTION07_BUILDERS
// ============================================================================
async function buildList({ group, limit, cap }) {
  const lim = clamp(Number(limit || 30), 5, 200);

  // group mapping: gainers/losers/gappers
  let dir = "gainers";
  if (group === "losers") dir = "losers";
  else dir = "gainers";

  const movers = await fetchMovers(dir);
  if (!movers.length) return { ok: false, error: "No movers data" };

  const symbols = movers
    .map((x) => String(x?.ticker || x?.symbol || "").trim().toUpperCase())
    .filter(Boolean)
    .slice(0, lim);

  const rows = [];
  for (const s of symbols) {
    const snap = await fetchSnapshot(s);
    if (!snap) continue;
    rows.push(normalize(s, snap));
  }

  let out = rows;

  if (group === "gappers") out = out.sort((a, b) => Math.abs(b.gapPct || 0) - Math.abs(a.gapPct || 0));
  else out = out.sort((a, b) => Math.abs(b.pricePct || 0) - Math.abs(a.pricePct || 0));

  if (cap && cap !== "all") out = out.filter((r) => r.cap === cap);

  return { ok: true, group, cap: cap || "all", count: out.length, results: out };
}

async function buildTopMovers({ direction, limit, cap }) {
  const lim = clamp(Number(limit || 50), 5, 200);
  const dir = String(direction || "all").toLowerCase();

  let symbols = [];
  if (dir === "gainers" || dir === "losers") {
    const mv = await fetchMovers(dir);
    symbols = mv.map((x) => String(x?.ticker || "").trim().toUpperCase()).filter(Boolean);
  } else {
    const g = await fetchMovers("gainers");
    const l = await fetchMovers("losers");
    symbols = Array.from(
      new Set([
        ...g.map((x) => String(x?.ticker || "").trim().toUpperCase()),
        ...l.map((x) => String(x?.ticker || "").trim().toUpperCase()),
      ].filter(Boolean))
    );
  }
  symbols = symbols.slice(0, lim);

  const rows = [];
  for (const s of symbols) {
    const snap = await fetchSnapshot(s);
    if (!snap) continue;
    rows.push(normalize(s, snap));
  }

  let out = rows.sort((a, b) => Math.abs(b.pricePct || 0) - Math.abs(a.pricePct || 0));
  if (cap && cap !== "all") out = out.filter((r) => r.cap === cap);
  out = out.slice(0, lim);

  return { ok: true, module: "top-movers", direction: dir, cap: cap || "all", count: out.length, results: out };
}

// ============================================================================
// SECTION 08 — API Routes (Stable)
// What it is: JSON APIs for UI + testing
// Feature: /list /top-movers /scan /
// Key kỹ thuật: always return ok:false with message instead of crashing
// Debug tag: SECTION08_API_ROUTES
// ============================================================================
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: `${BRAND.legal} — Day Trade Matrix (PHASE 3 UI)`,
    ui: "/ui",
    endpoints: ["/list", "/top-movers", "/scan", "/help"],
  });
});

app.get("/list", async (req, res) => {
  try {
    const group = String(req.query.group || "gainers").toLowerCase();
    const cap = String(req.query.cap || "all").toLowerCase();
    const limit = req.query.limit;

    const g = group === "losers" ? "losers" : group === "gappers" ? "gappers" : "gainers";
    const out = await buildList({ group: g, limit, cap });

    res.json(out);
  } catch (e) {
    res.json({ ok: false, error: "List failed", detail: String(e?.message || e) });
  }
});

app.get("/top-movers", async (req, res) => {
  try {
    const direction = String(req.query.direction || "all").toLowerCase();
    const cap = String(req.query.cap || "all").toLowerCase();
    const limit = req.query.limit;

    const out = await buildTopMovers({ direction, cap, limit });
    res.json(out);
  } catch (e) {
    res.json({ ok: false, error: "Top movers failed", detail: String(e?.message || e) });
  }
});

app.get("/scan", async (req, res) => {
  try {
    const symbols = parseSymbols(req.query.symbols || "");
    if (!symbols.length) return res.json({ ok: false, error: "No symbols provided" });

    const rows = [];
    for (const s of symbols) {
      const snap = await fetchSnapshot(s);
      if (!snap) continue;
      rows.push(normalize(s, snap));
    }
    rows.sort((a, b) => Math.abs(b.pricePct || 0) - Math.abs(a.pricePct || 0));

    res.json({ ok: true, mode: "symbols", count: rows.length, results: rows });
  } catch (e) {
    res.json({ ok: false, error: "Scan failed", detail: String(e?.message || e) });
  }
});

// ============================================================================
// SECTION 09 — UI Renderer (Independent pages + Chart modal)
// What it is: single HTML generator with preset injection
// Feature: independent pages + click symbol opens TradingView modal/newtab
// Key kỹ thuật: embed url via s.tradingview.com/widgetembed (iframe-safe)
// Debug tag: SECTION09_UI_RENDER
// ============================================================================
function disclaimerContent() {
  const simpleTitle = `⚠️ ${BRAND.name} Disclaimer`;
  const proTitle = `⚠️ Risk Disclosure & No Investment Advice`;

  const simpleVN = [
    `${BRAND.name} là công cụ scan dữ liệu để tham khảo, không phải lời khuyên mua/bán.`,
    `Dữ liệu có thể trễ/thiếu/sai do nguồn bên thứ ba.`,
    `Day trading rủi ro cao — bạn tự chịu trách nhiệm.`,
    `Luôn kiểm tra lại trên chart/broker trước khi vào lệnh.`,
  ];
  const simpleEN = [
    `${BRAND.name} is a market scanner for reference only — not financial advice.`,
    `Data may be delayed or inaccurate due to third-party feeds.`,
    `Day trading is high risk. You are responsible for your trades.`,
    `Always confirm on your chart/broker before trading.`,
  ];
  const proVN = [
    `${BRAND.name} cung cấp dữ liệu cho mục đích tham khảo/giáo dục.`,
    `Không cấu thành tư vấn hay khuyến nghị mua/bán.`,
    `Dữ liệu phụ thuộc bên thứ ba và có thể không chính xác.`,
    `Giao dịch có rủi ro cao và có thể mất toàn bộ vốn.`,
    `Bạn chịu trách nhiệm hoàn toàn cho mọi quyết định giao dịch.`,
  ];
  const proEN = [
    `${BRAND.name} provides market data for informational purposes only.`,
    `Nothing constitutes investment advice.`,
    `Data may be delayed or inaccurate.`,
    `Trading involves substantial risk, including total loss of capital.`,
    `You assume full responsibility for all trading decisions.`,
  ];

  const title = DISCLAIMER_MODE === "pro" ? proTitle : simpleTitle;
  const bullets = DISCLAIMER_MODE === "pro" ? { vn: proVN, en: proEN } : { vn: simpleVN, en: simpleEN };
  return { title, bullets };
}

function tvEmbedUrl(symbol, interval) {
  // TradingView widget embed endpoint (iframe friendly)
  const sym = encodeURIComponent(`NASDAQ:${symbol}`); // default NASDAQ; user can change inside TV if needed
  const tf = encodeURIComponent(String(interval || "5"));
  const tz = encodeURIComponent("America/New_York");
  return `https://s.tradingview.com/widgetembed/?symbol=${sym}&interval=${tf}&hidesidetoolbar=0&symboledit=1&saveimage=1&toolbarbg=rgba(18,22,34,1)&studies=[]&theme=dark&style=1&timezone=${tz}&withdateranges=1&hideideas=1`;
}

function renderUI(preset) {
  const disc = disclaimerContent();
  const P = {
    page: preset.page || "dashboard",
    title: preset.title || "Dashboard",
    // Data source selection
    source: preset.source || "list", // list | top-movers | scan
    group: preset.group || "gainers",
    direction: preset.direction || "all",
    cap: preset.cap || "all",
    limit: preset.limit || 50,
  };

  const nav = [
    { href: "/ui", k: "dashboard", label: "Dashboard" },
    { href: "/ui/top-movers", k: "top-movers", label: "Top Movers" },
    { href: "/ui/gainers", k: "gainers", label: "Gainers" },
    { href: "/ui/losers", k: "losers", label: "Losers" },
    { href: "/ui/gappers", k: "gappers", label: "Gappers" },
    { href: "/ui/smallcap", k: "smallcap", label: "Small Cap" },
    { href: "/ui/midcap", k: "midcap", label: "Mid Cap" },
    { href: "/ui/bigcap", k: "bigcap", label: "Big Cap" },
    { href: "/help", k: "help", label: "Help" },
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${BRAND.name} Scanner | ${BRAND.legal}</title>
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
.modalTools{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
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
        <div class="brandSub">${BRAND.subtitle} • Day Trade Matrix • Vol/Float tiers • Independent scanners • Click ticker → chart</div>
      </div>
      <div class="pill">${P.title}</div>
    </div>

    <div class="nav">
      ${nav
        .map(
          (x) => `<a href="${x.href}" class="${x.k === P.page ? "active" : ""}">${x.label}</a>`
        )
        .join("")}
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
        <option>20</option><option>30</option><option selected>50</option><option>80</option><option>100</option><option>150</option>
      </select>

      <input id="symbols" placeholder="Symbols (comma-separated) for /scan: NVDA,TSLA,AAPL" style="min-width:320px; flex:1;" />

      <span class="pill"><input id="openNewWin" type="checkbox" style="transform:translateY(1px)"/> Open new window</span>
      <span class="pill"><input id="newTab" type="checkbox" checked style="transform:translateY(1px)"/> New tab</span>

      <select id="tfSel">
        <option value="1">1m</option>
        <option value="5" selected>5m</option>
        <option value="15">15m</option>
        <option value="60">1h</option>
        <option value="240">4h</option>
        <option value="D">1D</option>
      </select>

      <button id="runBtn">Run</button>
      <span class="pill" id="status">Idle</span>
    </div>

    <div class="hint">
      Vol/Float icons show only when ≥ 1.5x. Click ticker to open TradingView chart (modal). Ctrl/Cmd+Click or "Open new window" → new tab.
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
      <div class="modalTools">
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
const tvBase = ${JSON.stringify(tvEmbedUrl("NVDA", "5")).split("NVDA").join("${SYMBOL}")}; // placeholder only

const byId = (id) => document.getElementById(id);
const out = byId("out");
const errBox = byId("errBox");
const statusEl = byId("status");

function setStatus(t){ statusEl.textContent = t; }
function showError(obj){
  errBox.style.display="block";
  errBox.textContent = typeof obj==="string" ? obj : JSON.stringify(obj,null,2);
}
function clearError(){ errBox.style.display="none"; errBox.textContent=""; }

function fmtNum(x, d=2){
  if (x===null || x===undefined) return "-";
  const n = Number(x); if (!Number.isFinite(n)) return "-";
  return n.toFixed(d);
}
function fmtInt(x){
  if (x===null || x===undefined) return "-";
  const n = Number(x); if (!Number.isFinite(n)) return "-";
  return Math.round(n).toLocaleString();
}

// TradingView open
const modalBack = byId("modalBack");
const modalTitle = byId("modalTitle");
const chartBox = byId("chartBox");
let currentSymbol = null;

function tvUrl(symbol, tf){
  const sym = encodeURIComponent("NASDAQ:"+symbol);
  const interval = encodeURIComponent(String(tf || "5"));
  const tz = encodeURIComponent("America/New_York");
  return "https://s.tradingview.com/widgetembed/"+
    "?symbol="+sym+
    "&interval="+interval+
    "&hidesidetoolbar=0&symboledit=1&saveimage=1&toolbarbg=rgba(18,22,34,1)"+
    "&studies=[]&theme=dark&style=1&timezone="+tz+"&withdateranges=1&hideideas=1";
}

function openModal(){
  modalBack.style.display="flex";
  modalBack.setAttribute("aria-hidden","false");
}
function closeModal(){
  modalBack.style.display="none";
  modalBack.setAttribute("aria-hidden","true");
  chartBox.innerHTML="";
  currentSymbol=null;
}

window.handleTickerClick = function(ev, sym){
  const tf = byId("tfSel").value || "5";
  const forceNew = byId("openNewWin").checked;
  const modifier = ev && (ev.ctrlKey || ev.metaKey);

  if (forceNew || modifier){
    const url = "https://www.tradingview.com/chart/?symbol="+encodeURIComponent("NASDAQ:"+sym)+"&interval="+encodeURIComponent(tf);
    const newTab = byId("newTab").checked !== false;
    if (newTab) window.open(url, "_blank", "noopener,noreferrer");
    else window.location.href = url;
    return;
  }

  currentSymbol = sym;
  modalTitle.textContent = "${BRAND.mark} ${BRAND.name} Chart — " + sym + " ("+tf+")";
  openModal();
  chartBox.innerHTML = '<iframe loading="lazy" src="'+tvUrl(sym, tf)+'"></iframe>';
};

byId("closeBtn").addEventListener("click", closeModal);
modalBack.addEventListener("click", (e)=>{ if(e.target===modalBack) closeModal(); });
document.addEventListener("keydown", (e)=>{ if(e.key==="Escape") closeModal(); });

// Render table
function renderTable(data){
  const rows = Array.isArray(data.results) ? data.results : [];
  const meta = PRESET.source==="top-movers"
    ? ("top-movers • dir="+(PRESET.direction||"all")+" • cap="+(byId("cap").value)+" • "+rows.length+" rows")
    : (PRESET.source==="scan"
      ? ("scan • "+rows.length+" rows")
      : ((PRESET.group||"gainers")+" • cap="+(byId("cap").value)+" • "+rows.length+" rows"));

  out.innerHTML = \`
    <div class="card">
      <div class="cardHead">
        <div class="title">${BRAND.mark} ${BRAND.name} — \${PRESET.title}</div>
        <div class="meta">\${meta}</div>
      </div>
      <div style="overflow:auto;">
      <table>
        <thead><tr>
          <th>Icon</th>
          <th>Symbol</th>
          <th class="right">Price</th>
          <th class="right">Price%</th>
          <th class="right">Gap%</th>
          <th class="right">Vol</th>
          <th class="right">Vol/Float</th>
          <th class="right">Float(M)</th>
          <th class="right">MCap(B)</th>
          <th>Cap</th>
        </tr></thead>
        <tbody>
          \${rows.map(r=>{
            const sym = String(r.symbol||"");
            const safe = sym.replace(/'/g,"");
            const vf = (r.volFloatX!=null && Number(r.volFloatX)>=1.5) ? ((r.volFloatIcon||"")+" "+fmtNum(r.volFloatX,2)+"x") : "-";
            const icon = (r.volFloatX!=null && Number(r.volFloatX)>=10) ? "🚀" : (r.volFloatX!=null && Number(r.volFloatX)>=3 ? "🔥" : "👀");
            return \`
              <tr>
                <td>\${icon}</td>
                <td class="mono"><a class="symLink" href="javascript:void(0)" onclick="handleTickerClick(event,'\${safe}')">\${sym}</a></td>
                <td class="right mono">\${fmtNum(r.price)}</td>
                <td class="right mono">\${fmtNum(r.pricePct)}%</td>
                <td class="right mono">\${fmtNum(r.gapPct)}%</td>
                <td class="right mono">\${fmtInt(r.volume)}</td>
                <td class="right mono">\${vf}</td>
                <td class="right mono">\${fmtNum(r.floatM)}</td>
                <td class="right mono">\${fmtNum(r.marketCapB)}</td>
                <td>\${r.cap || "-"}</td>
              </tr>\`;
          }).join("")}
        </tbody>
      </table>
      </div>
    </div>\`;
}

// Run
async function run(){
  clearError();
  out.innerHTML="";
  setStatus("Loading...");
  const cap = byId("cap").value;
  const limit = byId("limit").value;

  let url = "";
  if (PRESET.source === "top-movers"){
    url = "/top-movers?direction="+encodeURIComponent(PRESET.direction||"all")+
          "&cap="+encodeURIComponent(cap)+
          "&limit="+encodeURIComponent(limit);
  } else if (PRESET.source === "scan"){
    const symbols = (byId("symbols").value || "NVDA,TSLA,AAPL").trim();
    url = "/scan?symbols="+encodeURIComponent(symbols);
  } else {
    url = "/list?group="+encodeURIComponent(PRESET.group||"gainers")+
          "&cap="+encodeURIComponent(cap)+
          "&limit="+encodeURIComponent(limit);
  }

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
  byId("limit").value = String(PRESET.limit || 50);
}
byId("runBtn").addEventListener("click", run);

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
// SECTION 10 — UI Routes (Independent scanners)
// What it is: each page has its own preset (standalone)
// Feature: /ui/... pages
// Key kỹ thuật: preset injection keeps pages independent
// Debug tag: SECTION10_UI_ROUTES
// ============================================================================
app.get("/ui", (req, res) =>
  res.type("html").send(renderUI({ page: "dashboard", title: "Dashboard", source: "list", group: "gainers", cap: "all", limit: 50 }))
);

app.get("/ui/top-movers", (req, res) =>
  res.type("html").send(renderUI({ page: "top-movers", title: "Top Movers", source: "top-movers", direction: "all", cap: "all", limit: 50 }))
);

app.get("/ui/gainers", (req, res) =>
  res.type("html").send(renderUI({ page: "gainers", title: "Top Gainers", source: "list", group: "gainers", cap: "all", limit: 50 }))
);

app.get("/ui/losers", (req, res) =>
  res.type("html").send(renderUI({ page: "losers", title: "Top Losers", source: "list", group: "losers", cap: "all", limit: 50 }))
);

app.get("/ui/gappers", (req, res) =>
  res.type("html").send(renderUI({ page: "gappers", title: "Top Gappers", source: "list", group: "gappers", cap: "all", limit: 80 }))
);

app.get("/ui/smallcap", (req, res) =>
  res.type("html").send(renderUI({ page: "smallcap", title: "Small Cap", source: "list", group: "gainers", cap: "small", limit: 80 }))
);

app.get("/ui/midcap", (req, res) =>
  res.type("html").send(renderUI({ page: "midcap", title: "Mid Cap", source: "list", group: "gainers", cap: "mid", limit: 80 }))
);

app.get("/ui/bigcap", (req, res) =>
  res.type("html").send(renderUI({ page: "bigcap", title: "Big Cap", source: "list", group: "gainers", cap: "big", limit: 80 }))
);

// Optional quick scan page (symbols) if you want it as independent page too:
app.get("/ui/scan", (req, res) =>
  res.type("html").send(renderUI({ page: "scan", title: "Scan Symbols", source: "scan", cap: "all", limit: 50 }))
);

// ============================================================================
// SECTION 11 — Help
// What it is: quick usage page
// Feature: how to run + test URLs
// Key kỹ thuật: simple static html
// Debug tag: SECTION11_HELP
// ============================================================================
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
<p>Open <a href="/ui">/ui</a> to start. Each scanner page is standalone (bookmark/share).</p>

<h2 style="margin:16px 0 8px 0;font-size:14px;color:#cfd5ea;">UI pages</h2>
<ul>
  <li><a href="/ui/gainers">/ui/gainers</a>, <a href="/ui/losers">/ui/losers</a>, <a href="/ui/gappers">/ui/gappers</a></li>
  <li><a href="/ui/smallcap">/ui/smallcap</a>, <a href="/ui/midcap">/ui/midcap</a>, <a href="/ui/bigcap">/ui/bigcap</a></li>
  <li><a href="/ui/top-movers">/ui/top-movers</a></li>
</ul>

<h2 style="margin:16px 0 8px 0;font-size:14px;color:#cfd5ea;">API tests</h2>
<ul>
  <li><code>/list?group=gainers&cap=small&limit=50</code></li>
  <li><code>/top-movers?direction=all&cap=all&limit=50</code></li>
  <li><code>/scan?symbols=NVDA,TSLA,AAPL</code></li>
</ul>

<p style="margin-top:14px;">Chart: Click a ticker to open TradingView modal. Ctrl/Cmd+Click or "Open new window" for a new tab.</p>
</div></div></body></html>`);
});

// ============================================================================
// SECTION 12 — Listen
// What it is: start server
// Feature: log main URLs
// Key kỹ thuật: single listen
// Debug tag: SECTION12_LISTEN
// ============================================================================
app.listen(PORT, () => {
  console.log(`✅ ${BRAND.legal} (PHASE 3) running http://localhost:${PORT}`);
  console.log(`🚀 UI: http://localhost:${PORT}/ui`);
  console.log(`🧭 Top Movers UI: http://localhost:${PORT}/ui/top-movers`);
  console.log(`🔎 API list: http://localhost:${PORT}/list?group=gainers&cap=all&limit=50`);
  console.log(`📘 Help: http://localhost:${PORT}/help`);
});
