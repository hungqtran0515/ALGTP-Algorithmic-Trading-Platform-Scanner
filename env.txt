/**
 * ============================================================================
 * ALGTP™ CORE SCANNER — PHASE 1 (GUARANTEED WORKING)
 * Purpose:
 *  - Scan ra kết quả ĐÚNG, ỔN ĐỊNH
 *  - Không phụ thuộc indicator / WS / snapshot-all
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

const MOVERS_URL = String(process.env.MASSIVE_MOVER_URL || "").trim(); // .../snapshot/.../stocks
const SNAP_URL = String(process.env.MASSIVE_TICKER_SNAPSHOT_URL || "").trim(); // .../snapshot/.../stocks/tickers

if (!API_KEY || !MOVERS_URL || !SNAP_URL) {
  console.error("❌ Missing ENV. Required:");
  console.error(" - MASSIVE_API_KEY");
  console.error(" - MASSIVE_MOVER_URL");
  console.error(" - MASSIVE_TICKER_SNAPSHOT_URL");
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

// =======================
// DATA FETCH
// =======================
async function fetchMovers(group = "gainers") {
  const g = String(group).toLowerCase();
  const dir = g === "losers" ? "losers" : "gainers";
  const url = `${MOVERS_URL.replace(/\/+$/, "")}/${dir}`;
  const data = await safeGet(url);
  const rows =
    Array.isArray(data?.tickers) ? data.tickers :
    Array.isArray(data?.results) ? data.results : [];
  return rows;
}

async function fetchSnapshot(symbol) {
  const url = `${SNAP_URL.replace(/\/+$/, "")}/${encodeURIComponent(symbol)}`;
  const data = await safeGet(url);
  return data?.results || null;
}

// =======================
// NORMALIZE (SAFE & SIMPLE)
// =======================
function normalize(symbol, snap) {
  const day = snap?.day || {};
  const prev = snap?.prevDay || {};

  const price =
    num(snap?.lastTrade?.p) ??
    num(day?.c) ??
    null;

  const prevClose = num(prev?.c) ?? null;
  const open = num(day?.o) ?? null;
  const volume = num(day?.v) ?? null;

  const pricePct =
    price !== null && prevClose !== null && prevClose > 0
      ? ((price - prevClose) / prevClose) * 100
      : null;

  const gapPct =
    open !== null && prevClose !== null && prevClose > 0
      ? ((open - prevClose) / prevClose) * 100
      : null;

  return {
    symbol,
    price,
    pricePct: pricePct !== null ? Number(pricePct.toFixed(2)) : null,
    gapPct: gapPct !== null ? Number(gapPct.toFixed(2)) : null,
    volume: volume !== null ? Math.round(volume) : null,
  };
}

// =======================
// API: /list
// =======================
app.get("/list", async (req, res) => {
  const group = String(req.query.group || "gainers").toLowerCase();
  const limit = Math.max(5, Math.min(200, Number(req.query.limit || 30)));

  const movers = await fetchMovers(group);
  if (!movers.length) {
    return res.json({ ok: false, error: "No movers data" });
  }

  const symbols = movers
    .map((x) => String(x?.ticker || x?.symbol || "").trim().toUpperCase())
    .filter(Boolean)
    .slice(0, limit);

  const results = [];
  for (const s of symbols) {
    const snap = await fetchSnapshot(s);
    if (!snap) continue;
    results.push(normalize(s, snap));
  }

  return res.json({
    ok: true,
    group,
    count: results.length,
    results,
  });
});

// =======================
// API: /scan
// =======================
app.get("/scan", async (req, res) => {
  const symbols = String(req.query.symbols || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 100);

  if (!symbols.length) {
    return res.json({ ok: false, error: "No symbols provided" });
  }

  const results = [];
  for (const s of symbols) {
    const snap = await fetchSnapshot(s);
    if (!snap) continue;
    results.push(normalize(s, snap));
  }

  return res.json({
    ok: true,
    count: results.length,
    results,
  });
});

// =======================
// HEALTH
// =======================
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "ALGTP™ CORE SCANNER",
    endpoints: ["/list", "/scan"],
  });
});

// =======================
// START
// =======================
app.listen(PORT, () => {
  console.log(`✅ ALGTP™ CORE running at http://localhost:${PORT}`);
  console.log(`➡️ Test: http://localhost:${PORT}/list?group=gainers`);
});
