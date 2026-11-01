const { db } = require("../db");
const { hashApiKey } = require("../apiKeys");

// For routes called by the agent (not by a logged-in person).
// Reads the key from the "x-api-key" header and finds the project it belongs to.
async function requireApiKey(req, res, next) {
  const key = req.get("x-api-key");
  if (typeof key !== "string" || key.length === 0 || key.length > 100) {
    return res.status(401).json({ error: "Missing or invalid API key" });
  }

  const project = await db.prepare("SELECT * FROM projects WHERE api_key_hash = ?").get(hashApiKey(key));
  if (!project) return res.status(401).json({ error: "Missing or invalid API key" });

  req.project = project;
  next();
}

module.exports = { requireApiKey };
