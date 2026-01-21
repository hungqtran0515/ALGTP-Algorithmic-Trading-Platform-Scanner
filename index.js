// index.js (ES Module) - ALGTP® A.I Scanner Server
import "dotenv/config";
import express from "express";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// -------------------- CONFIG --------------------
const PORT = Number(process.env.PORT || 3000);

// Massive config
const MASSIVE_API_URL = String(process.env.MASSIVE_API_URL || "").trim(); // quotes endpoint (symbols=...)
const MASSIVE_API_KEY = String(process.env.MASSIVE_API_KEY || "").trim();
const MASSIVE_AUTH_TYPE = String(process.env.MASSIVE_AUTH_TYPE || "xapi").trim(); // xapi | bearer | query
const MASSIVE_QUERY_KEYNAME = String(process.env.MASSIVE_QUERY_KEYNAME || "apiKey").trim();

// Optional: if Massive has separate movers endpoints
const MASSIVE_MOVER_URL = String(process.env.MASSIVE_MOVER_URL || "").trim(); // optional

const DEBUG = String(process.env.DEBUG || "true") === "true";

// -------------------- STATIC UI --------------------
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// -------------------- HELPERS --------------------
function log(...args) {
  if (DEBUG) console.log(...args);
}

function parseSymbols(input) {
  const raw = String(input || "");
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

// safe number parse (handles "12.3%", "2.1x", "1,234", etc.)
function n(x) {
  if (x === null || x === undefined) return null;
  const s = String(x).replace(/[%x,]/g, "").trim();
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function round2(x) {
  const v = n(x);
  return v === null ? null : Number(v.toFixed(2));
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function envMissing() {
  const miss = [];
  if (!MASSIVE_API_URL) miss.push("MASSIVE_API_URL");
  if (!MASSIVE_API_KEY) miss.push("MASSIVE_API_KEY");
  return miss;
}

// attach Massive auth
function massiveAuth({ headers, params }) {
  const h = headers || {};
  const p = params || {};
  const t = MASSIVE_AUTH_TYPE.toLowerCase();

  if (t === "xapi") h["x-api-key"] = MASSIVE_API_KEY;
  else if (t === "bearer") h["authorization"] = `Bearer ${MASSIVE_API_KEY}`;
  else if (t === "query") p[MASSIVE_QUERY_KEYNAME || "apiKey"] = MASSIVE_API_KEY;
  else h["x-api-key"] = MASSIVE_API_KEY; // default fallback

  // good UA helps some providers
  h["user-agent"] =
    h["user-agent"] ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari";

  return { headers: h, params: p };
}

// normalize row from Massive (tries many common field names)
function normRow(r) {
  // symbol
  const symbol = String(
    r?.symbol ??
      r?.ticker ??
      r?.code ??
      r?.sym ??
      ""
  )
    .trim()
    .toUpperCase();

  // prices
  const price = n(
    r?.price ??
      r?.last ??
      r?.close ??
      r?.regularMarketPrice ??
      r?.mark ??
      r?.c
  );

  const open = n(r?.open ?? r?.o ?? r?.regularMarketOpen);
  const prevClose = n(r?.prevClose ?? r?.previousClose ?? r?.regularMarketPreviousClose ?? r?.pc);

  // percent change (can be provided directly)
  const pricePct =
    n(r?.pricePct ?? r?.changePercent ?? r?.regularMarketChangePercent ?? r?.pctChange) ??
    (price !== null && prevClose ? ((price - prevClose) / prevClose) * 100 : null);

  // gap% = (open - prevClose)/prevClose
  const gapPct =
    n(r?.gapPct ?? r?.gapPercent ?? r?.gap) ??
    (open !== null && prevClose ? ((open - prevClose) / prevClose) * 100 : null);

  // volume & avg volume
  const volume = n(r?.volume ?? r?.vol ?? r?.regularMarketVolume ?? r?.v) ?? 0;

  const avgVol =
    n(r?.avgVolume ?? r?.averageVolume ?? r?.averageDailyVolume10Day ?? r?.avgVol10d ?? r?.avgVol20d) ??
    null;

  const rvol = avgVol && avgVol > 0 ? volume / avgVol : n(r?.rvol ?? r?.rv);

  // float shares
  const floatShares =
    n(r?.floatShares ?? r?.float_shares ?? r?.float) ??
    n(r?.sharesFloat ?? r?.shares_float) ??
    n(r?.shares_outstanding ?? r?.sharesOutstanding);

  // vol/float “x”
  // your preference: "Vol/Float must be 2x>" but can go 19x
  const volFloatX =
    floatShares && floatShares > 0 ? volume / floatShares : n(r?.volFloat ?? r?.volFloatX);

  // market cap for small/mid/large
  const marketCap =
    n(r?.marketCap ?? r?.market_cap ?? r?.cap) ??
    null;

  // return
  if (!symbol) return null;
  return {
    symbol,
    price: price !== null ? round2(price) : null,
    open: open !== null ? round2(open) : null,
    prevClose: prevClose !== null ? round2(prevClose) : null,
    pricePct: pricePct !== null ? round2(pricePct) : null,
    gapPct: gapPct !== null ? round2(gapPct) : null,
    volume: round2(volume),
    avgVol: avgVol !== null ? round2(avgVol) : null,
    rvolX: rvol !== null ? round2(rvol) : null,
    volFloatX: volFloatX !== null ? round2(volFloatX) : null,
    marketCap: marketCap !== null ? Math.round(marketCap) : null,
    raw: r,
  };
}

// demand score 0..5 based on your preferences (gap/price%, vf, rvol) and keeps flexible
function demandScore(row) {
  const gap = Math.abs(n(row.gapPct) ?? 0);
  const pc = Math.abs(n(row.pricePct) ?? 0);
  const vf = n(row.volFloatX);
  const rv = n(row.rvolX);

  let s = 0;

  // gap bands: warn 20-60, but can go 200 => keep scoring not hard lock
  if (gap >= 20) s += 1;
  if (gap >= 40) s += 1;
  if (gap >= 60) s += 1;

  // price change: can go 200
  if (pc >= 10) s += 1;
  if (pc >= 20) s += 1;

  // vol/float: alert around 2-4, but can be 19x
  if (vf !== null && vf >= 2) s += 1;
  if (vf !== null && vf >= 4) s += 1;

  // rvol: alert around 2-5
  if (rv !== null && rv >= 2) s += 1;
  if (rv !== null && rv >= 5) s += 1;

  // clamp to 0..5 (you can tune)
  return clamp(s, 0, 5);
}

// icons (signal + component icons)
function iconForGap(gap) {
  const g = Math.abs(n(gap) ?? 0);
  if (g >= 60) return "🔥";
  if (g >= 40) return "⚠️";
  if (g >= 20) return "👀";
  return "";
}
function iconForPct(pc) {
  const p = Math.abs(n(pc) ?? 0);
  if (p >= 60) return "🔥";
  if (p >= 20) return "⚠️";
  if (p >= 10) return "👀";
  return "";
}
function iconForVF(vf) {
  const v = n(vf);
  if (v === null) return "";
  if (v >= 8) return "💥";
  if (v >= 4) return "🔥";
  if (v >= 2) return "⚠️";
  return "";
}
function iconForRV(rv) {
  const r = n(rv);
  if (r === null) return "";
  if (r >= 10) return "💥";
  if (r >= 5) return "🔥";
  if (r >= 2) return "⚠️";
  return "";
}

function mainSignalIcon(row) {
  const d = row.demandScore ?? 0;
  if (d >= 5) return "🚀";
  if (d >= 4) return "🔥";
  if (d >= 3) return "👀";
  return "⛔";
}

// section mapping S01..S40
// Rule: top movers should appear early (1-5) for each group.
function sectionCode(row, group) {
  const gap = Math.abs(n(row.gapPct) ?? 0);
  const pc = Math.abs(n(row.pricePct) ?? 0);
  const vf = n(row.volFloatX) ?? 0;
  const rv = n(row.rvolX) ?? 0;

  // intensity score for bucketing (0..~)
  const intensity =
    gap * 0.6 +
    pc * 0.4 +
    Math.min(vf, 20) * 6 +
    Math.min(rv, 20) * 4;

  // convert to 1..40
  let idx = Math.floor(intensity / 10) + 1;
  idx = clamp(idx, 1, 40);

  // Special: for top movers group lists, compress into 1..5
  if (
    group === "mostActive" ||
    group === "topGainers" ||
    group === "topGappers"
  ) {
    idx = clamp(Math.ceil(idx / 8), 1, 5); // 1..5
  }

  return "S" + String(idx).padStart(2, "0");
}

// cap filter
function capBucket(marketCap) {
  const c = n(marketCap);
  if (c === null) return null;
  // assume marketCap is raw dollars (not M)
  // default thresholds (you told me you can change quickly)
  // small: 50M-500M, mid: 500M-2B, large: >2B
  if (c < 50_000_000) return "micro";
  if (c < 500_000_000) return "small";
  if (c < 2_000_000_000) return "mid";
  return "large";
}

// -------------------- MASSIVE FETCH --------------------
async function fetchMassiveQuotes(symbols) {
  const url = MASSIVE_API_URL.replace(/\/+$/, "");
  const params = { symbols: symbols.join(",") };
  const headers = {};

  const auth = massiveAuth({ headers, params });

  const r = await axios.get(url, {
    params: auth.params,
    headers: auth.headers,
    timeout: 20000,
    validateStatus: () => true,
  });

  if (r.status >= 400) {
    const detail =
      typeof r.data === "string"
        ? r.data.slice(0, 200)
        : JSON.stringify(r.data || {}).slice(0, 400);
    throw new Error(`HTTP ${r.status} from Massive. ${detail}`);
  }

  // extract rows from many common shapes
  const data = r.data;
  const rows =
    (Array.isArray(data) && data) ||
    data?.results ||
    data?.data ||
    data?.quoteResponse?.result ||
    data?.quotes ||
    [];

  if (!Array.isArray(rows)) return [];
  return rows;
}

// Optional: movers list by group from Massive (if supported)
async function fetchMovers(group, limit) {
  if (!MASSIVE_MOVER_URL) return null;

  const base = MASSIVE_MOVER_URL.replace(/\/+$/, "");
  const params = { group, limit };
  const headers = {};
  const auth = massiveAuth({ headers, params });

  const r = await axios.get(base, {
    params: auth.params,
    headers: auth.headers,
    timeout: 20000,
    validateStatus: () => true,
  });

  if (r.status >= 400) return null;

  const data = r.data;
  const rows =
    (Array.isArray(data) && data) ||
    data?.results ||
    data?.data ||
    data?.tickers ||
    [];

  if (!Array.isArray(rows)) return null;
  return rows;
}

// -------------------- ROUTES --------------------
app.get("/api", (req, res) => {
  res.json({
    ok: true,
    message: "ALGTP® Massive Scanner running 🚀",
    port: PORT,
    envMissing: envMissing(),
    massive: {
      authType: MASSIVE_AUTH_TYPE,
      hasMoverUrl: Boolean(MASSIVE_MOVER_URL),
    },
    endpoints: [
      "/_massive_test?symbols=NVDA,TSLA,AAPL",
      "/scan?symbols=NVDA,TSLA,AAPL",
      "/active?symbols=NVDA,TSLA,AAPL,AMD,MSFT,META",
      "/group?name=mostActive&limit=300",
    ],
  });
});

// PROBE Massive auth + shape
app.get("/_massive_test", async (req, res) => {
  try {
    const miss = envMissing();
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const symbols = parseSymbols(req.query.symbols || "NVDA,TSLA,AAPL");
    if (!symbols.length) return res.status(400).json({ ok: false, error: "symbols empty" });

    // try all modes (ignore MASSIVE_AUTH_TYPE)
    async function tryMode(mode) {
      const url = MASSIVE_API_URL.replace(/\/+$/, "");
      const params = { symbols: symbols.join(",") };
      const headers = {};

      if (mode === "xapi") headers["x-api-key"] = MASSIVE_API_KEY;
      if (mode === "bearer") headers["authorization"] = `Bearer ${MASSIVE_API_KEY}`;
      if (mode === "query") params[MASSIVE_QUERY_KEYNAME || "apiKey"] = MASSIVE_API_KEY;

      headers["user-agent"] =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari";

      const r = await axios.get(url, {
        params,
        headers,
        timeout: 15000,
        validateStatus: () => true,
      });

      const data = r.data;
      const rows =
        (Array.isArray(data) && data) ||
        data?.results ||
        data?.data ||
        data?.quoteResponse?.result ||
        data?.quotes ||
        [];

      return {
        mode,
        status: r.status,
        ok: r.status < 400,
        rowsType: Array.isArray(rows) ? "array" : typeof rows,
        rowsLen: Array.isArray(rows) ? rows.length : 0,
        sample: Array.isArray(rows) ? rows[0] : null,
      };
    }

    const a = await tryMode("xapi");
    if (a.ok) return res.json({ ok: true, winner: a, note: "Set MASSIVE_AUTH_TYPE=xapi" });

    const b = await tryMode("bearer");
    if (b.ok) return res.json({ ok: true, winner: b, note: "Set MASSIVE_AUTH_TYPE=bearer" });

    const c = await tryMode("query");
    if (c.ok)
      return res.json({
        ok: true,
        winner: c,
        note: `Set MASSIVE_AUTH_TYPE=query and MASSIVE_QUERY_KEYNAME=${MASSIVE_QUERY_KEYNAME || "apiKey"}`,
      });

    return res.status(500).json({
      ok: false,
      error: "All auth modes failed",
      tries: [a, b, c],
      hint: "If all are 404 -> MASSIVE_API_URL wrong endpoint. If 401/403 -> key/auth wrong.",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Massive test failed", detail: String(e.message || e) });
  }
});

// scan quotes for provided symbols
app.get("/scan", async (req, res) => {
  try {
    const miss = envMissing();
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const symbols = parseSymbols(req.query.symbols || "NVDA,TSLA,AAPL");
    if (!symbols.length) return res.status(400).json({ ok: false, error: "symbols empty" });

    const rawRows = await fetchMassiveQuotes(symbols);
    const rows = rawRows.map(normRow).filter(Boolean);

    // attach demand + icons
    const out = rows.map((row) => {
      const d = demandScore(row);
      const gapIcon = iconForGap(row.gapPct);
      const priceIcon = iconForPct(row.pricePct);
      const vfIcon = iconForVF(row.volFloatX);
      const rvolIcon = iconForRV(row.rvolX);

      return {
        symbol: row.symbol,
        price: row.price,
        pricePct: row.pricePct,
        gapPct: row.gapPct,
        volFloatX: row.volFloatX,
        rvolX: row.rvolX,
        marketCap: row.marketCap,
        demandScore: d,
        signalIcon: mainSignalIcon({ demandScore: d }),
        gapIcon,
        priceIcon,
        vfIcon,
        rvolIcon,
      };
    });

    res.json({ ok: true, count: out.length, results: out });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "Scan failed",
      detail: String(e.message || e),
      hint: "Check MASSIVE_API_URL/KEY/auth. Try /_massive_test first.",
    });
  }
});

// active ranking for provided symbols (top 10)
app.get("/active", async (req, res) => {
  try {
    const miss = envMissing();
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const symbols = parseSymbols(req.query.symbols || "NVDA,TSLA,AAPL,AMD,MSFT,META");
    const topN = clamp(Number(req.query.top || 10), 1, 50);

    const rawRows = await fetchMassiveQuotes(symbols);
    const rows = rawRows.map(normRow).filter(Boolean);

    const scored = rows.map((row) => {
      const d = demandScore(row);
      const activityScore =
        Math.abs(n(row.gapPct) ?? 0) * 1.8 +
        Math.abs(n(row.pricePct) ?? 0) * 1.2 +
        (n(row.volFloatX) ?? 0) * 10 +
        (n(row.rvolX) ?? 0) * 6 +
        d * 5;

      return {
        symbol: row.symbol,
        price: row.price,
        pricePct: row.pricePct,
        gapPct: row.gapPct,
        volFloatX: row.volFloatX,
        rvolX: row.rvolX,
        demandScore: d,
        activityScore: round2(activityScore),
        signalIcon: mainSignalIcon({ demandScore: d }),
      };
    });

    scored.sort((a, b) => (b.activityScore || 0) - (a.activityScore || 0));
    res.json({ ok: true, mode: "ACTIVE_TOP", top: scored.slice(0, topN) });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Active failed", detail: String(e.message || e) });
  }
});

// group -> sections S01..S40
app.get("/group", async (req, res) => {
  try {
    const miss = envMissing();
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const name = String(req.query.name || "mostActive");
    const limit = clamp(Number(req.query.limit || 300), 50, 2000);

    // universe source:
    // 1) If MASSIVE_MOVER_URL exists, try fetch movers list for group
    // 2) Else fallback: you MUST pass symbols (because quotes endpoint needs symbols)
    let universeSymbols = [];

    const moverRows = await fetchMovers(name, limit);
    if (moverRows && moverRows.length) {
      // movers rows might contain symbols already
      universeSymbols = moverRows
        .map((x) => String(x.symbol ?? x.ticker ?? x.code ?? "").toUpperCase())
        .filter(Boolean)
        .slice(0, limit);
    } else {
      // fallback: user provides symbols list
      const symbols = parseSymbols(req.query.symbols || "");
      if (!symbols.length) {
        return res.status(400).json({
          ok: false,
          error: "No universe available",
          detail:
            "MASSIVE_MOVER_URL not set (or returned empty). Provide ?symbols=... or set MASSIVE_MOVER_URL.",
        });
      }
      universeSymbols = symbols.slice(0, limit);
    }

    // get quotes for universe
    const rawRows = await fetchMassiveQuotes(universeSymbols);
    const rows0 = rawRows.map(normRow).filter(Boolean);

    // group filters (your rules)
    let rows = rows0;

    // penny zone defined: $2-$20
    const pennyMin = n(req.query.pennyMin ?? 2) ?? 2;
    const pennyMax = n(req.query.pennyMax ?? 20) ?? 20;

    // apply price filter ONLY for cap-specific / penny groups
    // (mostActive/gainers/gappers should not be killed by $2-$20)
    const priceFilterOn =
      ["smallCap", "midCap", "largeCap", "preMarket", "afterHours"].includes(name);

    if (priceFilterOn) {
      rows = rows.filter((r) => r.price !== null && r.price >= pennyMin && r.price <= pennyMax);
    }

    // cap groups (uses marketCap if available)
    if (name === "smallCap") rows = rows.filter((r) => capBucket(r.marketCap) === "small");
    if (name === "midCap") rows = rows.filter((r) => capBucket(r.marketCap) === "mid");
    if (name === "largeCap") rows = rows.filter((r) => capBucket(r.marketCap) === "large");

    // attach metrics + section + icons
    const enriched = rows.map((r) => {
      const d = demandScore(r);
      const gapIcon = iconForGap(r.gapPct);
      const priceIcon = iconForPct(r.pricePct);
      const vfIcon = iconForVF(r.volFloatX);
      const rvolIcon = iconForRV(r.rvolX);

      return {
        symbol: r.symbol,
        price: r.price,
        pricePct: r.pricePct,
        gapPct: r.gapPct,
        volFloatX: r.volFloatX,
        rvolX: r.rvolX,
        demandScore: d,
        signalIcon: mainSignalIcon({ demandScore: d }),
        gapIcon,
        priceIcon,
        vfIcon,
        rvolIcon,
        section: sectionCode(r, name),
      };
    });

    // sort rule by group
    function sortKey(row) {
      if (name === "topLosers") return -(Math.abs(n(row.pricePct) ?? 0)); // still absolute bucket; UI can show neg
      if (name === "topGainers") return Math.abs(n(row.pricePct) ?? 0);
      if (name === "topGappers") return Math.abs(n(row.gapPct) ?? 0);
      if (name === "mostActive") return (n(row.volFloatX) ?? 0) * 10 + (n(row.rvolX) ?? 0) * 6;
      return (n(row.demandScore) ?? 0) * 10 + (n(row.volFloatX) ?? 0) * 8 + (n(row.rvolX) ?? 0) * 6;
    }

    enriched.sort((a, b) => (sortKey(b) || 0) - (sortKey(a) || 0));

    // bucket into sections
    const sections = {};
    for (let i = 1; i <= 40; i++) {
      const code = "S" + String(i).padStart(2, "0");
      sections[code] = [];
    }
    for (const row of enriched) {
      const sec = row.section;
      if (!sections[sec]) sections[sec] = [];
      sections[sec].push(row);
    }

    res.json({
      ok: true,
      group: name,
      universeCount: universeSymbols.length,
      rows: enriched.length,
      sections,
      note:
        moverRows && moverRows.length
          ? "Universe from MASSIVE_MOVER_URL"
          : "Universe from query ?symbols=... (set MASSIVE_MOVER_URL to scan broad market)",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Group failed", detail: String(e.message || e) });
  }
});

// legacy: /sect (alias to group sections for provided symbols)
app.get("/sect", async (req, res) => {
  // keep backward compatible
  req.query.name = req.query.name || "mostActive";
  // Redirect to /group endpoint
  req.url = `/group${req.url.substring(5)}`;
  return app.handle(req, res);
});

// -------------------- START --------------------
app.listen(PORT, () => {
  console.log("🚀 ALGTP® Massive Scanner running:", `http://localhost:${PORT}`);
  console.log("✅ API:", `http://localhost:${PORT}/api`);
  console.log("✅ MASSIVE TEST:", `http://localhost:${PORT}/_massive_test?symbols=NVDA,TSLA,AAPL`);
  console.log("✅ GROUP:", `http://localhost:${PORT}/group?name=mostActive&limit=300&symbols=NVDA,TSLA,AAPL,AMD,MSFT,META`);
});
