CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL REFERENCES users(id),
  name               TEXT NOT NULL,
  api_key_hash       TEXT NOT NULL,
  api_key_prefix     TEXT NOT NULL,
  db_max_connections INTEGER DEFAULT 100,
  is_demo            INTEGER DEFAULT 0,
  last_seen_at       INTEGER,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service        TEXT NOT NULL DEFAULT 'main',
  timestamp      INTEGER NOT NULL,
  cpu            REAL NOT NULL,
  memory         REAL NOT NULL,
  containers     INTEGER,
  db_connections INTEGER,
  network        REAL
);

CREATE INDEX IF NOT EXISTS idx_snap ON snapshots(project_id, service, timestamp);