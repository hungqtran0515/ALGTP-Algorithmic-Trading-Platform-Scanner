/**
 * ============================================================================
 * 🔥 ALGTP™ Top Movers - Standalone Script
 * ----------------------------------------------------------------------------
 * Quick command-line tool to fetch and display top market movers
 * (gainers/losers) using the Massive API
 * 
 * Usage:
 *   node top-movers.js           # Show top gainers
 *   node top-movers.js gainers   # Show top gainers
 *   node top-movers.js losers    # Show top losers
 * ============================================================================
 */

import "dotenv/config";
import axios from "axios";

// ============================================================================
// CONFIG
// ============================================================================
const MASSIVE_API_KEY = String(process.env.MASSIVE_API_KEY || "").trim();
const MASSIVE_AUTH_TYPE = String(process.env.MASSIVE_AUTH_TYPE || "query").trim();
const MASSIVE_QUERY_KEYNAME = String(process.env.MASSIVE_QUERY_KEYNAME || "apiKey").trim();
const MASSIVE_MOVER_URL = String(
  process.env.MASSIVE_MOVER_URL || "https://api.massive.com/v2/snapshot/locale/us/markets/stocks"
).trim();
const INCLUDE_OTC = String(process.env.INCLUDE_OTC || "false").toLowerCase() === "true";

// ============================================================================
// HELPERS
// ============================================================================
function n(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function round2(x) {
  const v = n(x);
  return v === null ? null : Number(v.toFixed(2));
}

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
// FETCH MOVERS
// ============================================================================
async function fetchMovers(direction = "gainers") {
  const d = String(direction || "gainers").toLowerCase().trim();
  const directionSafe = d === "losers" ? "losers" : "gainers";

  const base = MASSIVE_MOVER_URL.replace(/\/+$/, "");
  const url = `${base}/${directionSafe}`;

  const params = {};
  const headers = {};
  if (INCLUDE_OTC) params["include_otc"] = "true";
  const a = auth(params, headers);

  try {
    const r = await axios.get(url, {
      params: a.params,
      headers: a.headers,
      timeout: 25000,
      validateStatus: () => true,
    });

    if (r.status >= 400) {
      return {
        ok: false,
        error: `HTTP ${r.status}`,
        url,
        data: r.data,
      };
    }

    const rows = Array.isArray(r.data?.tickers)
      ? r.data.tickers
      : Array.isArray(r.data?.results)
      ? r.data.results
      : Array.isArray(r.data?.data)
      ? r.data.data
      : [];

    return {
      ok: true,
      url,
      rows,
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message || String(e),
      url,
    };
  }
}

// ============================================================================
// DISPLAY
// ============================================================================
function displayMovers(rows, direction) {
  console.log("\n" + "=".repeat(80));
  console.log(`🔥 ALGTP™ Top ${direction === "losers" ? "Losers" : "Gainers"}`);
  console.log("=".repeat(80));
  console.log("");

  if (!rows || rows.length === 0) {
    console.log("❌ No data available");
    return;
  }

  // Header
  console.log(
    [
      "Symbol".padEnd(10),
      "Price".padStart(10),
      "Change%".padStart(10),
      "Volume".padStart(15),
    ].join(" | ")
  );
  console.log("-".repeat(80));

  // Display top 20
  const top = rows.slice(0, 20);

  for (const row of top) {
    const symbol = String(row?.ticker ?? row?.symbol ?? row?.sym ?? "").trim().toUpperCase();
    
    // Try multiple field names for price
    const price = n(
      row?.price ??
      row?.last ??
      row?.close ??
      row?.regularMarketPrice ??
      row?.c ??
      row?.day?.c ??
      row?.lastTrade?.p
    );

    // Try multiple field names for change percent
    let changePct = n(
      row?.todaysChangePerc ??
      row?.changePercent ??
      row?.regularMarketChangePercent ??
      row?.pctChange ??
      row?.day?.changePerc
    );

    // If no direct change%, try to calculate from prevClose
    if (changePct === null && price !== null) {
      const prevClose = n(
        row?.prevClose ??
        row?.previousClose ??
        row?.regularMarketPreviousClose ??
        row?.prevDay?.c
      );
      if (prevClose !== null && prevClose > 0) {
        changePct = ((price - prevClose) / prevClose) * 100;
      }
    }

    // Try multiple field names for volume
    const volume = n(
      row?.volume ??
      row?.vol ??
      row?.regularMarketVolume ??
      row?.v ??
      row?.day?.v
    );

    // Format values
    const priceStr = price !== null ? `$${round2(price)}` : "N/A";
    const changePctStr = changePct !== null ? `${round2(changePct)}%` : "N/A";
    const volumeStr = volume !== null ? volume.toLocaleString() : "N/A";

    // Add emoji based on change
    const emoji = changePct !== null ? (changePct >= 10 ? "🔥" : changePct >= 5 ? "🚀" : changePct <= -10 ? "💀" : changePct <= -5 ? "📉" : "  ") : "  ";

    console.log(
      [
        `${emoji} ${symbol}`.padEnd(10),
        priceStr.padStart(10),
        changePctStr.padStart(10),
        volumeStr.padStart(15),
      ].join(" | ")
    );
  }

  console.log("\n" + "=".repeat(80));
  console.log(`Total tickers: ${rows.length} | Showing top ${Math.min(20, rows.length)}`);
  console.log("=".repeat(80) + "\n");
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  // Check API key
  if (!MASSIVE_API_KEY) {
    console.error("❌ Error: MASSIVE_API_KEY not found in .env file");
    process.exit(1);
  }

  // Get direction from command line
  const direction = process.argv[2] || "gainers";
  const validDirection = direction.toLowerCase() === "losers" ? "losers" : "gainers";

  console.log(`\n⏳ Fetching ${validDirection}...`);

  // Fetch movers
  const result = await fetchMovers(validDirection);

  if (!result.ok) {
    console.error(`\n❌ Failed to fetch movers: ${result.error}`);
    if (result.data) {
      console.error("Response data:", JSON.stringify(result.data, null, 2).slice(0, 500));
    }
    process.exit(1);
  }

  // Display results
  displayMovers(result.rows, validDirection);
}

// Run
main().catch((e) => {
  console.error("❌ Unexpected error:", e.message || String(e));
  process.exit(1);
});
