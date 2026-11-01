const crypto = require("crypto");

// A project API key looks like: cr_ + 64 random hex characters.
// Only its SHA-256 hash and an 8-character prefix are stored, never the key itself.
function generateApiKey() {
  const key = "cr_" + crypto.randomBytes(32).toString("hex");
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 8) };
}

function hashApiKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

module.exports = { generateApiKey, hashApiKey };