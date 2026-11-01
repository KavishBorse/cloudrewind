const express = require("express");
const crypto = require("node:crypto");
const { z } = require("zod");
const { db } = require("../db");
const { FRONTEND_URL } = require("../config");
const { requireAuth } = require("../middleware/requireAuth");
const { requireWorkspace, requireWorkspaceRole } = require("../middleware/requireWorkspace");

const router = express.Router();
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const workspaceName = z.string().trim().min(2, "Workspace name must have at least 2 characters").max(120, "Workspace name is too long");
const invitationInput = z.object({
  email: z.string().email("Enter a valid email").max(254),
  role: z.enum(["admin", "member"]).default("member"),
});

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const presentWorkspace = (row) => ({
  id: row.id,
  name: row.name,
  role: row.role,
  member_count: Number(row.member_count ?? 0),
  created_at: row.created_at,
});

router.use(requireAuth);

// A user may belong to several teams; the browser selects one for project routes.
router.get("/", async (req, res) => {
  const rows = await db.prepare(
    "SELECT w.id, w.name, w.created_at, wm.role, COUNT(all_members.id) AS member_count " +
    "FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id " +
    "LEFT JOIN workspace_members all_members ON all_members.workspace_id = w.id " +
    "WHERE wm.user_id = ? GROUP BY w.id, w.name, w.created_at, wm.role " +
    "ORDER BY CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END, w.id"
  ).all(req.user.id);
  res.json(rows.map(presentWorkspace));
});

// Invite preview is scoped to the signed-in email, so a leaked link reveals no team details.
router.get("/invitations/:token", async (req, res) => {
  const invite = await db.prepare(
    "SELECT wi.email, wi.role, wi.expires_at, w.name AS workspace_name " +
    "FROM workspace_invites wi JOIN workspaces w ON w.id = wi.workspace_id " +
    "WHERE wi.token_hash = ? AND wi.accepted_at IS NULL AND wi.revoked_at IS NULL AND wi.expires_at > ?"
  ).get(hashToken(req.params.token), Date.now());
  if (!invite || invite.email !== req.user.email.toLowerCase()) {
    return res.status(404).json({ error: "This invitation is invalid, expired, or belongs to another email address" });
  }
  res.json({ email: invite.email, role: invite.role, expires_at: invite.expires_at, workspace_name: invite.workspace_name });
});

router.post("/invitations/:token/accept", async (req, res) => {
  const tokenHash = hashToken(req.params.token);
  const now = Date.now();
  const acceptInvite = db.transaction(async (transactionDb) => {
    const lock = transactionDb.driver === "postgres" ? " FOR UPDATE" : "";
    const invite = await transactionDb.prepare(
      "SELECT id, workspace_id, email, role FROM workspace_invites " +
      "WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? LIMIT 1" + lock
    ).get(tokenHash, now);
    if (!invite || invite.email !== req.user.email.toLowerCase()) return null;

    await transactionDb.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(workspace_id, user_id) DO NOTHING"
    ).run(invite.workspace_id, req.user.id, invite.role, now);
    await transactionDb.prepare(
      "UPDATE workspace_invites SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL"
    ).run(now, req.user.id, invite.id);
    const workspace = await transactionDb.prepare(
      "SELECT id, name, created_at FROM workspaces WHERE id = ?"
    ).get(invite.workspace_id);
    return { ...workspace, role: invite.role };
  });
  const workspace = await acceptInvite();
  if (!workspace) return res.status(404).json({ error: "This invitation is invalid, expired, or belongs to another email address" });
  res.json({ workspace: { ...workspace, member_count: 0 } });
});

router.use(requireWorkspace);

router.patch("/current", requireWorkspaceRole("owner", "admin"), async (req, res) => {
  const parsed = z.object({ name: workspaceName }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  await db.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(parsed.data.name, req.workspace.id);
  res.json({ ...req.workspace, name: parsed.data.name });
});

router.get("/members", async (req, res) => {
  const members = await db.prepare(
    "SELECT wm.id, wm.role, wm.created_at AS joined_at, u.id AS user_id, u.full_name, u.email " +
    "FROM workspace_members wm JOIN users u ON u.id = wm.user_id " +
    "WHERE wm.workspace_id = ? " +
    "ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, lower(u.full_name), lower(u.email)"
  ).all(req.workspace.id);
  res.json(members);
});

router.get("/invitations", requireWorkspaceRole("owner", "admin"), async (req, res) => {
  const invites = await db.prepare(
    "SELECT id, email, role, expires_at, created_at FROM workspace_invites " +
    "WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? " +
    "ORDER BY created_at DESC"
  ).all(req.workspace.id, Date.now());
  res.json(invites);
});

router.post("/invitations", requireWorkspaceRole("owner", "admin"), async (req, res) => {
  const parsed = invitationInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  if (parsed.data.role === "admin" && req.workspace.role !== "owner") {
    return res.status(403).json({ error: "Only the workspace owner can invite an admin" });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const member = await db.prepare(
    "SELECT wm.id FROM workspace_members wm JOIN users u ON u.id = wm.user_id " +
    "WHERE wm.workspace_id = ? AND lower(u.email) = ?"
  ).get(req.workspace.id, email);
  if (member) return res.status(409).json({ error: "That account is already a workspace member" });

  const now = Date.now();
  await db.prepare(
    "UPDATE workspace_invites SET revoked_at = ? " +
    "WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL"
  ).run(now, req.workspace.id, email);

  const token = crypto.randomBytes(32).toString("base64url");
  const inserted = await db.prepare(
    "INSERT INTO workspace_invites " +
    "(workspace_id, email, role, token_hash, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(req.workspace.id, email, parsed.data.role, hashToken(token), req.user.id, now + INVITE_TTL_MS, now);

  res.status(201).json({
    id: Number(inserted.lastInsertRowid),
    email,
    role: parsed.data.role,
    expires_at: now + INVITE_TTL_MS,
    invite_url: FRONTEND_URL + "/invite/" + token,
  });
});

router.delete("/invitations/:inviteId", requireWorkspaceRole("owner", "admin"), async (req, res) => {
  const inviteId = Number(req.params.inviteId);
  if (!Number.isInteger(inviteId) || inviteId < 1) return res.status(400).json({ error: "Invalid invitation id" });
  const invite = await db.prepare(
    "SELECT role FROM workspace_invites WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL"
  ).get(inviteId, req.workspace.id);
  if (!invite) return res.status(404).json({ error: "Invitation not found" });
  if (invite.role === "admin" && req.workspace.role !== "owner") {
    return res.status(403).json({ error: "Only the workspace owner can revoke an admin invitation" });
  }
  await db.prepare("UPDATE workspace_invites SET revoked_at = ? WHERE id = ?").run(Date.now(), inviteId);
  res.json({ ok: true });
});

router.patch("/members/:memberId", requireWorkspaceRole("owner", "admin"), async (req, res) => {
  const memberId = Number(req.params.memberId);
  if (!Number.isInteger(memberId) || memberId < 1) return res.status(400).json({ error: "Invalid member id" });
  const parsed = z.object({ role: z.enum(["admin", "member"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const member = await db.prepare(
    "SELECT id, role FROM workspace_members WHERE id = ? AND workspace_id = ?"
  ).get(memberId, req.workspace.id);
  if (!member || member.role === "owner") return res.status(404).json({ error: "Member not found" });
  if ((member.role === "admin" || parsed.data.role === "admin") && req.workspace.role !== "owner") {
    return res.status(403).json({ error: "Only the workspace owner can change admin roles" });
  }
  await db.prepare("UPDATE workspace_members SET role = ? WHERE id = ?").run(parsed.data.role, memberId);
  res.json({ ok: true, role: parsed.data.role });
});

router.delete("/members/:memberId", requireWorkspaceRole("owner", "admin"), async (req, res) => {
  const memberId = Number(req.params.memberId);
  if (!Number.isInteger(memberId) || memberId < 1) return res.status(400).json({ error: "Invalid member id" });
  const member = await db.prepare(
    "SELECT id, role FROM workspace_members WHERE id = ? AND workspace_id = ?"
  ).get(memberId, req.workspace.id);
  if (!member || member.role === "owner") return res.status(404).json({ error: "Member not found" });
  if (member.role === "admin" && req.workspace.role !== "owner") {
    return res.status(403).json({ error: "Only the workspace owner can remove an admin" });
  }
  await db.prepare("DELETE FROM workspace_members WHERE id = ?").run(memberId);
  res.json({ ok: true });
});

module.exports = router;
