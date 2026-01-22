require("dotenv").config();
const { makeToken } = require("../auth/token");

const ACCESS_SECRET = process.env.APP_ACCESS_SECRET;
if (!ACCESS_SECRET) {
  console.error("❌ Missing APP_ACCESS_SECRET in .env");
  process.exit(1);
}

const token = makeToken(
  {
    uid: "admin",
    role: "owner",
    exp: Math.floor(Date.now() / 1000) + 86400,
  },
  ACCESS_SECRET
);

console.log("\n🔑 ADMIN TOKEN:\n");
console.log(token);
console.log("\n➡️ Open:\n/ui?token=" + token);
