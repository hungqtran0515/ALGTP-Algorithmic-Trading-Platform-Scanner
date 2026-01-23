/**
 * server.js — Massive Snapshot Scanner (FULL)
 * - Universe from Massive Top Market Movers:
 *      GET /v2/snapshot/locale/us/markets/stocks/{direction}
 * - Data per ticker from Massive Ticker Snapshot:
 *      GET /v2/snapshot/locale/us/markets/stocks/tickers/{ticker}
 * - Auth supports: query apiKey (recommended), x-api-key, bearer
 *
 * Endpoints:
 *  GET /api
 *  GET /env
 *  GET /_movers_test?direction=gainers
 *  GET /_ticker_test?ticker=NVDA
 *  GET /group?name=topGainers&limit=20
 *  GET /scan?symbols=NVDA,TSLA,AAPL
 */


require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ---------------- ENV ----------------
const PORT = Number(process.env.PORT || 3000);

const MASSIVE_API_KEY = String(process.env.MASSIVE_API_KEY || "").trim();

// auth mode: query | xapi | bearer
const MASSIVE_AUTH_TYPE = String(process.env.MASSIVE_AUTH_TYPE || "query").trim();
const MASSIVE_QUERY_KEYNAME = String(process.env.MASSIVE_QUERY_KEYNAME || "apiKey").trim();

// Movers base (NO /gainers at end)
const MASSIVE_MOVER_URL = String(
  process.env.MASSIVE_MOVER_URL || "https://api.massive.com/v2/snapshot/locale/us/markets/stocks"
).trim();

// Single ticker snapshot base (NO /{ticker} at end)
const MASSIVE_TICKER_SNAPSHOT_URL = String(
  process.env.MASSIVE_TICKER_SNAPSHOT_URL ||
    "https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers"
).trim();

// include OTC in movers (optional)
const INCLUDE_OTC = String(process.env.INCLUDE_OTC || "false").toLowerCase() === "true";

// rate-limit safe
const SNAP_CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.SNAP_CONCURRENCY || 4)));

const DEBUG = String(process.env.DEBUG || "true").toLowerCase() === "true";

// ---------------- helpers ----------------
function envMissing() {
  const miss = [];
  if (!MASSIVE_API_KEY) miss.push("MASSIVE_API_KEY");
  if (!MASSIVE_MOVER_URL) miss.push("MASSIVE_MOVER_URL");
  if (!MASSIVE_TICKER_SNAPSHOT_URL) miss.push("MASSIVE_TICKER_SNAPSHOT_URL");
  return miss;
}

function auth(params = {}, headers = {}) {
  const t = String(MASSIVE_AUTH_TYPE).toLowerCase();

  if (t === "query") params[MASSIVE_QUERY_KEYNAME || "apiKey"] = MASSIVE_API_KEY;
  else if (t === "xapi") headers["x-api-key"] = MASSIVE_API_KEY;
  else if (t === "bearer") headers["authorization"] = `Bearer ${MASSIVE_API_KEY}`;
  else params[MASSIVE_QUERY_KEYNAME || "apiKey"] = MASSIVE_API_KEY; // fallback

  headers["user-agent"] =
    headers["user-agent"] ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

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
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

// simple pool concurrency
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

// demand score (0..5) based on gap/pricePct (vol fields are optional)
function demandScore(row) {
  const gap = Math.abs(n(row.gapPct) ?? 0);
  const pc = Math.abs(n(row.pricePct) ?? 0);

  let s = 0;
  if (gap >= 20) s += 1;
  if (gap >= 40) s += 1;
  if (gap >= 60) s += 1;
  if (pc >= 10) s += 1;
  if (pc >= 20) s += 1;

  return clamp(s, 0, 5);
}

function signalIcon(d) {
  if (d >= 5) return "🚀";
  if (d >= 4) return "🔥";
  if (d >= 3) return "👀";
  return "⛔️";
}

function sectionCodeFromScore(d) {
  // map 1..5 => S01..S05
  const idx = clamp(d || 1, 1, 5);
  return "S" + String(idx).padStart(2, "0");
}

// ---------------- Massive calls ----------------
async function fetchMovers(direction = "gainers") {
  const base = MASSIVE_MOVER_URL.replace(/\/+$/, "");
  const url = `${base}/${direction}`;

  const params = {};
  const headers = {};
  if (INCLUDE_OTC) params["include_otc"] = "true";

  const a = auth(params, headers);

  const r = await axios.get(url, {
    params: a.params,
    headers: a.headers,
    timeout: 20000,
    validateStatus: () => true,
  });

  const rows = Array.isArray(r.data?.tickers)
    ? r.data.tickers
    : Array.isArray(r.data?.results)
    ? r.data.results
    : Array.isArray(r.data?.data)
    ? r.data.data
    : null;

  return {
    ok: r.status < 400 && Array.isArray(rows),
    url,
    status: r.status,
    keys: r.data && typeof r.data === "object" ? Object.keys(r.data) : null,
    rows: Array.isArray(rows) ? rows : [],
    sample: Array.isArray(rows) ? rows[0] : r.data,
  };
}

async function fetchTickerSnapshot(ticker) {
  const base = MASSIVE_TICKER_SNAPSHOT_URL.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(ticker)}`;

  const params = {};
  const headers = {};
  const a = auth(params, headers);

  const r = await axios.get(url, {
    params: a.params,
    headers: a.headers,
    timeout: 20000,
    validateStatus: () => true,
  });

  return {
    ok: r.status < 400,
    url,
    status: r.status,
    data: r.data,
  };
}

// normalize snapshot into row
function normalizeSnapshot(ticker, snap) {
  // Common snapshot-like fields (Polygon style)
  const day = snap?.day ?? snap?.results?.day ?? null;
  const prev = snap?.prevDay ?? snap?.results?.prevDay ?? null;

  const lastTradePrice = n(snap?.lastTrade?.p) ?? n(snap?.lastTrade?.price) ?? null;
  const dayClose = n(day?.c ?? day?.close) ?? null;
  const prevClose = n(prev?.c ?? prev?.close) ?? null;

  const price = lastTradePrice ?? dayClose ?? null;

  const pricePct =
    n(snap?.todaysChangePerc) ??
    (price !== null && prevClose ? ((price - prevClose) / prevClose) * 100 : null);

  const open = n(day?.o ?? day?.open) ?? null;
  const gapPct = open !== null && prevClose ? ((open - prevClose) / prevClose) * 100 : null;

  const volume = n(day?.v ?? day?.volume) ?? null;

  return {
    symbol: ticker.toUpperCase(),
    price: price !== null ? round2(price) : null,
    open: open !== null ? round2(open) : null,
    prevClose: prevClose !== null ? round2(prevClose) : null,
    pricePct: pricePct !== null ? round2(pricePct) : null,
    gapPct: gapPct !== null ? round2(gapPct) : null,
    volume: volume !== null ? Math.round(volume) : null,
  };
}

// ---------------- routes ----------------
app.get("/api", (req, res) => {
  res.json({
    ok: true,
    message: "Massive Snapshot Scanner running 🚀",
    envMissing: envMissing(),
    config: {
      authType: MASSIVE_AUTH_TYPE,
      queryKeyName: MASSIVE_QUERY_KEYNAME,
      moverUrl: MASSIVE_MOVER_URL,
      tickerSnapshotUrl: MASSIVE_TICKER_SNAPSHOT_URL,
      includeOtc: INCLUDE_OTC,
      snapConcurrency: SNAP_CONCURRENCY,
      debug: DEBUG,
    },
    tests: ["/env", "/_movers_test?direction=gainers", "/_ticker_test?ticker=NVDA", "/group?name=topGainers&limit=20"],
  });
});

app.get("/env", (req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(MASSIVE_API_KEY),
    authType: MASSIVE_AUTH_TYPE,
    queryKeyName: MASSIVE_QUERY_KEYNAME,
    moverBase: MASSIVE_MOVER_URL,
    tickerBase: MASSIVE_TICKER_SNAPSHOT_URL,
  });
});

app.get("/_movers_test", async (req, res) => {
  const miss = envMissing();
  if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

  const direction = String(req.query.direction || "gainers");
  const r = await fetchMovers(direction);

  res.status(r.ok ? 200 : 500).json(r);
});

app.get("/_ticker_test", async (req, res) => {
  const miss = envMissing();
  if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

  const ticker = String(req.query.ticker || "NVDA").trim().toUpperCase();
  const r = await fetchTickerSnapshot(ticker);

  res.status(r.ok ? 200 : 500).json({
    ok: r.ok,
    status: r.status,
    url: r.url,
    keys: r.data && typeof r.data === "object" ? Object.keys(r.data) : null,
    bodyPreview: typeof r.data === "string" ? r.data.slice(0, 500) : r.data,
  });
});

// group scanner (universe from movers)
app.get("/group", async (req, res) => {
  try {
    const miss = envMissing();
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const name = String(req.query.name || "topGainers");
    const limit = clamp(Number(req.query.limit || 20), 5, 100);

    const direction = name === "topLosers" ? "losers" : "gainers";

    const movers = await fetchMovers(direction);
    if (!movers.ok) {
      return res.status(500).json({
        ok: false,
        error: "Movers failed",
        moverDebug: movers,
        fix: [
          "If status=401/403: auth/key/plan issue. Try MASSIVE_AUTH_TYPE=query.",
          "If status=404: URL wrong (base should NOT include /gainers).",
          "If status=429: rate limit. Reduce SNAP_CONCURRENCY and limit.",
        ],
      });
    }

    const tickers = movers.rows
      .map((x) => String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase())
      .filter(Boolean)
      .slice(0, limit);

    if (!tickers.length) {
      return res.status(500).json({
        ok: false,
        error: "Movers returned empty tickers",
        moverDebug: { status: movers.status, keys: movers.keys, sample: movers.sample },
      });
    }

    const snaps = await mapPool(tickers, SNAP_CONCURRENCY, async (t) => {
      const r = await fetchTickerSnapshot(t);
      return { ticker: t, ...r };
    });

    const good = snaps.filter((x) => x.ok);
    const bad = snaps.filter((x) => !x.ok);

    const rows = good
      .map((x) => normalizeSnapshot(x.ticker, x.data))
      .map((r) => {
        const d = demandScore(r);
        return {
          ...r,
          demandScore: d,
          signalIcon: signalIcon(d),
          section: sectionCodeFromScore(d),
        };
      });

    // sort by abs pricePct (gainers/losers)
    rows.sort((a, b) => Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0));

    const sections = { S01: [], S02: [], S03: [], S04: [], S05: [] };
    for (const row of rows) (sections[row.section] || sections.S01).push(row);

    res.json({
      ok: true,
      group: name,
      direction,
      universeCount: tickers.length,
      rows: rows.length,
      sections,
      snapshotErrors: DEBUG
        ? bad.slice(0, 10).map((x) => ({ ticker: x.ticker, status: x.status, url: x.url }))
        : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Group failed", detail: String(e?.message || e) });
  }
});

// scan by symbols (manual)
app.get("/scan", async (req, res) => {
  const miss = envMissing();
  if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

  const symbols = parseSymbols(req.query.symbols || "NVDA,TSLA,AAPL").slice(0, 50);
  const snaps = await mapPool(symbols, SNAP_CONCURRENCY, async (t) => {
    const r = await fetchTickerSnapshot(t);
    return { ticker: t, ...r };
  });

  const rows = snaps
    .filter((x) => x.ok)
    .map((x) => normalizeSnapshot(x.ticker, x.data));

  res.json({ ok: true, symbolsCount: symbols.length, rowsows: rows.length, results: rows });
});

app.listen(PORT, () => {
  console.log(`✅ Server running http://localhost:${PORT}`);
});
