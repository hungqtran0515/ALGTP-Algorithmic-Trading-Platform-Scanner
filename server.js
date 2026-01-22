/**
 * server.js — ALGTP™ – Algorithmic Trading Platform Scanner (FULL + Multi-Page UI + Alerts + Auto Refresh + Scan Symbols)
 *
 * Features:
 * - Single list (no S05/S04 sections)
 * - Groups: topGainers | topLosers | topGappers
 * - Filters: cap=all|small|mid|big, minGap (for gappers)
 * - Adds: Float + MarketCap (auto-detect if present in snapshot)
 * - UI Pages:
 *    /ui            (dashboard)
 *    /ui/gainers    (preset)
 *    /ui/losers     (preset)
 *    /ui/gappers    (preset + minGap=10)
 *    /ui/smallcap   (preset cap=small)
 *    /ui/midcap     (preset cap=mid)
 *    /ui/bigcap     (preset cap=big)
 *
 * - Alerts (UI):
 *    Sound + Desktop notifications (anti-spam per symbol per session)
 * - Auto Refresh (UI):
 *    Toggle + interval seconds, refreshes current mode (Group scan or Symbols scan)
 * - Symbols Scan:
 *    GET /scan?symbols=NVDA,TSLA,AAPL
 */

require("dotenv").config();
const express = require("express");
const axios = require("axios");



/* =========================
   ✅ MINIMAL SMS OTP LOGIN (ONLY)
   - No token/HMAC/device bind/plan lock
   - After verify: set cookie algtp_login=1
   - Guard only: /ui* + /list + /scan
   - SMS provider: Twilio
========================= */

const twilio = require("twilio");

// Twilio ENV
const TWILIO_ACCOUNT_SID = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
const TWILIO_FROM = String(process.env.TWILIO_FROM || "").trim(); // ex: "+1xxxxxxxxxx"
const OTP_TTL_SEC = Math.max(60, Number(process.env.OTP_TTL_SEC || 300)); // 5 min
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "false").toLowerCase() === "true";

const hasTwilio = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM;
const tw = hasTwilio ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

// store OTP in memory: phone -> { otp, expMs }
const otpStore = new Map();

function nowMs() {
  return Date.now();
}

function cleanupOtp() {
  const t = nowMs();
  for (const [k, v] of otpStore.entries()) if (v.expMs <= t) otpStore.delete(k);
}

function parseCookie(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  raw.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function setCookie(res, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax", `Max-Age=${maxAgeSec}`];
  // bạn muốn tối giản => không bắt buộc HttpOnly
  // nếu muốn an toàn hơn chút thì thêm HttpOnly
  // parts.push("HttpOnly");

  if (COOKIE_SECURE) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function normalizePhone(input) {
  let s = String(input || "").trim();
  if (!s) return null;

  // remove spaces/dashes/()
  s = s.replace(/[^\d+]/g, "");

  // +1xxxxxxxxxx
  if (s.startsWith("+")) {
    const digits = s.slice(1).replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
    if (digits.length === 10) return "+1" + digits;
    return null;
  }

  // digits only: 12199868683 or 2199868683
  const digits = s.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  return null;
}

/* ---- Login Page (simple) ---- */
function renderLoginPage(msg = "") {
  return `<!doctype html>
<html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ALGTP Login</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0b0d12;color:#e6e8ef;font-family:system-ui}
.box{max-width:560px;margin:10vh auto;padding:18px;border-radius:14px;border:1px solid rgba(255,255,255,.14);background:rgba(18,24,43,.55)}
input,button{width:100%;box-sizing:border-box;background:#121622;border:1px solid rgba(255,255,255,.12);color:#e6e8ef;border-radius:10px;padding:12px;font-size:14px}
button{cursor:pointer;margin-top:10px}
.muted{opacity:.8;font-size:13px;line-height:1.6}
.err{margin-top:10px;color:#ffb4b4}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;opacity:.75}
</style>
</head><body>
<div class="box">
  <h2 style="margin:0 0 10px;">🔐 Login (SMS OTP)</h2>
  <div class="muted">Chỉ SMS OTP verify là vào được. Scanner giữ nguyên.</div>
  <div class="mono" style="margin-top:8px;">Format: 12199868683 / 2199868683 / +12199868683</div>
  ${msg ? `<div class="err">${msg}</div>` : ""}

  <input id="phone" placeholder="Phone" />
  <button onclick="startOtp()">Send OTP</button>

  <input id="otp" placeholder="OTP 6 digits" style="margin-top:12px;" />
  <button onclick="verifyOtp()">Verify</button>

  <div class="muted" style="margin-top:12px;">Sau verify: tự chuyển qua <span class="mono">/ui</span></div>
</div>

<script>
async function startOtp(){
  const phone = document.getElementById("phone").value.trim();
  const r = await fetch("/auth/start", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ phone })
  });
  const d = await r.json();
  if(!d.ok) alert("Error: " + (d.error||"failed"));
  else alert("OTP sent");
}
async function verifyOtp(){
  const phone = document.getElementById("phone").value.trim();
  const otp = document.getElementById("otp").value.trim();
  const r = await fetch("/auth/verify", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ phone, otp })
  });
  const d = await r.json();
  if(!d.ok) alert("Error: " + (d.error||"failed"));
  else location.href="/ui";
}
</script>
</body></html>`;
}

const app = express();
app.use(express.json());

// ✅ login routes
app.get("/login", (req, res) => res.type("html").send(renderLoginPage()));

/* ---- Send OTP ---- */
app.post("/auth/start", async (req, res) => {
  try {
    cleanupOtp();
    if (!hasTwilio) return res.status(500).json({ ok: false, error: "Twilio env missing" });

    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ ok: false, error: "Invalid phone" });

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    otpStore.set(phone, { otp, expMs: nowMs() + OTP_TTL_SEC * 1000 });

    await tw.messages.create({
      from: TWILIO_FROM,
      to: phone,
      body: `ALGTP OTP: ${otp} (exp ${Math.round(OTP_TTL_SEC / 60)}m)`,
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "send_failed", detail: String(e?.message || e) });
  }
});

/* ---- Verify OTP -> set login cookie ---- */
app.post("/auth/verify", (req, res) => {
  cleanupOtp();

  const phone = normalizePhone(req.body?.phone);
  const otp = String(req.body?.otp || "").trim();

  if (!phone) return res.status(400).json({ ok: false, error: "Invalid phone" });
  if (!/^\d{6}$/.test(otp)) return res.status(400).json({ ok: false, error: "OTP must be 6 digits" });

  const rec = otpStore.get(phone);
  if (!rec) return res.status(401).json({ ok: false, error: "OTP expired/not found" });
  if (rec.expMs <= nowMs()) {
    otpStore.delete(phone);
    return res.status(401).json({ ok: false, error: "OTP expired" });
  }
  if (rec.otp !== otp) return res.status(401).json({ ok: false, error: "OTP wrong" });

  otpStore.delete(phone);

  // ✅ Minimal login flag cookie (7 days)
  setCookie(res, "algtp_login", "1", 7 * 24 * 3600);

  res.json({ ok: true });
});

/* ---- Optional logout ---- */
app.post("/logout", (req, res) => {
  setCookie(res, "algtp_login", "", 0);
  res.json({ ok: true });
});

/* ---- Guard ONLY scanner endpoints ---- */
app.use((req, res, next) => {
  const path = req.path || "";

  const needsLogin =
    path === "/ui" || path.startsWith("/ui/") || path === "/list" || path === "/scan";

  if (!needsLogin) return next();

  const cookies = parseCookie(req);
  if (cookies.algtp_login === "1") return next();

  // not logged in -> go login
  return res.status(401).type("html").send(renderLoginPage("Please login by SMS OTP"));
});

// ---------------- ENV ----------------
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

const INCLUDE_OTC = String(process.env.INCLUDE_OTC || "false").toLowerCase() === "true";
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
  else params[MASSIVE_QUERY_KEYNAME || "apiKey"] = MASSIVE_API_KEY;

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

// ---------------- scoring (icon + alerts) ----------------
function demandScore(row) {
  const gap = Math.abs(n(row?.gapPct) ?? 0);
  const pc = Math.abs(n(row?.pricePct) ?? 0);

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

// ---------------- axios safe ----------------
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

// ---------------- Massive calls ----------------
async function fetchMovers(direction = "gainers") {
  const d = String(direction || "gainers").toLowerCase().trim();
  const directionSafe = d === "losers" ? "losers" : "gainers";

  const base = MASSIVE_MOVER_URL.replace(/\/+$/, "");
  const url = `${base}/${directionSafe}`;

  const params = {};
  const headers = {};
  if (INCLUDE_OTC) params["include_otc"] = "true";
  const a = auth(params, headers);

  const r = await safeGet(url, { params: a.params, headers: a.headers });

  const rows = Array.isArray(r.data?.tickers)
    ? r.data.tickers
    : Array.isArray(r.data?.results)
    ? r.data.results
    : Array.isArray(r.data?.data)
    ? r.data.data
    : null;

  return {
    ok: r.ok && Array.isArray(rows),
    url,
    status: r.status,
    rows: Array.isArray(rows) ? rows : [],
    sample: Array.isArray(rows) ? rows[0] : r.data,
    errorDetail: r.errorDetail,
  };
}

async function fetchTickerSnapshot(ticker) {
  const base = MASSIVE_TICKER_SNAPSHOT_URL.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(String(ticker || "").trim().toUpperCase())}`;

  const params = {};
  const headers = {};
  const a = auth(params, headers);

  const r = await safeGet(url, { params: a.params, headers: a.headers });
  return { ok: r.ok, url, status: r.status, data: r.data, errorDetail: r.errorDetail };
}

// ---------------- auto-detect fields ----------------
function findFirstNumberByKeys(obj, candidateKeys, maxNodes = 6000) {
  if (!obj || typeof obj !== "object") return { value: null, path: null, keyMatched: null };

  const wanted = new Set(candidateKeys.map((k) => String(k).toLowerCase()));
  const q = [{ v: obj, path: "root" }];
  let visited = 0;

  while (q.length && visited < maxNodes) {
    const { v, path } = q.shift();
    visited++;

    if (!v || typeof v !== "object") continue;

    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const item = v[i];
        if (item && typeof item === "object") q.push({ v: item, path: `${path}[${i}]` });
      }
      continue;
    }

    for (const k of Object.keys(v)) {
      const keyLower = String(k).toLowerCase();
      const val = v[k];

      if (wanted.has(keyLower)) {
        const num = n(val);
        if (num !== null) return { value: num, path: `${path}.${k}`, keyMatched: k };
      }

      if (val && typeof val === "object") q.push({ v: val, path: `${path}.${k}` });
    }
  }

  return { value: null, path: null, keyMatched: null };
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

  if (price === null) {
    const fp = findFirstNumberByKeys(root, ["price", "last", "lastprice", "last_price", "p", "c", "close"]);
    price = fp.value;
  }

  if (open === null) {
    const fo = findFirstNumberByKeys(root, ["open", "o"]);
    open = fo.value;
  }

  let prevC = prevClose;
  if (prevC === null) {
    const fpc = findFirstNumberByKeys(root, ["prevclose", "previousclose", "prev_close", "pc", "prevc"]);
    prevC = fpc.value;
  }

  if (volume === null) {
    const fv = findFirstNumberByKeys(root, ["volume", "v", "dayvolume", "day_volume"]);
    volume = fv.value;
  }

  if (pricePct === null) {
    const fchg = findFirstNumberByKeys(root, [
      "todayschangeperc",
      "todayschangepercent",
      "changepct",
      "changepercent",
      "pctchange",
      "percentchange",
    ]);
    pricePct = fchg.value;
  }

  if (pricePct === null && price !== null && prevC !== null && prevC > 0) {
    pricePct = ((price - prevC) / prevC) * 100;
  }

  const gapPct = open !== null && prevC !== null && prevC > 0 ? ((open - prevC) / prevC) * 100 : null;

  // Float
  let floatShares = n(root?.float) ?? n(root?.freeFloat) ?? n(root?.sharesFloat) ?? n(root?.floatShares) ?? null;

  if (floatShares === null) {
    const ff = findFirstNumberByKeys(root, [
      "float",
      "freefloat",
      "free_float",
      "sharesfloat",
      "floatshares",
      "publicfloat",
      "public_float",
    ]);
    floatShares = ff.value;
  }

  // Market cap
  let marketCap =
    n(root?.marketCap) ??
    n(root?.marketcap) ??
    n(root?.mktcap) ??
    n(root?.market_cap) ??
    n(root?.marketCapitalization) ??
    null;

  if (marketCap === null) {
    const mc = findFirstNumberByKeys(root, [
      "marketcap",
      "marketCap",
      "mktcap",
      "market_cap",
      "marketcapitalization",
      "marketCapitalization",
      "cap",
      "capitalization",
    ]);
    marketCap = mc.value;
  }

  return {
    symbol: String(ticker || "").trim().toUpperCase(),
    price: price !== null ? round2(price) : null,
    pricePct: pricePct !== null ? round2(pricePct) : null,
    gapPct: gapPct !== null ? round2(gapPct) : null,
    volume: volume !== null ? Math.round(volume) : null,

    floatShares: floatShares !== null ? Math.round(floatShares) : null,
    floatM: floatShares !== null ? round2(floatShares / 1_000_000) : null,
    floatCat: floatCategory(floatShares),

    marketCap: marketCap !== null ? Math.round(marketCap) : null,
    marketCapB: marketCap !== null ? round2(marketCap / 1_000_000_000) : null,
    cap: capCategory(marketCap),
  };
}

// ---------------- group + sorting ----------------
function groupToDirection(group) {
  if (group === "topLosers") return "losers";
  return "gainers";
}

function sortRowsByGroup(rows, group) {
  if (group === "topGappers") {
    rows.sort((a, b) => Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0));
    return;
  }
  rows.sort((a, b) => Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0));
}

function capPass(row, cap) {
  const c = String(cap || "all").toLowerCase();
  if (c === "all") return true;
  if (!row.cap) return false;
  return row.cap === c;
}

// ---------------- UI ----------------
function renderUI(preset = {}) {
  const presetGroup = preset.group || "topGainers";
  const presetCap = preset.cap || "all";
  const presetLimit = preset.limit || 50;
  const presetMinGap = preset.minGap ?? "";
  const presetSymbols = preset.symbols ?? "NVDA,TSLA,AAPL";
  const active = (path) => (preset.path === path ? "opacity:1" : "opacity:.65");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>ALGTP™ – Algorithmic Trading Platform Scanner</title>
  <style>
    :root { color-scheme: dark; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b0d12; color:#e6e8ef;}
    header { padding:16px 18px; border-bottom:1px solid rgba(255,255,255,.08); position:sticky; top:0; background:rgba(11,13,18,.92); backdrop-filter: blur(10px); z-index:20; }
    h1 { margin:0; font-size:16px; }
    .sub { margin-top:6px; font-size:12px; color:#a7adc2; }
    .wrap { max-width:1400px; margin:0 auto; }
    .panel { padding:14px 18px; border-bottom:1px solid rgba(255,255,255,.06); }
    .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    select, input, button { background:#121622; border:1px solid rgba(255,255,255,.12); color:#e6e8ef; border-radius:10px; padding:10px 12px; font-size:13px; outline:none; }
    input { min-width:220px; }
    button { cursor:pointer; }
    button:hover { border-color: rgba(255,255,255,.22); }
    .hint { font-size:12px; color:#a7adc2; margin-top:8px; }
    .badge { display:inline-flex; align-items:center; gap:8px; padding:6px 10px; border-radius:999px; background:#121622; border:1px solid rgba(255,255,255,.12); font-size:12px; color:#c8cde0; }
    .grid { padding:14px 18px; }
    .card { border:1px solid rgba(255,255,255,.10); border-radius:14px; overflow:hidden; }
    .cardHead { padding:10px 12px; display:flex; align-items:center; justify-content:space-between; background:#121622; border-bottom:1px solid rgba(255,255,255,.08); }
    .title { font-size:13px; font-weight:600; }
    .meta { font-size:12px; color:#a7adc2; }
    table { width:100%; border-collapse:collapse; }
    th, td { padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.06); font-size:13px; }
    th { text-align:left; color:#a7adc2; font-weight:600; }
    tr:hover td { background: rgba(255,255,255,.03); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .right { text-align:right; }
    .err { white-space:pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size:12px; color:#ffb4b4; background:#1a0f12; border:1px solid rgba(255,128,128,.25); border-radius:12px; padding:10px 12px; margin-top:12px; display:none; }
    .nav { display:flex; gap:10px; flex-wrap:wrap; margin-top:10px; }
    .nav a { text-decoration:none; color:#c8cde0; background:#121622; border:1px solid rgba(255,255,255,.12); padding:8px 10px; border-radius:999px; font-size:12px; }
    .nav a:hover { border-color: rgba(255,255,255,.22); }
    .watermark{ position: fixed; bottom: 12px; right: 16px; font-size: 11px; color: rgba(230,232,239,.35); letter-spacing: .3px; pointer-events: none; user-select: none; z-index: 9999; }
    .pill { display:inline-flex; align-items:center; gap:8px; padding:8px 10px; border-radius:999px; background:#121622; border:1px solid rgba(255,255,255,.12); font-size:12px; color:#c8cde0; }
    .pill input[type="checkbox"]{ transform: translateY(1px); }
    .symLink { color:#e6e8ef; text-decoration:none; border-bottom:1px dashed rgba(255,255,255,.25); cursor:pointer; }
    .symLink:hover { border-bottom-color: rgba(255,255,255,.55); }

    /* Modal */
    .modalBack { position:fixed; inset:0; background: rgba(0,0,0,.65); display:none; align-items:center; justify-content:center; z-index:50; }
    .modal { width:min(1100px, 94vw); height:min(720px, 88vh); background:#0b0d12; border:1px solid rgba(255,255,255,.16); border-radius:16px; overflow:hidden; box-shadow: 0 18px 70px rgba(0,0,0,.55); }
    .modalTop { display:flex; gap:10px; align-items:center; justify-content:space-between; padding:10px 12px; background:#121622; border-bottom:1px solid rgba(255,255,255,.10); }
    .modalTitle { font-weight:700; font-size:13px; }
    .modalTools { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .modalClose { cursor:pointer; border:1px solid rgba(255,255,255,.18); background:#121622; color:#e6e8ef; border-radius:10px; padding:8px 10px; }
    .modalClose:hover { border-color: rgba(255,255,255,.28); }
    .chartBox { width:100%; height: calc(100% - 52px); }
  </style>
</head>
<body>
<header>
  <div class="wrap">
    <h1>ALGTP™ – Algorithmic Trading Platform Scanner</h1>
    <div class="sub">Gainers • Losers • Gappers • Small/Mid/Big Cap • Alerts • Auto Refresh • Scan Symbols • Click ticker for chart</div>

    <div class="nav">
      <a href="/ui" style="${active("/ui")}">Dashboard</a>
      <a href="/ui/gainers" style="${active("/ui/gainers")}">Gainers</a>
      <a href="/ui/losers" style="${active("/ui/losers")}">Losers</a>
      <a href="/ui/gappers" style="${active("/ui/gappers")}">Gappers</a>
      <a href="/ui/smallcap" style="${active("/ui/smallcap")}">Small Cap</a>
      <a href="/ui/midcap" style="${active("/ui/midcap")}">Mid Cap</a>
      <a href="/ui/bigcap" style="${active("/ui/bigcap")}">Big Cap</a>
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
      </select>

      <select id="cap">
        <option value="all">Cap: All</option>
        <option value="small">Cap: Small (&lt;2B)</option>
        <option value="mid">Cap: Mid (2B–10B)</option>
        <option value="big">Cap: Big (&gt;10B)</option>
      </select>

      <select id="limit">
        <option>20</option><option>30</option><option>50</option><option>100</option><option>150</option>
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

      <input id="alertScore" placeholder="Alert score >= (default 4)" style="min-width:180px;" />
      <input id="alertGap" placeholder="Alert gap% >= (default 20)" style="min-width:180px;" />
      <input id="alertPrice" placeholder="Alert price% >= (default 20)" style="min-width:200px;" />

      <button id="clearAlertsBtn">Clear Alert Memory</button>
    </div>

    <div class="row" style="margin-top:10px;">
      <span class="pill"><input id="autoOn" type="checkbox" /> Auto Refresh</span>
      <input id="autoSec" placeholder="Refresh seconds (default 30)" style="min-width:200px;" />
      <span class="badge" id="countdownBadge">-</span>
      <button id="applyAutoBtn">Apply</button>
      <button id="stopAutoBtn">Stop</button>
    </div>

    <div class="hint">
      Click any ticker to open a TradingView chart. If a symbol does not load, switch exchange in the chart (NASDAQ/NYSE/AMEX).
    </div>

    <div class="err" id="errBox"></div>
  </div>
</div>

<div class="grid">
  <div class="wrap" id="out"></div>
</div>

<div class="watermark">Powered by ALGTP™</div>

<!-- Chart Modal -->
<div class="modalBack" id="modalBack" aria-hidden="true">
  <div class="modal" role="dialog" aria-modal="true">
    <div class="modalTop">
      <div class="modalTitle" id="modalTitle">Chart</div>
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

<script src="https://s3.tradingview.com/tv.js"></script>

<script>
const PRESET = ${JSON.stringify({
    group: presetGroup,
    cap: presetCap,
    limit: presetLimit,
    minGap: presetMinGap,
    symbols: presetSymbols,
  })};

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

// -------- Alerts --------
const alerted = new Set();
function toNumOrDefault(val, def){
  const v = Number(String(val ?? "").trim());
  return Number.isFinite(v) ? v : def;
}
function beep(){
  try{
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.value = 0.05;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(()=>{ o.stop(); ctx.close(); }, 160);
  }catch(e){}
}
function pushNotification(title, body){
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try{ new Notification(title, { body }); }catch(e){}
}
function getAlertCfg(){
  return {
    alertsOn: byId("alertsOn").checked,
    soundOn: byId("soundOn").checked,
    desktopOn: byId("desktopOn").checked,
    scoreTh: toNumOrDefault(byId("alertScore").value, 4),
    gapTh: toNumOrDefault(byId("alertGap").value, 20),
    priceTh: toNumOrDefault(byId("alertPrice").value, 20),
  };
}
function shouldAlertRow(r, cfg){
  if (!cfg.alertsOn) return false;
  if (!r || !r.symbol) return false;
  if (alerted.has(r.symbol)) return false;
  const score = Number(r.demandScore ?? 0);
  const gap = Number(r.gapPct ?? 0);
  const pc = Number(r.pricePct ?? 0);
  return (score >= cfg.scoreTh) || (gap >= cfg.gapTh) || (pc >= cfg.priceTh);
}
function fireAlert(r, cfg){
  alerted.add(r.symbol);
  const parts = [];
  if (r.pricePct != null) parts.push(\`Price%: \${r.pricePct}%\`);
  if (r.gapPct != null) parts.push(\`Gap%: \${r.gapPct}%\`);
  if (r.floatM != null) parts.push(\`Float(M): \${r.floatM}\`);
  if (r.marketCapB != null) parts.push(\`MCap(B): \${r.marketCapB}\`);
  const body = parts.join(" | ") || "Signal";
  if (cfg.soundOn) beep();
  if (cfg.desktopOn) pushNotification(\`\${r.signalIcon || ""} \${r.symbol}\`, body);
}
function runAlerts(data){
  const cfg = getAlertCfg();
  const rows = Array.isArray(data.results) ? data.results : [];
  for (const r of rows){
    if (shouldAlertRow(r, cfg)) fireAlert(r, cfg);
  }
}
async function enableNotifications(){
  if (!("Notification" in window)){
    alert("Notifications are not supported in this browser.");
    return;
  }
  const p = await Notification.requestPermission();
  if (p === "granted") {
    try { new Notification("ALGTP™ Alerts enabled", { body: "Desktop notifications are ON." }); } catch(e){}
  } else {
    alert("Notification permission not granted.");
  }
}

// -------- Chart Modal (click ticker) --------
const modalBack = byId("modalBack");
const modalTitle = byId("modalTitle");
const chartBox = byId("chartBox");
const exSel = byId("exSel");
const tfSel = byId("tfSel");
let currentSymbol = null;

function openModal(){
  modalBack.style.display = "flex";
  modalBack.setAttribute("aria-hidden", "false");
}
function closeModal(){
  modalBack.style.display = "none";
  modalBack.setAttribute("aria-hidden", "true");
  chartBox.innerHTML = "";
  currentSymbol = null;
}
function buildTvSymbol(sym){
  const ex = exSel.value || "NASDAQ";
  return ex + ":" + sym;
}
function renderChart(sym){
  if (!window.TradingView || !window.TradingView.widget){
    alert("TradingView library failed to load.");
    return;
  }
  chartBox.innerHTML = '<div id="tv_chart" style="width:100%;height:100%;"></div>';
  const tvSymbol = buildTvSymbol(sym);
  const interval = tfSel.value || "5";

  try{
    new TradingView.widget({
      autosize: true,
      symbol: tvSymbol,
      interval: interval,
      timezone: "America/New_York",
      theme: "dark",
      style: "1",
      locale: "en",
      enable_publishing: false,
      allow_symbol_change: true,
      container_id: "tv_chart"
    });
  }catch(e){
    alert(String(e?.message || e));
  }
}
function openChart(sym){
  currentSymbol = sym;
  modalTitle.textContent = "Chart — " + sym;
  openModal();
  renderChart(sym);
}

byId("closeBtn").addEventListener("click", closeModal);
modalBack.addEventListener("click", (e)=>{ if (e.target === modalBack) closeModal(); });
document.addEventListener("keydown", (e)=>{ if (e.key === "Escape") closeModal(); });

exSel.addEventListener("change", ()=>{ if (currentSymbol) renderChart(currentSymbol); });
tfSel.addEventListener("change", ()=>{ if (currentSymbol) renderChart(currentSymbol); });

// -------- Render Table --------
function renderList(data){
  const rows = Array.isArray(data.results) ? data.results : [];
  const titleRight = data.mode === "symbols"
    ? \`Symbols • \${rows.length} rows\`
    : \`\${data.group} • cap=\${data.cap} • \${rows.length} rows\`;

  out.innerHTML = \`
    <div class="card">
      <div class="cardHead">
        <div class="title">\${data.mode === "symbols" ? "Scan Symbols" : "Scan Group"}</div>
        <div class="meta">\${titleRight}</div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Icon</th>
            <th>Symbol</th>
            <th class="right">Price</th>
            <th class="right">Price%</th>
            <th class="right">Gap%</th>
            <th class="right">Vol</th>
            <th class="right">Float(M)</th>
            <th>FloatCat</th>
            <th class="right">MCap(B)</th>
            <th>Cap</th>
            <th class="right">Score</th>
          </tr>
        </thead>
        <tbody>
          \${rows.map(r => \`
            <tr>
              <td>\${r.signalIcon || ""}</td>
              <td class="mono">
                <a class="symLink" href="javascript:void(0)" onclick="openChart('\${String(r.symbol||"").replace(/'/g,"") }')">\${r.symbol || ""}</a>
              </td>
              <td class="right mono">\${fmtNum(r.price)}</td>
              <td class="right mono">\${fmtNum(r.pricePct)}%</td>
              <td class="right mono">\${fmtNum(r.gapPct)}%</td>
              <td class="right mono">\${fmtInt(r.volume)}</td>
              <td class="right mono">\${fmtNum(r.floatM)}</td>
              <td>\${r.floatCat || "-"}</td>
              <td class="right mono">\${fmtNum(r.marketCapB)}</td>
              <td>\${r.cap || "-"}</td>
              <td class="right mono">\${r.demandScore ?? "-"}</td>
            </tr>
          \`).join("")}
        </tbody>
      </table>
    </div>
  \`;
}

// -------- Auto Refresh --------
let autoTimer = null;
let countdownTimer = null;
let countdown = 0;

function stopAuto(){
  if (autoTimer) clearInterval(autoTimer);
  if (countdownTimer) clearInterval(countdownTimer);
  autoTimer = null;
  countdownTimer = null;
  countdown = 0;
  countdownBadge.textContent = "-";
  byId("autoOn").checked = false;
}

function startAuto(seconds){
  stopAuto();
  byId("autoOn").checked = true;

  countdown = seconds;
  countdownBadge.textContent = \`Next refresh in \${countdown}s\`;

  countdownTimer = setInterval(()=>{
    countdown -= 1;
    if (countdown <= 0) countdown = seconds;
    countdownBadge.textContent = \`Next refresh in \${countdown}s\`;
  }, 1000);

  autoTimer = setInterval(()=>{ run(); }, seconds * 1000);
}

function applyAuto(){
  const on = byId("autoOn").checked;
  const sec = toNumOrDefault(byId("autoSec").value, 30);
  const safeSec = Math.max(5, Math.min(3600, sec));
  if (!on) { stopAuto(); return; }
  startAuto(safeSec);
}

// -------- Run (Mode aware) --------
async function run(){
  clearError();
  out.innerHTML = "";
  setStatus("Loading...");

  const mode = byId("mode").value;
  let url = "";

  if (mode === "symbols"){
    const symbols = byId("symbols").value.trim() || "NVDA,TSLA,AAPL";
    url = \`/scan?symbols=\${encodeURIComponent(symbols)}\`;
  } else {
    const group = byId("group").value;
    const cap = byId("cap").value;
    const limit = byId("limit").value;
    const minGap = byId("minGap").value.trim();

    url = \`/list?group=\${encodeURIComponent(group)}&cap=\${encodeURIComponent(cap)}&limit=\${encodeURIComponent(limit)}\`;
    if (minGap) url += \`&minGap=\${encodeURIComponent(minGap)}\`;
  }

  try{
    const r = await fetch(url);
    const data = await r.json();
    if (!data.ok){
      setStatus("Error");
      showError(data);
      return;
    }
    setStatus(\`OK (\${data.results.length} rows)\`);
    renderList(data);
    runAlerts(data);

    if (data.snapshotErrors && data.snapshotErrors.length){
      showError({ snapshotErrors: data.snapshotErrors });
    }
  }catch(e){
    setStatus("Error");
    showError(String(e?.message || e));
  }
}

function setPreset(){
  byId("group").value = PRESET.group;
  byId("cap").value = PRESET.cap;
  byId("limit").value = String(PRESET.limit);
  byId("minGap").value = PRESET.minGap ?? "";
  byId("symbols").value = PRESET.symbols ?? "NVDA,TSLA,AAPL";

  byId("alertScore").value = "4";
  byId("alertGap").value = "20";
  byId("alertPrice").value = "20";

  byId("autoSec").value = "30";
  countdownBadge.textContent = "-";
}

byId("runBtn").addEventListener("click", run);
byId("notifyBtn").addEventListener("click", enableNotifications);
byId("clearAlertsBtn").addEventListener("click", ()=>{
  alerted.clear();
  alert("Alert memory cleared.");
});

byId("applyAutoBtn").addEventListener("click", applyAuto);
byId("stopAutoBtn").addEventListener("click", stopAuto);

byId("mode").addEventListener("change", ()=>{ stopAuto(); });

setPreset();
run();
</script>
</body>
</html>`;
}

// ---------------- UI routes ----------------
app.get("/ui", (req, res) => res.type("html").send(renderUI({ path: "/ui", group: "topGainers", cap: "all", limit: 50 })));
app.get("/ui/gainers", (req, res) =>
  res.type("html").send(renderUI({ path: "/ui/gainers", group: "topGainers", cap: "all", limit: 50 }))
);
app.get("/ui/losers", (req, res) =>
  res.type("html").send(renderUI({ path: "/ui/losers", group: "topLosers", cap: "all", limit: 50 }))
);
app.get("/ui/gappers", (req, res) =>
  res.type("html").send(renderUI({ path: "/ui/gappers", group: "topGappers", cap: "all", limit: 80, minGap: 10 }))
);
app.get("/ui/smallcap", (req, res) =>
  res.type("html").send(renderUI({ path: "/ui/smallcap", group: "topGainers", cap: "small", limit: 80 }))
);
app.get("/ui/midcap", (req, res) =>
  res.type("html").send(renderUI({ path: "/ui/midcap", group: "topGainers", cap: "mid", limit: 80 }))
);
app.get("/ui/bigcap", (req, res) =>
  res.type("html").send(renderUI({ path: "/ui/bigcap", group: "topGainers", cap: "big", limit: 80 }))
);

// ---------------- API routes ----------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "ALGTP™ – Algorithmic Trading Platform Scanner running ✅",
    ui: "/ui",
    pages: ["/ui", "/ui/gainers", "/ui/losers", "/ui/gappers", "/ui/smallcap", "/ui/midcap", "/ui/bigcap"],
    examples: ["/list?group=topGappers&limit=80&cap=all&minGap=10", "/scan?symbols=NVDA,TSLA,AAPL"],
  });
});

app.get("/api", (req, res) => {
  res.json({
    ok: true,
    envMissing: envMissing(),
    config: {
      port: PORT,
      authType: MASSIVE_AUTH_TYPE,
      queryKeyName: MASSIVE_QUERY_KEYNAME,
      moverUrl: MASSIVE_MOVER_URL,
      tickerSnapshotUrl: MASSIVE_TICKER_SNAPSHOT_URL,
      includeOtc: INCLUDE_OTC,
      snapConcurrency: SNAP_CONCURRENCY,
      debug: DEBUG,
    },
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

// Symbols scan endpoint (for TSLA/NVDA anytime)
app.get("/scan", async (req, res) => {
  try {
    const miss = envMissing();
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const symbols = parseSymbols(req.query.symbols || "NVDA,TSLA,AAPL").slice(0, 100);

    const snaps = await mapPool(symbols, SNAP_CONCURRENCY, async (t) => {
      const r = await fetchTickerSnapshot(t);
      return { ticker: t, ...r };
    });

    const good = snaps.filter((x) => x.ok);
    const bad = snaps.filter((x) => !x.ok);

    let rows = good.map((x) => normalizeSnapshotAuto(x.ticker, x.data));
    rows = rows.map((r) => {
      const d = demandScore(r);
      return { ...r, demandScore: d, signalIcon: signalIcon(d) };
    });

    rows.sort(
      (a, b) =>
        (b.demandScore ?? 0) - (a.demandScore ?? 0) || Math.abs(b.pricePct ?? 0) - Math.abs(a.pricePct ?? 0)
    );

    res.json({
      ok: true,
      mode: "symbols",
      results: rows,
      snapshotErrors: DEBUG
        ? bad.slice(0, 10).map((x) => ({ ticker: x.ticker, status: x.status, url: x.url, errorDetail: x.errorDetail }))
        : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Scan failed", detail: String(e?.message || e) });
  }
});

// Group list endpoint
app.get("/list", async (req, res) => {
  try {
    const miss = envMissing();
    if (miss.length) return res.status(400).json({ ok: false, error: "Missing env", miss });

    const group = String(req.query.group || "topGainers").trim();
    const cap = String(req.query.cap || "all").trim().toLowerCase();
    const limit = clamp(Number(req.query.limit || 50), 5, 200);
    const minGap = n(req.query.minGap);

    const direction = groupToDirection(group);
    const movers = await fetchMovers(direction);
    if (!movers.ok) return res.status(500).json({ ok: false, error: "Movers failed", moverDebug: movers });

    const tickers = movers.rows
      .map((x) => String(x?.ticker ?? x?.symbol ?? x?.sym ?? "").trim().toUpperCase())
      .filter(Boolean)
      .slice(0, limit);

    const snaps = await mapPool(tickers, SNAP_CONCURRENCY, async (t) => {
      const r = await fetchTickerSnapshot(t);
      return { ticker: t, ...r };
    });

    const good = snaps.filter((x) => x.ok);
    const bad = snaps.filter((x) => !x.ok);

    let rows = good.map((x) => normalizeSnapshotAuto(x.ticker, x.data));
    rows = rows.map((r) => {
      const d = demandScore(r);
      return { ...r, demandScore: d, signalIcon: signalIcon(d) };
    });

    rows = rows.filter((r) => capPass(r, cap));

    if (minGap !== null && Number.isFinite(minGap)) {
      rows = rows.filter((r) => (r.gapPct ?? 0) >= minGap);
    }

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
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "List failed", detail: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  const base =
    process.env.RENDER_EXTERNAL_URL ||
    `http://localhost:${PORT}`;

  console.log(`✅ ALGTP™ Scanner running ${base}`);
  console.log(`🚀 UI: ${base}/ui`);
});

