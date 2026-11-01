const { db } = require("../db");

async function requireWorkspace(req, res, next) {
  const value = req.get("x-workspace-id");
  const requestedId = value === undefined ? null : Number(value);
  if (requestedId !== null && (!Number.isInteger(requestedId) || requestedId < 1)) {
    return res.status(400).json({ error: "Invalid workspace selection" });
  }

  const workspace = await db.prepare(
    `SELECT w.id, w.name, w.created_by, w.created_at, wm.role
     FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = ? AND (CAST(? AS INTEGER) IS NULL OR w.id = ?)
     ORDER BY CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END, w.id LIMIT 1`
  ).get(req.user.id, requestedId, requestedId);

  if (!workspace) return res.status(403).json({ error: "You do not have access to that workspace" });
  req.workspace = workspace;
  next();
}

function requireWorkspaceRole(...roles) {
  return (req, res, next) => {
    if (!req.workspace || !roles.includes(req.workspace.role)) {
      return res.status(403).json({ error: "Your workspace role cannot perform this action" });
    }
    next();
  };
}

module.exports = { requireWorkspace, requireWorkspaceRole };
