CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL DEFAULT '',
  organization_name TEXT NOT NULL DEFAULT '',
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
  created_at BIGINT NOT NULL,
  UNIQUE(workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id, workspace_id);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'production',
  api_key_hash TEXT NOT NULL,
  api_key_prefix TEXT NOT NULL,
  db_max_connections INTEGER DEFAULT 100,
  is_demo INTEGER DEFAULT 0,
  last_seen_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);

CREATE TABLE IF NOT EXISTS snapshots (
  id BIGSERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service TEXT NOT NULL DEFAULT 'main',
  instance TEXT NOT NULL DEFAULT 'default',
  timestamp BIGINT NOT NULL,
  cpu DOUBLE PRECISION NOT NULL,
  memory DOUBLE PRECISION NOT NULL,
  containers INTEGER,
  db_connected INTEGER CHECK(db_connected IN (0, 1)),
  db_connections INTEGER,
  network DOUBLE PRECISION,
  http_status INTEGER CHECK(http_status BETWEEN 0 AND 599),
  http_ok INTEGER CHECK(http_ok IN (0, 1)),
  response_ms DOUBLE PRECISION CHECK(response_ms >= 0)
);
CREATE INDEX IF NOT EXISTS idx_snap ON snapshots(project_id, service, timestamp);
CREATE INDEX IF NOT EXISTS idx_snap_time ON snapshots(project_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_snap_instance ON snapshots(project_id, service, instance, timestamp);

CREATE TABLE IF NOT EXISTS snapshot_rollups (
  id BIGSERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  instance TEXT NOT NULL DEFAULT 'default',
  bucket_start BIGINT NOT NULL,
  bucket_seconds INTEGER NOT NULL,
  cpu_avg DOUBLE PRECISION, cpu_min DOUBLE PRECISION, cpu_max DOUBLE PRECISION,
  mem_avg DOUBLE PRECISION, mem_min DOUBLE PRECISION, mem_max DOUBLE PRECISION,
  containers_min INTEGER,
  db_conn_max INTEGER,
  db_connected_min INTEGER CHECK(db_connected_min IN (0, 1)),
  net_max DOUBLE PRECISION,
  sample_count BIGINT NOT NULL,
  http_ok_min INTEGER,
  response_ms_avg DOUBLE PRECISION,
  response_ms_max DOUBLE PRECISION,
  probe_count BIGINT NOT NULL DEFAULT 0,
  UNIQUE(project_id, service, instance, bucket_seconds, bucket_start)
);
CREATE INDEX IF NOT EXISTS idx_rollup_time ON snapshot_rollups(project_id, bucket_start);
CREATE INDEX IF NOT EXISTS idx_rollup_instance_time ON snapshot_rollups(project_id, service, instance, bucket_start);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  timestamp BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  description TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(project_id, timestamp);

CREATE TABLE IF NOT EXISTS incidents (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  start_ts BIGINT NOT NULL,
  end_ts BIGINT,
  last_flag_ts BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
  severity TEXT NOT NULL DEFAULT 'warning' CHECK(severity IN ('warning', 'critical')),
  trigger_metric TEXT,
  services TEXT NOT NULL DEFAULT '[]',
  deploy_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  summary_text TEXT,
  summary_source TEXT NOT NULL DEFAULT 'rule-based',
  summary_mode TEXT NOT NULL DEFAULT 'summary',
  summary_window_minutes INTEGER,
  summary_window_end_ts BIGINT,
  summary_causes_json TEXT NOT NULL DEFAULT '[]',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incidents_project_start ON incidents(project_id, start_ts DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents(project_id, status, last_flag_ts);

CREATE TABLE IF NOT EXISTS bookmarks (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  timestamp BIGINT NOT NULL,
  note TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_project_time ON bookmarks(project_id, timestamp);

CREATE TABLE IF NOT EXISTS demo_scenarios (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scenario_type TEXT NOT NULL,
  expected_metric TEXT NOT NULL,
  detector_version TEXT NOT NULL DEFAULT 'rules-1.0',
  started_at BIGINT NOT NULL,
  ends_at BIGINT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  deploy_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  detected_at BIGINT,
  detected_metric TEXT,
  incident_id INTEGER REFERENCES incidents(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_demo_scenarios_project_start ON demo_scenarios(project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS aws_connections (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  region TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  agent_service TEXT NOT NULL DEFAULT 'main',
  agent_instance TEXT NOT NULL DEFAULT 'default',
  role_arn TEXT,
  external_id TEXT NOT NULL DEFAULT '',
  last_synced_at BIGINT,
  last_attempt_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS aws_metric_points (
  id BIGSERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  region TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  metric_name TEXT NOT NULL CHECK(metric_name IN ('CPUUtilization', 'NetworkIn', 'NetworkOut', 'StatusCheckFailed')),
  timestamp BIGINT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL,
  statistic TEXT NOT NULL,
  period_seconds INTEGER NOT NULL,
  fetched_at BIGINT NOT NULL,
  UNIQUE(project_id, region, instance_id, metric_name, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_aws_metrics_project_time ON aws_metric_points(project_id, region, instance_id, timestamp);
