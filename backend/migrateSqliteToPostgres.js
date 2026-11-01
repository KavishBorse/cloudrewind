const Database = require("better-sqlite3");
const path = require("node:path");
const { db: target } = require("./db");

const TABLE_ORDER = [
  "users",
  "workspaces",
  "workspace_members",
  "workspace_invites",
  "projects",
  "snapshots",
  "snapshot_rollups",
  "events",
  "incidents",
  "bookmarks",
  "demo_scenarios",
  "aws_connections",
  "aws_metric_points",
];
const BATCH_SIZE = 250;

function quoteIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function sqliteTables(source) {
  return new Set(source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
}

function assertMigratedSqlite(source, availableTables) {
  const projectColumns = availableTables.has("projects")
    ? new Set(source.prepare("PRAGMA table_info(projects)").all().map((column) => column.name))
    : new Set();
  if (!availableTables.has("workspaces") || !availableTables.has("workspace_members") || !projectColumns.has("workspace_id")) {
    throw new Error("Start the SQLite backend once with DATABASE_URL unset so it can apply workspace migrations, then stop it and retry the import.");
  }
  const unassigned = source.prepare("SELECT COUNT(*) AS count FROM projects WHERE workspace_id IS NULL").get().count;
  const usersWithoutMembership = source.prepare(
    "SELECT COUNT(*) AS count FROM users u WHERE NOT EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.user_id = u.id)"
  ).get().count;
  if (Number(unassigned) || Number(usersWithoutMembership)) {
    throw new Error("SQLite workspace backfill is incomplete. Start the SQLite backend once to finish its migrations, then retry.");
  }
}

async function assertEmptyTarget(database) {
  for (const table of TABLE_ORDER) {
    const row = await database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get();
    if (Number(row.count) !== 0) {
      throw new Error(`Target table ${table} is not empty. Import only into a newly migrated PostgreSQL database.`);
    }
  }
}

async function importTable(source, transactionDb, table) {
  const columns = source.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((column) => column.name);
  if (!columns.length) return 0;
  const targetColumns = await transactionDb.prepare(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?"
  ).all(table);
  const targetNames = new Set(targetColumns.map((column) => column.column_name));
  const absent = columns.filter((column) => !targetNames.has(column));
  if (absent.length) throw new Error(`PostgreSQL table ${table} is missing columns: ${absent.join(", ")}`);

  const select = source.prepare(`SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)}`);
  const quotedTable = quoteIdentifier(table);
  const quotedColumns = columns.map(quoteIdentifier).join(", ");
  let batch = [];
  let copied = 0;

  const flush = async () => {
    if (!batch.length) return;
    const rowValues = `(${columns.map(() => "?").join(", ")})`;
    const values = batch.flatMap((row) => columns.map((column) => row[column]));
    const statement = `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES ${batch.map(() => rowValues).join(", ")}`;
    await transactionDb.prepare(statement).run(...values);
    copied += batch.length;
    batch = [];
  };

  for (const row of select.iterate()) {
    batch.push(row);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
  return copied;
}

async function resetSequence(transactionDb, table) {
  await transactionDb.prepare(
    `SELECT setval(pg_get_serial_sequence(?, 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${quoteIdentifier(table)}`
  ).get(table);
}

async function migrateSqliteToPostgres(sqlitePath) {
  if (target.driver !== "postgres") throw new Error("Set DATABASE_URL in backend/.env before running the PostgreSQL importer.");
  const sourcePath = path.resolve(sqlitePath);
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  source.pragma("foreign_keys = ON");

  try {
    source.exec("BEGIN");
    await target.initialize();
    await assertEmptyTarget(target);
    const availableTables = sqliteTables(source);
    assertMigratedSqlite(source, availableTables);
    const results = {};

    const importTransaction = target.transaction(async (transactionDb) => {
      for (const table of TABLE_ORDER) {
        if (!availableTables.has(table)) continue;
        results[table] = await importTable(source, transactionDb, table);
      }
      for (const table of TABLE_ORDER) {
        if (availableTables.has(table) && results[table]) await resetSequence(transactionDb, table);
      }

      for (const [table, count] of Object.entries(results)) {
        const targetCount = Number((await transactionDb.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get()).count);
        if (targetCount !== count) throw new Error(`Import verification failed for ${table}: copied ${count}, target contains ${targetCount}`);
      }
    });
    await importTransaction();

    return results;
  } finally {
    try { source.exec("ROLLBACK"); } catch {}
    source.close();
  }
}

if (require.main === module) {
  const sqlitePath = process.argv[2] || process.env.CLOUDREWIND_DB_PATH || path.join(__dirname, "cloudrewind.db");
  migrateSqliteToPostgres(sqlitePath)
    .then((results) => {
      console.log("SQLite to PostgreSQL import completed and row counts verified:");
      for (const [table, count] of Object.entries(results)) console.log(`  ${table}: ${count}`);
    })
    .catch((error) => {
      console.error("SQLite to PostgreSQL import failed:", error.message);
      process.exitCode = 1;
    })
    .finally(() => target.close());
}

module.exports = { migrateSqliteToPostgres, assertMigratedSqlite, TABLE_ORDER, BATCH_SIZE };
