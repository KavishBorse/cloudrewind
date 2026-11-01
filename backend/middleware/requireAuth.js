const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config");
const { db } = require("../db");

// Runs before any route that needs a logged-in user.
// Reads the token from the "Authorization: Bearer <token>" header.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Please log in" });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    res.status(401).json({ error: "Session expired. Please log in again" });
    return;
  }
  const user = await db.prepare("SELECT id, full_name, organization_name, email FROM users WHERE id = ?").get(payload.userId);
  if (!user) return res.status(401).json({ error: "Please log in" });
  req.user = user;
  next();
}

module.exports = { requireAuth };
