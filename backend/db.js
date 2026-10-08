const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "cloudrewind.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp      INTEGER NOT NULL,
    cpu            REAL    NOT NULL,
    memory         REAL    NOT NULL,
    containers     TEXT    NOT NULL,
    db_connections INTEGER NOT NULL,
    network        REAL    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON snapshots(timestamp);
`);

const insertStmt = db.prepare(`
  INSERT INTO snapshots (timestamp, cpu, memory, containers, db_connections, network)
  VALUES (?, ?, ?, ?, ?, ?)
`);

function insertSnapshot(s) {
  insertStmt.run(
    s.timestamp,
    s.cpu,
    s.memory,
    JSON.stringify(s.containers),
    s.db_connections,
    s.network
  );
}

module.exports = { db, insertSnapshot };