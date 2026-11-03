const express = require("express");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");
const { db, insertSnapshot } = require("../db");
const { requireApiKey } = require("../middleware/requireApiKey");
const { processSnapshot } = require("../incidentService");

const router = express.Router();

const MAX_FUTURE_MS = 60 * 1000;           // a snapshot may be at most 1 minute ahead of the server clock
const MAX_PAST_MS = 24 * 60 * 60 * 1000;   // and at most 24 hours old (the agent resends after short outages)

const percent = z.number().min(0).max(100);

// The agent sends this fixed list of numbers and nothing else. Extra fields are rejected.
const payload = z.strictObject({
  service: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/, "use 1 to 40 letters, numbers, - or _").optional(),
  instance: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/, "use 1 to 80 letters, numbers, dots, - or _").optional(),
  timestamp: z.number().int().optional(),
  cpu: percent,
  memory: percent,
  containers: z.number().int().min(0).max(10000).optional(),
  db_connected: z.boolean().optional(),
  db_connections: z.number().int().min(0).max(100000).optional(),
  network: z.number().min(0).max(100000000).optional(),
  http_status: z.number().int().min(0).max(599).optional(),
  response_ms: z.number().min(0).max(120000).optional(),
});

// About 1 request per second per key: 10 requests per 10 seconds (short bursts are fine)
const limiter = rateLimit({
  windowMs: 10 * 1000,
  limit: 10,
  keyGenerator: (req) => String(req.project.id),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Send about 1 snapshot per second at most." },
});

// Check that a key works
router.get("/ping", requireApiKey, (req, res) => {
  res.json({ ok: true, project: req.project.name });
});

// The agent sends one snapshot
router.post("/", requireApiKey, limiter, async (req, res) => {
  const parsed = payload.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.join(".");
    return res.status(400).json({ error: field ? `${field}: ${issue.message}` : issue.message });
  }

  if ((parsed.data.http_status == null) !== (parsed.data.response_ms == null)) {
    return res.status(400).json({ error: "http_status and response_ms must be sent together" });
  }

  const now = Date.now();
  const timestamp = parsed.data.timestamp ?? now;
  if (timestamp > now + MAX_FUTURE_MS) {
    return res.status(400).json({ error: "timestamp: is in the future" });
  }
  if (timestamp < now - MAX_PAST_MS) {
    return res.status(400).json({ error: "timestamp: is older than 24 hours" });
  }

  const snapshot = {
    ...parsed.data,
    instance: parsed.data.instance || "default",
    http_ok: parsed.data.http_status == null ? null : Number(parsed.data.http_status >= 200 && parsed.data.http_status < 400),
    timestamp,
    project_id: req.project.id,
  };
  await insertSnapshot(req.project.id, snapshot);
  await processSnapshot(snapshot);
  await db.prepare("UPDATE projects SET last_seen_at = ? WHERE id = ?").run(now, req.project.id);
  res.status(201).json({ ok: true });
});

module.exports = router;
