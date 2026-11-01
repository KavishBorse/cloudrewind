const express = require("express");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");
const { insertEvent } = require("../db");
const { requireApiKey } = require("../middleware/requireApiKey");

const router = express.Router();

const MAX_FUTURE_MS = 60 * 1000;               // an event may be at most 1 minute ahead of the server clock
const MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000;   // and at most 7 days old

const metaValue = z.union([z.string().max(200), z.number(), z.boolean()]);

// A fixed shape. Extra fields are rejected.
const payload = z.strictObject({
  event_type: z.enum(["deploy", "config_change", "restart"]),
  description: z.string().trim().max(200).optional(),
  timestamp: z.number().int().optional(),
  meta: z
    .record(z.string().max(40), metaValue)
    .refine((o) => Object.keys(o).length <= 10, "use at most 10 keys")
    .optional(),
});

// Events are rare (a deploy now and then): 20 per minute per key is plenty
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  keyGenerator: (req) => String(req.project.id),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many events. Send at most 20 per minute." },
});

// A deploy, config change or restart happened. Called from a CI job or a script with the project API key.
router.post("/", requireApiKey, limiter, async (req, res) => {
  const parsed = payload.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.join(".");
    return res.status(400).json({ error: field ? `${field}: ${issue.message}` : issue.message });
  }

  const now = Date.now();
  const timestamp = parsed.data.timestamp ?? now;
  if (timestamp > now + MAX_FUTURE_MS) return res.status(400).json({ error: "timestamp: is in the future" });
  if (timestamp < now - MAX_PAST_MS) return res.status(400).json({ error: "timestamp: is older than 7 days" });

  const id = await insertEvent(req.project.id, { ...parsed.data, timestamp });
  res.status(201).json({ ok: true, id });
});

module.exports = router;
