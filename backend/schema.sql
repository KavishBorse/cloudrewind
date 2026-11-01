CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT NOT NULL DEFAULT '',
  organization_name TEXT NOT NULL DEFAULT '',
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
  created_at   INTEGER NOT NULL,
  UNIQUE(workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id, workspace_id);

CREATE TABLE IF NOT EXISTS projects (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL REFERENCES users(id),
  workspace_id       INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  environment        TEXT NOT NULL DEFAULT 'production',
  api_key_hash       TEXT NOT NULL,
  api_key_prefix     TEXT NOT NULL,
  db_max_connections INTEGER DEFAULT 100,
  is_demo            INTEGER DEFAULT 0,
  last_seen_at       INTEGER,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_invites (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL CHECK(role IN ('admin', 'member')),
  token_hash   TEXT UNIQUE NOT NULL,
  created_by   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   INTEGER NOT NULL,
  accepted_at  INTEGER,
  accepted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace ON workspace_invites(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service        TEXT NOT NULL DEFAULT 'main',
  instance       TEXT NOT NULL DEFAULT 'default',
  timestamp      INTEGER NOT NULL,
  cpu            REAL NOT NULL,
  memory         REAL NOT NULL,
  containers     INTEGER,
  db_connections INTEGER,
  network        REAL,
  http_status    INTEGER CHECK(http_status BETWEEN 0 AND 599),
  http_ok        INTEGER CHECK(http_ok IN (0, 1)),
  response_ms    REAL CHECK(response_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_snap ON snapshots(project_id, service, timestamp);
-- For queries that do not name a service
CREATE INDEX IF NOT EXISTS idx_snap_time ON snapshots(project_id, timestamp);

-- Old data, summarised. Each row covers one time bucket (60 seconds or 12 hours)
-- and keeps min, max and average, because an average alone hides a short spike.
CREATE TABLE IF NOT EXISTS snapshot_rollups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service        TEXT NOT NULL,
  instance       TEXT NOT NULL DEFAULT 'default',
  bucket_start   INTEGER NOT NULL,
  bucket_seconds INTEGER NOT NULL,
  cpu_avg        REAL, cpu_min REAL, cpu_max REAL,
  mem_avg        REAL, mem_min REAL, mem_max REAL,
  containers_min INTEGER,
  db_conn_max    INTEGER,
  net_max        REAL,
  sample_count   INTEGER NOT NULL,
  http_ok_min    INTEGER,
  response_ms_avg REAL,
  response_ms_max REAL,
  probe_count    INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rollup_unique ON snapshot_rollups(project_id, service, bucket_seconds, bucket_start);
CREATE INDEX IF NOT EXISTS idx_rollup_time ON snapshot_rollups(project_id, bucket_start);

-- Things that happen to the system that are not measurements: a deploy, a config change, a restart.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  timestamp   INTEGER NOT NULL,
  event_type  TEXT NOT NULL,   -- deploy | config_change | restart
  description TEXT,
  meta        TEXT             -- small JSON object, for example {"version":"v2.3"}
);

CREATE INDEX IF NOT EXISTS idx_events_time ON events(project_id, timestamp);

-- A grouped period of abnormal readings. The sequence is temporal evidence, not proof of causality.
CREATE TABLE IF NOT EXISTS incidents (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  start_ts       INTEGER NOT NULL,
  end_ts         INTEGER,
  last_flag_ts   INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
  severity       TEXT NOT NULL DEFAULT 'warning' CHECK(severity IN ('warning', 'critical')),
  trigger_metric TEXT,
  services       TEXT NOT NULL DEFAULT '[]',
  deploy_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  evidence_json  TEXT NOT NULL DEFAULT '[]',
  summary_text   TEXT,
  summary_source TEXT NOT NULL DEFAULT 'rule-based',
  summary_mode TEXT NOT NULL DEFAULT 'summary',
  summary_window_minutes INTEGER,
  summary_window_end_ts INTEGER,
  summary_causes_json TEXT NOT NULL DEFAULT '[]',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incidents_project_start ON incidents(project_id, start_ts DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents(project_id, status, last_flag_ts);

CREATE TABLE IF NOT EXISTS bookmarks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  timestamp  INTEGER NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_project_time ON bookmarks(project_id, timestamp);

-- Ground-truth records for repeatable demo faults. These support controlled evaluation,
-- but are kept separate from detector output so a run cannot label itself as detected.
CREATE TABLE IF NOT EXISTS demo_scenarios (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scenario_type    TEXT NOT NULL,
  expected_metric  TEXT NOT NULL,
  detector_version TEXT NOT NULL DEFAULT 'rules-1.0',
  started_at       INTEGER NOT NULL,
  ends_at          INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  deploy_event_id  INTEGER REFERENCES events(id) ON DELETE SET NULL,
  detected_at      INTEGER,
  detected_metric  TEXT,
  incident_id      INTEGER REFERENCES incidents(id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_demo_scenarios_project_start ON demo_scenarios(project_id, started_at DESC);

-- AWS metrics are stored apart from agent snapshots so each reading keeps its origin.
CREATE TABLE IF NOT EXISTS aws_connections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  region         TEXT NOT NULL,
  instance_id    TEXT NOT NULL,
  agent_service  TEXT NOT NULL DEFAULT 'main',
  agent_instance TEXT NOT NULL DEFAULT 'default',
  role_arn       TEXT,
  external_id    TEXT NOT NULL DEFAULT '',
  last_synced_at INTEGER,
  last_attempt_at INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS aws_metric_points (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  region          TEXT NOT NULL,
  instance_id     TEXT NOT NULL,
  metric_name     TEXT NOT NULL CHECK(metric_name IN ('CPUUtilization', 'NetworkIn', 'NetworkOut', 'StatusCheckFailed')),
  timestamp       INTEGER NOT NULL,
  value           REAL NOT NULL,
  unit            TEXT NOT NULL,
  statistic       TEXT NOT NULL,
  period_seconds  INTEGER NOT NULL,
  fetched_at      INTEGER NOT NULL,
  UNIQUE(project_id, region, instance_id, metric_name, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_aws_metrics_project_time ON aws_metric_points(project_id, region, instance_id, timestamp);
