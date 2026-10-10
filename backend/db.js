const Database = require("better-sqlite3");
const path = require("path");
const { runMigrations } = require("./migrate");

const db = new Database(path.join(__dirname, "cloudrewind.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
runMigrations(db);

const insertStmt = db.prepare(`
  INSERT INTO snapshots (project_id, service, timestamp, cpu, memory, containers, db_connections, network)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

function insertSnapshot(projectId, s) {
  insertStmt.run(
    projectId,
    s.service || "main",
    s.timestamp,
    s.cpu,
    s.memory,
    s.containers ?? null,
    s.db_connections ?? null,
    s.network ?? null
  );
}

// Latest N snapshots, oldest first so charts read left to right
function getSnapshots(projectId, limit) {
  return db
    .prepare("SELECT * FROM snapshots WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?")
    .all(projectId, limit)
    .reverse();
}

// Snapshot nearest to a given time
function getClosestSnapshot(projectId, time) {
  const before = db
    .prepare("SELECT * FROM snapshots WHERE project_id = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1")
    .get(projectId, time);
  const after = db
    .prepare("SELECT * FROM snapshots WHERE project_id = ? AND timestamp >= ? ORDER BY timestamp ASC LIMIT 1")
    .get(projectId, time);

  if (!before) return after || null;
  if (!after) return before;
  return time - before.timestamp <= after.timestamp - time ? before : after;
}

function getDemoProjects() {
  return db.prepare("SELECT id FROM projects WHERE is_demo = 1").all();
}

module.exports = { db, insertSnapshot, getSnapshots, getClosestSnapshot, getDemoProjects };