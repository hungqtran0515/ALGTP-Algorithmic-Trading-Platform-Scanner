// token.js
require("dotenv").config();
const crypto = require("crypto");

const ACCESS_SECRET = process.env.APP_ACCESS_SECRET;
if (!ACCESS_SECRET) {
  console.error("❌ Missing APP_ACCESS_SECRET in .env");
  process.exit(1);
}

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function sign(data) {
  return b64url(
    crypto.createHmac("sha256", ACCESS_SECRET).update(data).digest()
  );
}

function makeToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = sign(body);
  return `${body}.${sig}`;
}

// ===== CREATE TOKEN HERE =====
const token = makeToken({
  uid: "admin",
  role: "owner",
  exp: Math.floor(Date.now() / 1000) + 86400, // 24h
});

console.log("\n🔑 ADMIN TOKEN:\n");
console.log(token);
console.log("\n➡️ Open:\n/ui?token=" + token);
