const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function runMigrations(db) {
  const migrate = db.transaction(() => {
    // 1. Old-shape snapshots table (no project_id): set it aside
    let hadOld = false;
    if (tableExists(db, "snapshots") && !columnNames(db, "snapshots").includes("project_id")) {
      db.exec("ALTER TABLE snapshots RENAME TO snapshots_old");
      hadOld = true;
    }

    // 2. Create all current tables
    db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

    if (tableExists(db, "users") && !columnNames(db, "users").includes("full_name")) {
      db.exec("ALTER TABLE users ADD COLUMN full_name TEXT NOT NULL DEFAULT ''");
    }
    if (tableExists(db, "users") && !columnNames(db, "users").includes("organization_name")) {
      db.exec("ALTER TABLE users ADD COLUMN organization_name TEXT NOT NULL DEFAULT ''");
    }
    if (tableExists(db, "projects") && !columnNames(db, "projects").includes("environment")) {
      db.exec("ALTER TABLE projects ADD COLUMN environment TEXT NOT NULL DEFAULT 'production'");
    }
    if (tableExists(db, "projects") && !columnNames(db, "projects").includes("workspace_id")) {
      db.exec("ALTER TABLE projects ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id)");
    if (tableExists(db, "workspace_invites") && !columnNames(db, "workspace_invites").includes("revoked_at")) {
      db.exec("ALTER TABLE workspace_invites ADD COLUMN revoked_at INTEGER");
    }
    if (tableExists(db, "incidents") && !columnNames(db, "incidents").includes("summary_source")) {
      db.exec("ALTER TABLE incidents ADD COLUMN summary_source TEXT NOT NULL DEFAULT 'rule-based'");
    }
    if (tableExists(db, "incidents") && !columnNames(db, "incidents").includes("summary_mode")) {
      db.exec("ALTER TABLE incidents ADD COLUMN summary_mode TEXT NOT NULL DEFAULT 'summary'");
    }
    if (tableExists(db, "incidents") && !columnNames(db, "incidents").includes("summary_window_minutes")) {
      db.exec("ALTER TABLE incidents ADD COLUMN summary_window_minutes INTEGER");
    }
    if (tableExists(db, "incidents") && !columnNames(db, "incidents").includes("summary_window_end_ts")) {
      db.exec("ALTER TABLE incidents ADD COLUMN summary_window_end_ts INTEGER");
    }
    if (tableExists(db, "incidents") && !columnNames(db, "incidents").includes("summary_causes_json")) {
      db.exec("ALTER TABLE incidents ADD COLUMN summary_causes_json TEXT NOT NULL DEFAULT '[]'");
    }

    // Keep incremental additions to newly introduced feature tables safe for an existing local DB.
    if (tableExists(db, "demo_scenarios") && !columnNames(db, "demo_scenarios").includes("detector_version")) {
      db.exec("ALTER TABLE demo_scenarios ADD COLUMN detector_version TEXT NOT NULL DEFAULT 'rules-1.0'");
    }
    if (tableExists(db, "aws_connections") && !columnNames(db, "aws_connections").includes("last_attempt_at")) {
      db.exec("ALTER TABLE aws_connections ADD COLUMN last_attempt_at INTEGER");
    }
    if (tableExists(db, "aws_connections") && !columnNames(db, "aws_connections").includes("agent_service")) {
      db.exec("ALTER TABLE aws_connections ADD COLUMN agent_service TEXT NOT NULL DEFAULT 'main'");
    }
    if (tableExists(db, "aws_connections") && !columnNames(db, "aws_connections").includes("agent_instance")) {
      db.exec("ALTER TABLE aws_connections ADD COLUMN agent_instance TEXT NOT NULL DEFAULT 'default'");
    }
    if (tableExists(db, "aws_connections") && !columnNames(db, "aws_connections").includes("role_arn")) {
      db.exec("ALTER TABLE aws_connections ADD COLUMN role_arn TEXT");
    }
    if (tableExists(db, "aws_connections") && !columnNames(db, "aws_connections").includes("external_id")) {
      db.exec("ALTER TABLE aws_connections ADD COLUMN external_id TEXT NOT NULL DEFAULT ''");
    }

    // Optional HTTP health probes add app availability and latency to host metrics.
    const snapshotColumns = tableExists(db, "snapshots") ? columnNames(db, "snapshots") : [];
    if (!snapshotColumns.includes("instance")) db.exec("ALTER TABLE snapshots ADD COLUMN instance TEXT NOT NULL DEFAULT 'default'");
    if (!snapshotColumns.includes("http_status")) db.exec("ALTER TABLE snapshots ADD COLUMN http_status INTEGER");
    if (!snapshotColumns.includes("http_ok")) db.exec("ALTER TABLE snapshots ADD COLUMN http_ok INTEGER");
    if (!snapshotColumns.includes("response_ms")) db.exec("ALTER TABLE snapshots ADD COLUMN response_ms REAL");

    const rollupColumns = tableExists(db, "snapshot_rollups") ? columnNames(db, "snapshot_rollups") : [];
    if (!rollupColumns.includes("instance")) db.exec("ALTER TABLE snapshot_rollups ADD COLUMN instance TEXT NOT NULL DEFAULT 'default'");
    if (!rollupColumns.includes("http_ok_min")) db.exec("ALTER TABLE snapshot_rollups ADD COLUMN http_ok_min INTEGER");
    if (!rollupColumns.includes("response_ms_avg")) db.exec("ALTER TABLE snapshot_rollups ADD COLUMN response_ms_avg REAL");
    if (!rollupColumns.includes("response_ms_max")) db.exec("ALTER TABLE snapshot_rollups ADD COLUMN response_ms_max REAL");
    if (!rollupColumns.includes("probe_count")) db.exec("ALTER TABLE snapshot_rollups ADD COLUMN probe_count INTEGER NOT NULL DEFAULT 0");

    // A service may run on several hosts. Keep each instance's rollups independent.
    const rollupUniqueIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_rollup_unique'").get();
    if (!rollupUniqueIndex?.sql?.includes("instance")) {
      db.exec("DROP INDEX IF EXISTS idx_rollup_unique");
      db.exec("CREATE UNIQUE INDEX idx_rollup_unique ON snapshot_rollups(project_id, service, instance, bucket_seconds, bucket_start)");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_snap_instance ON snapshots(project_id, service, instance, timestamp)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_rollup_instance_time ON snapshot_rollups(project_id, service, instance, bucket_start)");

    // 3. Move old data into a Demo Project
    if (hadOld) {
      const now = Date.now();
      const userId = db
        .prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)")
        .run("legacy-demo@cloudrewind.local", "!", now).lastInsertRowid;

      const fakeKeyHash = crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
      const projectId = db
        .prepare(
          `INSERT INTO projects (user_id, name, api_key_hash, api_key_prefix, is_demo, created_at)
           VALUES (?, 'Demo Project', ?, 'demo', 1, ?)`
        )
        .run(userId, fakeKeyHash, now).lastInsertRowid;

      db.prepare(
        `INSERT INTO snapshots (project_id, service, timestamp, cpu, memory, containers, db_connections, network)
         SELECT ?, 'main', timestamp, cpu, memory,
                (SELECT COUNT(*) FROM json_each(snapshots_old.containers)
                  WHERE json_extract(value, '$.status') = 'running'),
                db_connections, network * 1024
         FROM snapshots_old`
      ).run(projectId);

      db.exec("DROP TABLE snapshots_old");
      console.log("Migrated old snapshots into Demo Project", projectId);
    }

    // Give every existing account a personal workspace, then move its old
    // projects into that workspace. This is safe to run on every startup.
    const usersWithoutWorkspace = db.prepare(
      `SELECT u.id, u.full_name, u.organization_name, u.email
       FROM users u WHERE NOT EXISTS (
         SELECT 1 FROM workspace_members wm WHERE wm.user_id = u.id
       )`
    ).all();
    const createWorkspace = db.prepare("INSERT INTO workspaces (name, created_by, created_at) VALUES (?, ?, ?)");
    const addOwner = db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)");
    const now = Date.now();
    for (const user of usersWithoutWorkspace) {
      const name = user.organization_name?.trim() || `${user.full_name?.trim() || user.email.split("@")[0]}'s workspace`;
      const workspaceId = createWorkspace.run(name, user.id, now).lastInsertRowid;
      addOwner.run(workspaceId, user.id, now);
    }
    db.exec(
      `UPDATE projects SET workspace_id = (
         SELECT wm.workspace_id FROM workspace_members wm
         WHERE wm.user_id = projects.user_id
         ORDER BY CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END, wm.id
         LIMIT 1
       ) WHERE workspace_id IS NULL`
    );
  });
  migrate();
}

module.exports = { runMigrations };
