/**
 * ============================================================================
 * ALGTP™ DAY TRADE MATRIX — PHASE 2 (STABLE)
 * Adds:
 *  - Vol/Float tier icons (>=1.5x)
 *  - Cap buckets (small/mid/big)
 *  - Top Movers (standalone)
 * No indicators / No WS / No snapshot-all
 * ============================================================================
 */

require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// =======================
// CONFIG (MINIMUM)
// =======================
const PORT = Number(process.env.PORT || 3000);
const API_KEY = String(process.env.MASSIVE_API_KEY || "").trim();
const AUTH_TYPE = String(process.env.MASSIVE_AUTH_TYPE || "query").trim();
const QUERY_KEY = String(process.env.MASSIVE_QUERY_KEYNAME || "apiKey").trim();
const MOVERS_URL = String(process.env.MASSIVE_MOVER_URL || "").trim();
const SNAP_URL = String(process.env.MASSIVE_TICKER_SNAPSHOT_URL || "").trim();

if (!API_KEY || !MOVERS_URL || !SNAP_URL) {
  console.error("❌ Missing ENV (API_KEY / MOVERS_URL / SNAP_URL)");
  process.exit(1);
}

// =======================
// HELPERS
// =======================
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
      params: a.params, headers: a.headers, timeout: 20000, validateStatus: () => true,
    });
    if (r.status >= 400) return null;
    return r.data;
  } catch { return null; }
}
const num = (x) => { const v = Number(x); return Number.isFinite(v) ? v : null; };

// =======================
// DATA FETCH
// =======================
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

// =======================
// NORMALIZE + CAP + VOL/FLOAT
// =======================
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
  if (x >= 5)  return { icon: "🚀",   label: "5x" };
  if (x >= 4)  return { icon: "🔥🔥", label: "4x" };
  if (x >= 3)  return { icon: "🔥",   label: "3x" };
  if (x >= 2)  return { icon: "⚡",   label: "2x" };
  return { icon: "👀", label: "1.5x+" };
}
function normalize(symbol, snap) {
  const day = snap?.day || {};
  const prev = snap?.prevDay || {};
  const price = num(snap?.lastTrade?.p) ?? num(day?.c) ?? null;
  const prevClose = num(prev?.c) ?? null;
  const open = num(day?.o) ?? null;
  const volume = num(day?.v) ?? null;

  let floatShares =
    num(snap?.float) ?? num(snap?.sharesFloat) ?? num(snap?.floatShares) ?? null;
  let marketCap =
    num(snap?.marketCap) ?? num(snap?.marketcap) ??
    (price !== null && floatShares !== null ? price * floatShares : null);

  const pricePct = price && prevClose ? ((price - prevClose) / prevClose) * 100 : null;
  const gapPct   = open && prevClose ? ((open - prevClose) / prevClose) * 100 : null;

  const vf = volume && floatShares ? volume / floatShares : null;
  const tier = vf ? volFloatTier(vf) : { icon:"", label:null };

  return {
    symbol,
    price,
    pricePct: pricePct !== null ? Number(pricePct.toFixed(2)) : null,
    gapPct: gapPct !== null ? Number(gapPct.toFixed(2)) : null,
    volume: volume !== null ? Math.round(volume) : null,
    floatShares: floatShares !== null ? Math.round(floatShares) : null,
    marketCap: marketCap !== null ? Math.round(marketCap) : null,
    cap: capBucket(marketCap),
    volFloatX: vf !== null ? Number(vf.toFixed(2)) : null,
    volFloatIcon: tier.icon,
    volFloatLabel: tier.label,
  };
}

// =======================
// API: /list (DAY TRADE GROUPS)
// =======================
app.get("/list", async (req, res) => {
  const group = String(req.query.group || "gainers").toLowerCase();
  const limit = Math.max(5, Math.min(200, Number(req.query.limit || 30)));
  const cap = String(req.query.cap || "all").toLowerCase();

  const movers = await fetchMovers(group === "losers" ? "losers" : "gainers");
  if (!movers.length) return res.json({ ok:false, error:"No movers data" });

  const symbols = movers
    .map(x => String(x?.ticker || x?.symbol || "").toUpperCase())
    .filter(Boolean)
    .slice(0, limit);

  const rows = [];
  for (const s of symbols) {
    const snap = await fetchSnapshot(s);
    if (!snap) continue;
    rows.push(normalize(s, snap));
  }

  let out = rows;
  if (group === "gappers") out = out.sort((a,b)=>Math.abs(b.gapPct||0)-Math.abs(a.gapPct||0));
  else out = out.sort((a,b)=>Math.abs(b.pricePct||0)-Math.abs(a.pricePct||0));

  if (cap !== "all") out = out.filter(r => r.cap === cap);

  res.json({ ok:true, group, cap, count: out.length, results: out });
});

// =======================
// API: /top-movers (STANDALONE)
// =======================
app.get("/top-movers", async (req, res) => {
  const direction = String(req.query.direction || "all").toLowerCase();
  const limit = Math.max(5, Math.min(200, Number(req.query.limit || 50)));
  const cap = String(req.query.cap || "all").toLowerCase();

  let symbols = [];
  if (direction === "gainers" || direction === "losers") {
    const mv = await fetchMovers(direction);
    symbols = mv.map(x => String(x?.ticker||"").toUpperCase()).filter(Boolean);
  } else {
    const g = await fetchMovers("gainers");
    const l = await fetchMovers("losers");
    symbols = Array.from(new Set([
      ...g.map(x=>String(x?.ticker||"").toUpperCase()),
      ...l.map(x=>String(x?.ticker||"").toUpperCase()),
    ]));
  }
  symbols = symbols.slice(0, limit);

  const rows = [];
  for (const s of symbols) {
    const snap = await fetchSnapshot(s);
    if (!snap) continue;
    rows.push(normalize(s, snap));
  }

  let out = rows.sort((a,b)=>Math.abs(b.pricePct||0)-Math.abs(a.pricePct||0));
  if (cap !== "all") out = out.filter(r => r.cap === cap);

  res.json({ ok:true, module:"top-movers", cap, count: out.length, results: out });
});

// =======================
// API: /scan (SYMBOLS)
// =======================
app.get("/scan", async (req, res) => {
  const symbols = String(req.query.symbols||"")
    .split(",").map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,100);
  if (!symbols.length) return res.json({ ok:false, error:"No symbols provided" });

  const rows = [];
  for (const s of symbols) {
    const snap = await fetchSnapshot(s);
    if (!snap) continue;
    rows.push(normalize(s, snap));
  }
  res.json({ ok:true, count: rows.length, results: rows });
});

// =======================
// START
// =======================
app.listen(PORT, () => {
  console.log(`✅ ALGTP™ DAY TRADE MATRIX running http://localhost:${PORT}`);
  console.log(`➡️ /list?group=gainers`);
  console.log(`➡️ /top-movers`);
});
