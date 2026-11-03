const Database = require("better-sqlite3");
const { Pool, types } = require("pg");
const { AsyncLocalStorage } = require("node:async_hooks");
const path = require("path");
const { runMigrations } = require("./migrate");
const { createSnapshotQueries } = require("./snapshotQuery");
const { DATABASE_URL, CLOUDREWIND_DB_PATH } = require("./config");

// PostgreSQL BIGINT values in this product are Unix milliseconds and remain
// safely representable as JavaScript numbers for the supported time horizon.
types.setTypeParser(20, (value) => Number(value));

function postgresParameters(sql, args) {
  if (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
    const values = [];
    const translated = sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, key) => {
      values.push(args[0][key]);
      return `$${values.length}`;
    });
    return { sql: translated, values };
  }
  let index = 0;
  const translated = sql.replace(/\?/g, () => `$${++index}`);
  return { sql: translated, values: args };
}

function postgresStatement(query, sql) {
  return {
    async get(...args) {
      const prepared = postgresParameters(sql, args);
      const result = await query(prepared.sql, prepared.values);
      return result.rows[0];
    },
    async all(...args) {
      const prepared = postgresParameters(sql, args);
      const result = await query(prepared.sql, prepared.values);
      return result.rows;
    },
    async run(...args) {
      const prepared = postgresParameters(sql, args);
      const insert = /^\s*INSERT\b/i.test(prepared.sql) && !/\bRETURNING\b/i.test(prepared.sql);
      const result = await query(insert ? `${prepared.sql} RETURNING id` : prepared.sql, prepared.values);
      return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id };
    },
  };
}

class PostgresDatabase {
  constructor(connectionString) {
    this.driver = "postgres";
    this.pool = new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX) || 10,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    this.pool.on("error", (error) => {
      console.error("Unexpected idle PostgreSQL client error:", error.message);
    });
  }

  prepare(sql) {
    return postgresStatement((text, values) => this.pool.query(text, values), sql);
  }

  async exec(sql) {
    const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean);
    for (const statement of statements) await this.pool.query(statement);
  }

  transaction(callback) {
    return async (...args) => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const transactionDb = {
          driver: this.driver,
          prepare: (sql) => postgresStatement((text, values) => client.query(text, values), sql),
          exec: async (sql) => { await client.query(sql); },
        };
        const result = await callback(transactionDb, ...args);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    };
  }

  async initialize() {
    const { runPostgresMigrations } = require("./migratePostgres");
    await runPostgresMigrations(this);
  }

  async close() {
    await this.pool.end();
  }
}

class SQLiteDatabase {
  constructor(raw) {
    this.driver = "sqlite";
    this.raw = raw;
    this.name = raw.name;
    this.context = new AsyncLocalStorage();
    this.tail = Promise.resolve();
  }

  async acquire() {
    let unlock;
    const next = new Promise((resolve) => { unlock = resolve; });
    const previous = this.tail;
    this.tail = next;
    await previous;
    return unlock;
  }

  async locked(operation) {
    if (this.context.getStore() === this) return operation();
    const unlock = await this.acquire();
    try { return operation(); } finally { unlock(); }
  }

  prepare(sql) {
    const statement = this.raw.prepare(sql);
    return {
      get: (...args) => this.locked(() => statement.get(...args)),
      all: (...args) => this.locked(() => statement.all(...args)),
      run: (...args) => this.locked(() => {
        if (/\bRETURNING\b/i.test(sql)) {
          const row = statement.get(...args);
          return { changes: row ? 1 : 0, lastInsertRowid: row?.id };
        }
        return statement.run(...args);
      }),
    };
  }

  exec(sql) {
    return this.locked(() => this.raw.exec(sql));
  }

  pragma(sql) {
    return this.raw.pragma(sql);
  }

  withRaw(operation) {
    return this.locked(() => operation(this.raw));
  }

  transaction(callback) {
    return async (...args) => {
      if (this.context.getStore() === this) return callback(this, ...args);
      const unlock = await this.acquire();
      this.raw.exec("BEGIN IMMEDIATE");
      try {
        const result = await this.context.run(this, () => callback(this, ...args));
        this.raw.exec("COMMIT");
        return result;
      } catch (error) {
        this.raw.exec("ROLLBACK");
        throw error;
      } finally {
        unlock();
      }
    };
  }

  async initialize() {}

  async close() {
    const unlock = await this.acquire();
    try { this.raw.close(); } finally { unlock(); }
  }
}

let db;
if (DATABASE_URL) {
  db = new PostgresDatabase(DATABASE_URL);
} else {
  const dbFile = CLOUDREWIND_DB_PATH
    ? path.resolve(CLOUDREWIND_DB_PATH)
    : path.join(__dirname, "cloudrewind.db");
  const raw = new Database(dbFile);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  runMigrations(raw);
  db = new SQLiteDatabase(raw);
}

function insertStmtFor(database) { return database.prepare(`
  INSERT INTO snapshots (project_id, service, instance, timestamp, cpu, memory, containers, db_connected, db_connections, network, http_status, http_ok, response_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`); }

async function insertSnapshot(projectId, s, database = db) {
  await insertStmtFor(database).run(
    projectId,
    s.service || "main",
    s.instance || "default",
    s.timestamp,
    s.cpu,
    s.memory,
    s.containers ?? null,
    s.db_connected == null ? null : Number(s.db_connected),
    s.db_connections ?? null,
    s.network ?? null,
    s.http_status ?? null,
    s.http_ok ?? null,
    s.response_ms ?? null
  );
}

// Events: deploys, config changes, restarts
async function insertEvent(projectId, e, database = db) {
  const meta = e.meta && Object.keys(e.meta).length ? JSON.stringify(e.meta) : null;
  const result = await database.prepare(
    "INSERT INTO events (project_id, timestamp, event_type, description, meta) VALUES (?, ?, ?, ?, ?) RETURNING id"
  ).run(projectId, e.timestamp, e.event_type, e.description || null, meta);
  return Number(result.lastInsertRowid);
}

// Events in a time range, oldest first. Without from and to: the latest N events.
async function getEvents(projectId, { from, to, limit = 200 } = {}, database = db) {
  const rows =
    from == null && to == null
      ? (await database.prepare("SELECT * FROM events WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?").all(projectId, limit)).reverse()
      : await database
          .prepare("SELECT * FROM events WHERE project_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp LIMIT ?")
          .all(projectId, from ?? 0, to ?? Number.MAX_SAFE_INTEGER, limit);

  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    event_type: r.event_type,
    description: r.description,
    meta: r.meta ? JSON.parse(r.meta) : null,
  }));
}

// Reading snapshots (raw or rollup) lives in snapshotQuery.js
const { getSnapshots, getSnapshotRange, getClosestSnapshot } = createSnapshotQueries(db);

async function getDemoProjects(database = db) {
  return database.prepare("SELECT id FROM projects WHERE is_demo = 1").all();
}

module.exports = { db, insertSnapshot, insertEvent, getEvents, getSnapshots, getSnapshotRange, getClosestSnapshot, getDemoProjects };
