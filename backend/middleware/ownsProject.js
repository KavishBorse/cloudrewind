const { db } = require("../db");

// Runs on every /projects/:id/... route.
// A project that belongs to someone else gets the same "not found" answer
// as a project that does not exist, so nobody can probe other accounts.
async function ownsProject(req, res, next) {
  const id = Number(req.params.id);
  const project = Number.isInteger(id) && req.workspace
    ? await db.prepare(
      `SELECT p.* FROM projects p
       JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
       WHERE p.id = ? AND p.workspace_id = ? AND wm.user_id = ?`
    ).get(id, req.workspace.id, req.user.id)
    : null;

  if (!project) return res.status(404).json({ error: "Project not found" });
  req.project = project;
  next();
}

module.exports = { ownsProject };
