/****************************************************
 * ALGTP™ Scanner – FINAL CLEAN SERVER
 * - No redeclare
 * - Access Lock (token / plan / device / ip)
 * - Bypass health & api
 * - Ready for Render / Local
 ****************************************************/

require("dotenv").config();

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json());

/* ==================================================
   ENV – DECLARE ONCE ONLY
================================================== */
const PORT = Number(process.env.PORT || 3000);

// Massive
const MASSIVE_API_KEY = String(process.env.MASSIVE_API_KEY || "").trim();
const MASSIVE_AUTH_TYPE = String(process.env.MASSIVE_AUTH_TYPE || "query").trim();
const MASSIVE_QUERY_KEYNAME = String(process.env.MASSIVE_QUERY_KEYNAME || "apiKey").trim();

const MASSIVE_MOVER_URL = String(
  process.env.MASSIVE_MOVER_URL ||
    "https://api.massive.com/v2/snapshot/locale/us/markets/stocks"
).trim();

const MASSIVE_TICKER_SNAPSHOT_URL = String(
  process.env.MASSIVE_TICKER_SNAPSHOT_URL ||
    "https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers"
).trim();

const INCLUDE_OTC =
  String(process.env.INCLUDE_OTC || "false").toLowerCase() === "true";
const SNAP_CONCURRENCY = Math.max(
  1,
  Math.min(10, Number(process.env.SNAP_CONCURRENCY || 4))
);
const DEBUG = String(process.env.DEBUG || "true").toLowerCase() === "true";

// Lock
const LOCK_ENABLED =
  String(process.env.APP_LOCK_ENABLED || "true").toLowerCase() === "true";
const HARD_LOCK_ENABLED =
  String(process.env.HARD_LOCK_ENABLED || "false").toLowerCase() === "true";
const ACCESS_SECRET = String(process.env.APP_ACCESS_SECRET || "").trim();

/* ==================================================
   HARD BOOT LOCK (OPTIONAL)
================================================== */
if (HARD_LOCK_ENABLED) {
  const REQUIRED = ["APP_ACCESS_SECRET", "MASSIVE_API_KEY"];
  for (const k of REQUIRED) {
    if (!process.env[k] || !String(process.env[k]).trim()) {
      console.error(`❌ FATAL: Missing env ${k}`);
      process.exit(1);
    }
  }
}

/* ==================================================
   UTIL – BASE64URL
================================================== */
function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}
function fromB64url(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  return Buffer.from(
    (str + pad).replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
}

/* ==================================================
   TOKEN SIGN / VERIFY
================================================== */
function sign(data) {
  return b64url(
    crypto.createHmac("sha256", ACCESS_SECRET).update(data).digest()
  );
}

function makeToken(payload) {
  const body = b64urlJson(payload);
  return `${body}.${sign(body)}`;
}

function verifyToken(token) {
  try {
    if (!ACCESS_SECRET) return { ok: false, reason: "missing_secret" };
    if (!token) return { ok: false, reason: "missing_token" };

    const parts = String(token).split(".");
    if (parts.length !== 2) return { ok: false, reason: "bad_format" };

    const [body, sig] = parts;
    const expected = sign(body);

    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(
        Buffer.from(sig),
        Buffer.from(expected)
      )
    ) {
      return { ok: false, reason: "bad_signature" };
    }

    const payload = JSON.parse(fromB64url(body));
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp)) return { ok: false, reason: "no_exp" };

    const now = Math.floor(Date.now() / 1000);
    if (now > exp) return { ok: false, reason: "expired", exp, now };

    return { ok: true, payload };
  } catch (e) {
    return { ok: false, reason: "verify_error", detail: String(e) };
  }
}

/* ==================================================
   COOKIE + DEVICE + IP
================================================== */
function parseCookie(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  raw.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1)
      out[p.slice(0, i).trim()] = decodeURIComponent(
        p.slice(i + 1).trim()
      );
  });
  return out;
}

function deviceHash(req) {
  const ua = req.headers["user-agent"] || "";
  const ip =
    (req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      "")
      .split(",")[0]
      .trim();
  return crypto.createHash("sha256").update(ua + "|" + ip).digest("hex");
}

/* ==================================================
   HTML LOCK PAGE
================================================== */
function renderLocked(reason) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ALGTP Locked</title>
<style>
body{margin:0;background:#0b0d12;color:#e6e8ef;font-family:system-ui}
.box{max-width:720px;margin:10vh auto;padding:18px;border-radius:14px;
border:1px solid rgba(255,255,255,.14);background:rgba(18,24,43,.55)}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;opacity:.75}
</style>
</head>
<body>
<div class="box">
<h2>🔒 ALGTP™ Scanner Locked</h2>
<div class="mono">Reason: ${reason}</div>
</div>
</body>
</html>`;
}

/* ==================================================
   BYPASS ROUTES
================================================== */
const BYPASS_PATHS = ["/health", "/api", "/env", "/_debug"];

function isBypass(req) {
  return BYPASS_PATHS.some(
    (p) => req.path === p || req.path.startsWith(p + "/")
  );
}

/* ==================================================
   SAVE TOKEN (?token=)
================================================== */
app.use((req, res, next) => {
  if (!LOCK_ENABLED) return next();
  const t = req.query.token || req.query.t;
  if (t) {
    res.setHeader(
      "Set-Cookie",
      `algtp_token=${encodeURIComponent(
        String(t)
      )}; Path=/; HttpOnly; SameSite=Lax; Secure`
    );
  }
  next();
});

/* ==================================================
   ACCESS GUARD
================================================== */
function accessGuard(req, res, next) {
  if (!LOCK_ENABLED) return next();
  if (isBypass(req)) return next();

  const cookies = parseCookie(req);
  const token =
    req.headers["x-access-token"] ||
    req.query.token ||
    req.query.t ||
    cookies.algtp_token;

  const v = verifyToken(token);
  if (!v.ok) {
    return res
      .status(401)
      .type("html")
      .send(renderLocked(v.reason));
  }

  if (v.payload?.dh && v.payload.dh !== deviceHash(req)) {
    return res
      .status(401)
      .type("html")
      .send(renderLocked("device_mismatch"));
  }

  req.algtpAccess = v.payload;
  return next();
}

app.use(accessGuard);

/* ==================================================
   HEALTH / API
================================================== */
app.get("/health", (req, res) =>
  res.json({ ok: true, status: "alive" })
);

app.get("/api", (req, res) =>
  res.json({ ok: true, message: "ALGTP API running" })
);

/* ==================================================
   ROOT
================================================== */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "ALGTP™ Scanner running",
    ui: "/ui",
  });
});

/* ==================================================
   START SERVER
================================================== */
app.listen(PORT, () => {
  console.log(`✅ ALGTP™ running on http://localhost:${PORT}`);
});
