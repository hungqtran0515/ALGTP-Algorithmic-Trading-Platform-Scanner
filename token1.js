// auth/token.js
const crypto = require("crypto");

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
  return Buffer.from((str + pad).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function sign(body, secret) {
  return b64url(crypto.createHmac("sha256", secret).update(body).digest());
}

function makeToken(payload, secret) {
  const body = b64urlJson(payload);
  const sig = sign(body, secret);
  return `${body}.${sig}`;
}

function verifyToken(token, secret) {
  try {
    if (!secret) return { ok: false, reason: "missing_secret" };
    if (!token) return { ok: false, reason: "missing_token" };

    const parts = String(token).split(".");
    if (parts.length !== 2) return { ok: false, reason: "bad_format" };

    const [body, sig] = parts;
    const expected = sign(body, secret);

    const a = Buffer.from(String(sig));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: "bad_signature" };
    }

    const payload = JSON.parse(fromB64url(body));
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp)) return { ok: false, reason: "no_exp" };

    const now = Math.floor(Date.now() / 1000);
    if (now > exp) return { ok: false, reason: "expired", exp, now };

    return { ok: true, payload };
  } catch (e) {
    return { ok: false, reason: "verify_error", detail: String(e?.message || e) };
  }
}

module.exports = { makeToken, verifyToken };
