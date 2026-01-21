require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);

// serve UI from /public (optional)
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static("public"));

// ------------------------
// ENV + CONFIG
// ------------------------
const MASSIVE_API_URL = process.env.MASSIVE_API_URL || "";
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY || "";
const MASSIVE_AUTH_TYPE = (process.env.MASSIVE_AUTH_TYPE || "xapi").toLowerCase(); // xapi | bearer | query | none
const MASSIVE_QUERY_KEYNAME = process.env.MASSIVE_QUERY_KEYNAME || "apiKey";
const MASSIVE_SYMBOLS_PARAM = process.env.MASSIVE_SYMBOLS_PARAM || "symbols"; // some APIs use "tickers"
const MASSIVE_TIMEOUT_MS = Number(process.env.MASSIVE_TIMEOUT_MS || 20000);
const DEBUG = String(process.env.DEBUG || "0") === "1" || String(process.env.DEBUG || "").toLowerCase() === "true";

// OpenAI optional (không bắt buộc)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ------------------------
// Helpers
// ------------------------
function parseSymbols(input) {
  const raw = String(input || "");
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

// Try to auto-pick an array from Massive response
function pickArray(payload) {
  if (Array.isArray(payload)) return payload;

  // common keys
  const keys = ["results", "data", "items", "rows", "list"];
  for (const k of keys) {
    if (payload && Array.isArray(payload[k])) return payload[k];
  }

  // sometimes nested: { data: { results: [] } }
  for (const k of keys) {
    if (payload && payload[k] && typeof payload[k] === "object") {
      for (const kk of keys) {
        if (Array.isArray(payload[k][kk])) return payload[k][kk];
      }
    }
  }
  return null;
}

// Normalize a row to ALGTP fields (tự động chịu nhiều tên field khác nhau)
function normalizeRow(r) {
  const symbol =
    (r.symbol ?? r.ticker ?? r.sym ?? r.S ?? r.Symbol ?? r.Ticker ?? "").toString().toUpperCase();

  const price = safeNum(
    r.price ??
      r.last ??
      r.lastPrice ??
      r.last_trade_price ??
      r.close ??
      r.c ??
      r.regularMarketPrice
  );

  const open = safeNum(r.open ?? r.o ?? r.todayOpen ?? r.regularMarketOpen);
  const prevClose = safeNum(r.prevClose ?? r.previousClose ?? r.pc ?? r.prev_close ?? r.regularMarketPreviousClose);

  const volume = safeNum(r.volume ?? r.v ?? r.vol ?? r.todayVolume ?? r.regularMarketVolume);

  // avg vol can be in many places
  const avgVol = safeNum(
    r.avgVolume ??
      r.avgVol ??
      r.averageVolume ??
      r.avg_volume ??
      r.averageDailyVolume10Day ??
      r.averageDailyVolume3Month
  );

  // float shares can be "floatShares", "float", "shares_float", etc.
  const floatShares = safeNum(
    r.floatShares ??
      r.float_shares ??
      r.sharesFloat ??
      r.shares_float ??
      r.float ??
      r.freeFloat ??
      r.free_float
  );

  // compute derived
  const gapPct =
    open != null && prevClose != null && prevClose !== 0 ? ((open - prevClose) / prevClose) * 100 : null;

  const pricePct =
    price != null && prevClose != null && prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : null;

  const rvol = avgVol != null && avgVol !== 0 && volume != null ? volume / avgVol : null;

  const volFloat =
    floatShares != null && floatShares !== 0 && volume != null ? volume / floatShares : null;

  // Optional fields
  const rsi = safeNum(r.rsi ?? r.RSI ?? null);
  const ao = r.ao ?? r.AO ?? null; // could be number or string

  // simple demand 0-5 from your logic style
  let demandScore = 0;
  if (gapPct != null && Math.abs(gapPct) >= 2) demandScore += 1;
  if (gapPct != null && Math.abs(gapPct) >= 7) demandScore += 1;
  if (rvol != null && rvol >= 1.5) demandScore += 1;
  if (rvol != null && rvol >= 3) demandScore += 1;
  if (price != null && price >= 2 && price <= 20) demandScore += 1;
  demandScore = Math.max(0, Math.min(5, demandScore));

  // basic signal (you can upgrade later)
  const signal = demandScore >= 4 ? "BUY" : demandScore >= 3 ? "WATCH" : "WAIT";

  return {
    symbol,
    price: price != null ? round2(price) : null,
    open: open != null ? round2(open) : null,
    prevClose: prevClose != null ? round2(prevClose) : null,
    volume: volume != null ? Math.round(volume) : null,
    avgVol: avgVol != null ? Math.round(avgVol) : null,
    floatShares: floatShares != null ? Math.round(floatShares) : null,

    gapPct: gapPct != null ? round2(gapPct) : null,
    pricePct: pricePct != null ? round2(pricePct) : null,
    rvol: rvol != null ? round2(rvol) : null,
    volFloat: volFloat != null ? round2(volFloat) : null,

    rsi: rsi != null ? round2(rsi) : null,
    ao,

    demand: demandScore, // 0-5
    signal,
    raw: DEBUG ? r : undefined,
  };
}

// Build Massive request (auth flexible)
function buildMassiveRequest(symbols) {
  if (!MASSIVE_API_URL) {
    throw new Error("MASSIVE_API_URL is empty. Put the REAL Massive API endpoint into .env");
  }

  const headers = {};
  let url = MASSIVE_API_URL;

  if (MASSIVE_AUTH_TYPE === "xapi") {
    // Most common for paid plans
    headers["x-api-key"] = MASSIVE_API_KEY;
  } else if (MASSIVE_AUTH_TYPE === "bearer") {
    headers["Authorization"] = `Bearer ${MASSIVE_API_KEY}`;
  } else if (MASSIVE_AUTH_TYPE === "query") {
    // add apiKey to query string
    const hasQ = url.includes("?");
    url += `${hasQ ? "&" : "?"}${encodeURIComponent(MASSIVE_QUERY_KEYNAME)}=${encodeURIComponent(MASSIVE_API_KEY)}`;
  } else if (MASSIVE_AUTH_TYPE === "none") {
    // no auth header
  } else {
    // default to xapi
    headers["x-api-key"] = MASSIVE_API_KEY;
  }

  // Attach symbols param (common)
  // If your Massive endpoint needs different param name, set MASSIVE_SYMBOLS_PARAM in .env
  const params = {};
  params[MASSIVE_SYMBOLS_PARAM] = symbols.join(",");

  return { url, headers, params };
}

// Fetch + normalize rows
async function fetchMassiveRows(symbols) {
  const { url, headers, params } = buildMassiveRequest(symbols);

  const resp = await axios.get(url, {
    headers,
    params,
    timeout: MASSIVE_TIMEOUT_MS,
    validateStatus: () => true, // we handle status ourselves
  });

  if (resp.status >= 400) {
    const hint =
      resp.status === 401 || resp.status === 403
        ? "Auth failed: check MASSIVE_AUTH_TYPE + MASSIVE_API_KEY."
        : resp.status === 404
        ? "404 = MASSIVE_API_URL wrong endpoint (dashboard link is NOT API)."
        : "Check Massive endpoint response.";

    const detail = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data).slice(0, 500);

    const err = new Error(`HTTP ${resp.status}`);
    err._meta = { status: resp.status, url, hint, detail };
    throw err;
  }

  const arr = pickArray(resp.data);
  if (!arr) {
    // show keys for debugging
    const keys = resp.data && typeof resp.data === "object" ? Object.keys(resp.data) : [];
    throw new Error(`Massive response not an array. Top-level keys: ${keys.join(", ")}`);
  }

  const normalized = arr.map(normalizeRow).filter((x) => x.symbol);
  if (DEBUG) {
    console.log("MASSIVE URL:", url);
    console.log("MASSIVE STATUS:", resp.status);
    console.log("MASSIVE SAMPLE ROW:", normalized[0] || null);
  }
  return normalized;
}

// Active score (0-100 style)
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function scoreGap(gapPct) {
  const g = Math.abs(Number(gapPct || 0));
  const maxGapForFull = 20; // 20% => full
  return Math.round(clamp(g / maxGapForFull, 0, 1) * 60); // 0..60
}
function scoreVolFloat(volFloat) {
  const v = Number(volFloat || 0);
  const maxVFForFull = 5; // 5x => full
  return Math.round(clamp(v / maxVFForFull, 0, 1) * 25); // 0..25
}
function scoreRvol(rvol) {
  const r = Number(rvol || 0);
  const maxRvolForFull = 5; // 5x => full
  return Math.round(clamp(r / maxRvolForFull, 0, 1) * 15); // 0..15
}

function classify(activeScore) {
  const s = Number(activeScore || 0);
  if (s >= 80) return { tag: "🔥 HOT", color: "red" };
  if (s >= 60) return { tag: "⚡ WATCH", color: "orange" };
  return { tag: "⛔ SKIP", color: "gray" };
}

// ------------------------
// ROUTES
// ------------------------
app.get("/api", (req, res) => {
  res.json({
    ok: true,
    message: "ALGTP-AI API Server running 🚀",
    routes: ["/api", "/_massive_test", "/scan", "/active", "/sect", "/sections"],
  });
});

// Massive debug route
app.get("/_massive_test", async (req, res) => {
  try {
    const symbols = parseSymbols(req.query.symbols || "NVDA,TSLA,AAPL");
    const { url, headers, params } = buildMassiveRequest(symbols);

    const r = await axios.get(url, {
      headers,
      params,
      timeout: MASSIVE_TIMEOUT_MS,
      validateStatus: () => true,
    });

    // Do NOT leak secret key, only show which header name used
    const headerNames = Object.keys(headers || {});
    const sample =
      typeof r.data === "string"
        ? r.data.slice(0, 300)
        : JSON.stringify(r.data).slice(0, 800);

    res.json({
      ok: r.status < 400,
      massive: {
        url,
        status: r.status,
        authType: MASSIVE_AUTH_TYPE,
        headerNames,
        symbolsParam: MASSIVE_SYMBOLS_PARAM,
        params,
      },
      sample,
      hint:
        r.status === 404
          ? "404 = MASSIVE_API_URL sai endpoint (đừng dùng dashboard link)."
          : r.status === 401 || r.status === 403
          ? "401/403 = sai auth (MASSIVE_AUTH_TYPE hoặc KEY)."
          : r.status >= 400
          ? "Other error from Massive."
          : "OK",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Massive test failed", detail: e.message || String(e) });
  }
});

// Scan: return normalized rows
app.get("/scan", async (req, res) => {
  try {
    const symbols = parseSymbols(req.query.symbols || "NVDA,TSLA,AAPL");
    const rows = await fetchMassiveRows(symbols);
    res.json({ ok: true, count: rows.length, results: rows });
  } catch (e) {
    const meta = e._meta || {};
    res.status(500).json({
      ok: false,
      error: "Scan failed",
      detail: meta.status ? `HTTP ${meta.status}` : e.message || String(e),
      massiveUrl: meta.url || MASSIVE_API_URL || null,
      hint: meta.hint || "Open /_massive_test to see Massive URL/status/sample.",
      massiveDetail: meta.detail || undefined,
    });
  }
});

// Active: rank top N
app.get("/active", async (req, res) => {
  try {
    const symbols = parseSymbols(req.query.symbols || "NVDA,TSLA,AAPL,AMD,MSFT,META");
    const topN = clamp(Number(req.query.top || 10), 1, 50);

    const rows = await fetchMassiveRows(symbols);

    const ranked = rows
      .map((row) => {
        const gapS = scoreGap(row.gapPct);
        const vfS = scoreVolFloat(row.volFloat);
        const rvS = scoreRvol(row.rvol);
        const activeScore = gapS + vfS + rvS; // 0..100
        const cls = classify(activeScore);
        return {
          ...row,
          activeScore,
          scoreBreakdown: { gapS, vfS, rvS },
          alert: cls.tag,
        };
      })
      .sort((a, b) => (b.activeScore || 0) - (a.activeScore || 0));

    res.json({ ok: true, mode: "ACTIVE_TOP", top: ranked.slice(0, topN), rankedCount: ranked.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Active failed", detail: e.message || String(e) });
  }
});

// Sections (sect + sections use same handler)
async function handleSections(req, res) {
  try {
    const symbols = parseSymbols(req.query.symbols || "NVDA,TSLA,AAPL,AMD,MSFT,META");
    const rows = await fetchMassiveRows(symbols);

    const byDesc = (k) => (a, b) => (Number(b[k] ?? -Infinity) - Number(a[k] ?? -Infinity));
    const byAbsDesc = (k) => (a, b) => (Math.abs(Number(b[k] ?? 0)) - Math.abs(Number(a[k] ?? 0)));
    const top = (arr, n = 10) => arr.slice(0, n);

    const gainers = top([...rows].sort(byDesc("pricePct")).filter((x) => Number(x.pricePct) > 0), 10);
    const losers = top([...rows].sort(byDesc("pricePct")).filter((x) => Number(x.pricePct) < 0), 10);
    const gappers = top([...rows].sort(byAbsDesc("gapPct")), 10);

    const mostActive = top([...rows].sort(byDesc("volFloat")), 10);

    const hot = top(
      rows
        .filter((x) => Number(x.gapPct) >= 6 || Number(x.rvol) >= 5 || Number(x.volFloat) >= 3)
        .sort(
          (a, b) =>
            (Number(b.gapPct || 0) * 2 + Number(b.rvol || 0) + Number(b.volFloat || 0)) -
            (Number(a.gapPct || 0) * 2 + Number(a.rvol || 0) + Number(a.volFloat || 0))
        ),
      10
    );

    res.json({
      ok: true,
      universe: symbols,
      sections: { hot, mostActive, gainers, losers, gappers },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Sections failed", detail: e.message || String(e) });
  }
}

app.get("/sections", handleSections);
app.get("/sect", handleSections);

// ------------------------
// START
// ------------------------
app.listen(PORT, () => {
  console.log("ENV:", {
    PORT,
    MASSIVE_API_URL: MASSIVE_API_URL ? "OK" : "MISSING",
    MASSIVE_API_KEY: MASSIVE_API_KEY ? "OK" : "MISSING",
    MASSIVE_AUTH_TYPE,
    MASSIVE_QUERY_KEYNAME,
    MASSIVE_SYMBOLS_PARAM,
    OPENAI_API_KEY: OPENAI_API_KEY ? "OK" : "MISSING",
    OPENAI_MODEL,
    DEBUG,
  });

  console.log("✅ Running:", `http://localhost:${PORT}`);
  console.log("✅ API:    ", `http://localhost:${PORT}/api`);
  console.log("✅ TEST:   ", `http://localhost:${PORT}/_massive_test?symbols=NVDA,TSLA,AAPL`);
  console.log("✅ SCAN:   ", `http://localhost:${PORT}/scan?symbols=NVDA,TSLA,AAPL`);
  console.log("✅ ACTIVE: ", `http://localhost:${PORT}/active?symbols=NVDA,TSLA,AAPL,AMD,MSFT,META`);
  console.log("✅ SECT:   ", `http://localhost:${PORT}/sect?symbols=NVDA,TSLA,AAPL,AMD,MSFT,META`);
});
