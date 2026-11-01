const fs = require("node:fs/promises");
const path = require("node:path");

const MIGRATIONS = [
  { version: "001_initial", file: "schema.postgres.sql" },
  { version: "002_workspace_invites", file: "schema.workspace-invites.postgres.sql" },
  { version: "003_incident_summary_source", file: "schema.incident-summary-source.postgres.sql" },
  { version: "004_incident_ai_window", file: "schema.incident-ai-window.postgres.sql" },
];

function splitStatements(source) {
  return source
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function runPostgresMigrations(database) {
  const apply = database.transaction(async (transactionDb) => {
    // Serialize startup migrations when multiple backend replicas start together.
    await transactionDb.prepare("SELECT pg_advisory_xact_lock(hashtext('cloudrewind:schema-migrations'))").get();
    await transactionDb.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)");
    for (const migration of MIGRATIONS) {
      const applied = await transactionDb.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(migration.version);
      if (applied) continue;
      const source = await fs.readFile(path.join(__dirname, migration.file), "utf8");
      for (const statement of splitStatements(source)) await transactionDb.exec(statement);
      await transactionDb.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?) RETURNING version").run(migration.version, Date.now());
    }
  });
  await apply();
}

module.exports = { runPostgresMigrations, splitStatements };
