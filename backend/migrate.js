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
  });
  migrate();
}

module.exports = { runMigrations };