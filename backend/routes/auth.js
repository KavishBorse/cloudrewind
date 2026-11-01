const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");
const { db } = require("../db");
const { JWT_SECRET, JWT_EXPIRES_IN } = require("../config");
const { requireAuth } = require("../middleware/requireAuth");

const router = express.Router();
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." },
});

const emailPassword = z.object({
  email: z.string().email("Enter a valid email").max(254),
  password: z.string().min(8, "Password must be at least 8 characters").max(72, "Password is too long"),
});
const signupDetails = emailPassword.extend({
  full_name: z.string().trim().min(2, "Enter your name").max(100, "Name is too long"),
  organization_name: z.string().trim().max(120, "Organization name is too long").optional().default(""),
});
const profileDetails = z.object({
  full_name: z.string().trim().min(2, "Enter your name").max(100, "Name is too long"),
  organization_name: z.string().trim().max(120, "Organization name is too long"),
}).strict();

function makeToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { algorithm: "HS256", expiresIn: JWT_EXPIRES_IN });
}

router.post("/signup", authLimiter, async (req, res) => {
  const parsed = signupDetails.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const email = parsed.data.email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);

  try {
    const createAccount = db.transaction(async (transactionDb) => {
      const inserted = await transactionDb
        .prepare("INSERT INTO users (full_name, organization_name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(parsed.data.full_name, parsed.data.organization_name, email, passwordHash, Date.now());
      const userId = Number(inserted.lastInsertRowid);
      const now = Date.now();
      const workspaceName = parsed.data.organization_name.trim() || `${parsed.data.full_name.trim()}'s workspace`;
      const workspace = await transactionDb.prepare(
        "INSERT INTO workspaces (name, created_by, created_at) VALUES (?, ?, ?)"
      ).run(workspaceName, userId, now);
      const workspaceId = Number(workspace.lastInsertRowid);
      await transactionDb.prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)"
      ).run(workspaceId, userId, now);
      return Number(userId);
    });
    const userId = await createAccount();
    res.status(201).json({
      token: makeToken(userId),
      user: { id: userId, full_name: parsed.data.full_name, organization_name: parsed.data.organization_name, email },
    });
  } catch (err) {
    if (String(err.code).startsWith("SQLITE_CONSTRAINT") || err.code === "23505") {
      return res.status(409).json({ error: "That email is already registered" });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

router.post("/login", authLimiter, async (req, res) => {
  const parsed = emailPassword.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const email = parsed.data.email.trim().toLowerCase();
  const user = await db.prepare("SELECT id, full_name, organization_name, email, password_hash FROM users WHERE email = ?").get(email);
  const ok = user ? await bcrypt.compare(parsed.data.password, user.password_hash) : false;

  // Same message for "no such email" and "wrong password"
  if (!ok) return res.status(401).json({ error: "Wrong email or password" });

  res.json({
    token: makeToken(user.id),
    user: { id: user.id, full_name: user.full_name, organization_name: user.organization_name, email: user.email },
  });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.patch("/me", requireAuth, async (req, res) => {
  const parsed = profileDetails.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  await db.prepare(
    "UPDATE users SET full_name = ?, organization_name = ? WHERE id = ?"
  ).run(parsed.data.full_name, parsed.data.organization_name, req.user.id);

  const user = await db.prepare(
    "SELECT id, full_name, organization_name, email FROM users WHERE id = ?"
  ).get(req.user.id);
  res.json({ user });
});

module.exports = router;
