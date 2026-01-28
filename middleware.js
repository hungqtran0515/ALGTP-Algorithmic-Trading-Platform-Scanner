import { getUserByEmail } from "./db.js";

function requirePremium(req, res, next) {
  const email = req.user?.email;
  if (!email) return res.redirect("/login");

  const u = getUserByEmail.get(email);
  if (!u || !u.premium) {
    return res.type("html").send(`
      <h2>Premium required</h2>
      <p>Please subscribe to access ALGTP™ Scanner.</p>
      <a href="/subscribe">Subscribe</a>
    `);
  }
  next();
}

export { requirePremium };
