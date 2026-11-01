// Tiered retention (plan Day 12).
//   0 to 48 hours   raw snapshots (every few seconds)
//   2 to 14 days    1-minute rollups (min, max, average)
//   older than 14d  12-hour rollups (min, max, average)
// Raw data within 10 minutes before and after an incident or a bookmark is never rolled up or deleted.
// Safe to run again and again: running it twice in a row changes nothing the second time.

const fs = require("fs");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const RAW_KEEP_MS = 48 * HOUR;       // raw data younger than this is untouched
const MINUTE_KEEP_MS = 14 * DAY;     // 1-minute rollups younger than this are untouched
const BIG_BUCKET_MS = 12 * HOUR;     // size of the long-term rollups
const PROTECT_MS = 10 * MINUTE;      // protected time around an incident or bookmark
const VACUUM_MIN_ROWS = 5000;        // only shrink the file when this many rows were removed

const tableExists = (db, name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

// When a rollup bucket already exists, merge the new numbers into it
// (weighted average, lowest min, highest max). Needed if a protected window is released later.
const merge = (col, fn) =>
  `${col} = CASE WHEN ${col} IS NULL THEN excluded.${col} WHEN excluded.${col} IS NULL THEN ${col} ELSE ${fn}(${col}, excluded.${col}) END`;

const UPSERT = `
  ON CONFLICT(project_id, service, instance, bucket_seconds, bucket_start) DO UPDATE SET
    cpu_avg = (cpu_avg * sample_count + excluded.cpu_avg * excluded.sample_count) / (sample_count + excluded.sample_count),
    cpu_min = min(cpu_min, excluded.cpu_min),
    cpu_max = max(cpu_max, excluded.cpu_max),
    mem_avg = (mem_avg * sample_count + excluded.mem_avg * excluded.sample_count) / (sample_count + excluded.sample_count),
    mem_min = min(mem_min, excluded.mem_min),
    mem_max = max(mem_max, excluded.mem_max),
    ${merge("containers_min", "min")},
    ${merge("db_conn_max", "max")},
    ${merge("net_max", "max")},
    http_ok_min = CASE WHEN http_ok_min IS NULL THEN excluded.http_ok_min WHEN excluded.http_ok_min IS NULL THEN http_ok_min ELSE min(http_ok_min, excluded.http_ok_min) END,
    response_ms_avg = CASE
      WHEN excluded.probe_count = 0 THEN response_ms_avg
      WHEN probe_count = 0 THEN excluded.response_ms_avg
      ELSE (response_ms_avg * probe_count + excluded.response_ms_avg * excluded.probe_count) / (probe_count + excluded.probe_count)
    END,
    ${merge("response_ms_max", "max")},
    probe_count = probe_count + excluded.probe_count,
    sample_count = sample_count + excluded.sample_count`;

const COLUMNS = `project_id, service, instance, bucket_start, bucket_seconds, cpu_avg, cpu_min, cpu_max,
  mem_avg, mem_min, mem_max, containers_min, db_conn_max, net_max, sample_count,
  http_ok_min, response_ms_avg, response_ms_max, probe_count`;

// Time windows that must stay raw. Rounded outward to whole minutes so a minute is never split.
function protectedWindows(db, now) {
  const windows = [];
  const add = (projectId, from, to) =>
    windows.push({
      project_id: projectId,
      start_ts: Math.floor((from - PROTECT_MS) / MINUTE) * MINUTE,
      end_ts: Math.ceil((to + PROTECT_MS) / MINUTE) * MINUTE,
    });

  // These tables arrive in later plan days (incidents Day 15, bookmarks Day 20). Skip them until they exist.
  if (tableExists(db, "incidents")) {
    for (const i of db.prepare("SELECT project_id, start_ts, end_ts FROM incidents").all()) {
      add(i.project_id, i.start_ts, i.end_ts ?? now); // an open incident is protected up to now
    }
  }
  if (tableExists(db, "bookmarks")) {
    for (const b of db.prepare("SELECT project_id, timestamp FROM bookmarks").all()) {
      add(b.project_id, b.timestamp, b.timestamp);
    }
  }
  return windows;
}

function fileSize(db) {
  let size = 0;
  for (const suffix of ["", "-wal"]) {
    try {
      size += fs.statSync(db.name + suffix).size;
    } catch {
      // the file may not exist (for example no -wal file)
    }
  }
  return size;
}

const pgMerge = (col, fn) =>
  `${col} = CASE WHEN ${col} IS NULL THEN EXCLUDED.${col} WHEN EXCLUDED.${col} IS NULL THEN ${col} ELSE ${fn}(${col}, EXCLUDED.${col}) END`;

const POSTGRES_UPSERT = `
  ON CONFLICT(project_id, service, instance, bucket_seconds, bucket_start) DO UPDATE SET
    cpu_avg = (snapshot_rollups.cpu_avg * snapshot_rollups.sample_count + EXCLUDED.cpu_avg * EXCLUDED.sample_count) / (snapshot_rollups.sample_count + EXCLUDED.sample_count),
    cpu_min = LEAST(snapshot_rollups.cpu_min, EXCLUDED.cpu_min),
    cpu_max = GREATEST(snapshot_rollups.cpu_max, EXCLUDED.cpu_max),
    mem_avg = (snapshot_rollups.mem_avg * snapshot_rollups.sample_count + EXCLUDED.mem_avg * EXCLUDED.sample_count) / (snapshot_rollups.sample_count + EXCLUDED.sample_count),
    mem_min = LEAST(snapshot_rollups.mem_min, EXCLUDED.mem_min),
    mem_max = GREATEST(snapshot_rollups.mem_max, EXCLUDED.mem_max),
    ${pgMerge("containers_min", "LEAST")},
    ${pgMerge("db_conn_max", "GREATEST")},
    ${pgMerge("net_max", "GREATEST")},
    http_ok_min = CASE WHEN snapshot_rollups.http_ok_min IS NULL THEN EXCLUDED.http_ok_min WHEN EXCLUDED.http_ok_min IS NULL THEN snapshot_rollups.http_ok_min ELSE LEAST(snapshot_rollups.http_ok_min, EXCLUDED.http_ok_min) END,
    response_ms_avg = CASE
      WHEN EXCLUDED.probe_count = 0 THEN snapshot_rollups.response_ms_avg
      WHEN snapshot_rollups.probe_count = 0 THEN EXCLUDED.response_ms_avg
      ELSE (snapshot_rollups.response_ms_avg * snapshot_rollups.probe_count + EXCLUDED.response_ms_avg * EXCLUDED.probe_count) / (snapshot_rollups.probe_count + EXCLUDED.probe_count)
    END,
    ${pgMerge("response_ms_max", "GREATEST")},
    probe_count = snapshot_rollups.probe_count + EXCLUDED.probe_count,
    sample_count = snapshot_rollups.sample_count + EXCLUDED.sample_count`;

async function postgresProtectedWindows(database, now) {
  const windows = [];
  const add = (projectId, from, to) => windows.push({
    project_id: projectId,
    start_ts: Math.floor((from - PROTECT_MS) / MINUTE) * MINUTE,
    end_ts: Math.ceil((to + PROTECT_MS) / MINUTE) * MINUTE,
  });
  const incidents = await database.prepare("SELECT project_id, start_ts, end_ts FROM incidents").all();
  for (const incident of incidents) add(incident.project_id, incident.start_ts, incident.end_ts ?? now);
  const bookmarks = await database.prepare("SELECT project_id, timestamp FROM bookmarks").all();
  for (const bookmark of bookmarks) add(bookmark.project_id, bookmark.timestamp, bookmark.timestamp);
  return windows;
}

async function runPostgresRetention(database, { now = Date.now(), log = console.log } = {}) {
  const started = Date.now();
  const rawCut = Math.floor((now - RAW_KEEP_MS) / MINUTE) * MINUTE;
  const bigCut = Math.floor((now - MINUTE_KEEP_MS) / BIG_BUCKET_MS) * BIG_BUCKET_MS;
  const result = {
    storage: "postgres",
    protectedWindows: 0,
    rawRolledUp: 0,
    minuteRollupsMade: 0,
    rawDeleted: 0,
    longRollupsMade: 0,
    minuteRollupsDeleted: 0,
    vacuumed: false,
    vacuumError: null,
  };

  await database.transaction(async (transactionDb) => {
    await transactionDb.exec("CREATE TEMP TABLE protected_windows (project_id INTEGER, start_ts BIGINT, end_ts BIGINT) ON COMMIT DROP");
    const windows = await postgresProtectedWindows(transactionDb, now);
    result.protectedWindows = windows.length;
    const insertWindow = transactionDb.prepare("INSERT INTO protected_windows (project_id, start_ts, end_ts) VALUES (?, ?, ?)");
    for (const window of windows) await insertWindow.run(window.project_id, window.start_ts, window.end_ts);

    const notProtected = `NOT EXISTS (SELECT 1 FROM protected_windows p
      WHERE p.project_id = s.project_id AND s.timestamp >= p.start_ts AND s.timestamp < p.end_ts)`;

    const minuteRollups = await transactionDb.prepare(
      `INSERT INTO snapshot_rollups (${COLUMNS})
       SELECT s.project_id, s.service, s.instance, (s.timestamp / 60000) * 60000, 60,
              AVG(s.cpu), MIN(s.cpu), MAX(s.cpu),
              AVG(s.memory), MIN(s.memory), MAX(s.memory),
              MIN(s.containers), MAX(s.db_connections), MAX(s.network), COUNT(*),
              MIN(s.http_ok), AVG(s.response_ms), MAX(s.response_ms), COUNT(s.response_ms)
       FROM snapshots s
       WHERE s.timestamp < ? AND ${notProtected}
       GROUP BY s.project_id, s.service, s.instance, (s.timestamp / 60000)
       ${POSTGRES_UPSERT}`
    ).run(rawCut);
    result.minuteRollupsMade = minuteRollups.changes;

    result.rawDeleted = (await transactionDb.prepare(
      `DELETE FROM snapshots AS s WHERE s.timestamp < ? AND ${notProtected}`
    ).run(rawCut)).changes;
    result.rawRolledUp = result.rawDeleted;

    const longRollups = await transactionDb.prepare(
      `INSERT INTO snapshot_rollups (${COLUMNS})
       SELECT project_id, service, instance, (bucket_start / ${BIG_BUCKET_MS}) * ${BIG_BUCKET_MS}, ${BIG_BUCKET_MS / 1000},
              SUM(cpu_avg * sample_count) / SUM(sample_count), MIN(cpu_min), MAX(cpu_max),
              SUM(mem_avg * sample_count) / SUM(sample_count), MIN(mem_min), MAX(mem_max),
              MIN(containers_min), MAX(db_conn_max), MAX(net_max), SUM(sample_count),
              MIN(http_ok_min), SUM(response_ms_avg * probe_count) / NULLIF(SUM(probe_count), 0),
              MAX(response_ms_max), SUM(probe_count)
       FROM snapshot_rollups
       WHERE bucket_seconds = 60 AND bucket_start < ?
       GROUP BY project_id, service, instance, (bucket_start / ${BIG_BUCKET_MS})
       ${POSTGRES_UPSERT}`
    ).run(bigCut);
    result.longRollupsMade = longRollups.changes;

    result.minuteRollupsDeleted = (await transactionDb.prepare(
      "DELETE FROM snapshot_rollups WHERE bucket_seconds = 60 AND bucket_start < ?"
    ).run(bigCut)).changes;
  })();

  result.seconds = (Date.now() - started) / 1000;
  log(
    `PostgreSQL retention done in ${result.seconds}s: ${result.rawRolledUp} raw rows -> ${result.minuteRollupsMade} 1-minute rollups, ` +
      `${result.minuteRollupsDeleted} old rollups -> ${result.longRollupsMade} 12-hour rollups, ${result.protectedWindows} protected windows. ` +
      "PostgreSQL autovacuum manages reclaimed table space."
  );
  return result;
}

function runRetention(db, { now = Date.now(), log = console.log, vacuum = true } = {}) {
  if (db.driver === "postgres") return runPostgresRetention(db, { now, log });
  if (db.raw && typeof db.withRaw === "function") {
    return db.withRaw((rawDatabase) => runRetention(rawDatabase, { now, log, vacuum }));
  }
  const started = Date.now();
  const sizeBefore = fileSize(db);

  // Whole-bucket cut-offs, so a bucket is never half rolled up
  const rawCut = Math.floor((now - RAW_KEEP_MS) / MINUTE) * MINUTE;
  const bigCut = Math.floor((now - MINUTE_KEEP_MS) / BIG_BUCKET_MS) * BIG_BUCKET_MS;

  const result = {
    protectedWindows: 0,
    rawRolledUp: 0,
    minuteRollupsMade: 0,
    rawDeleted: 0,
    longRollupsMade: 0,
    minuteRollupsDeleted: 0,
    vacuumed: false,
    vacuumError: null,
  };

  const work = db.transaction(() => {
    // 0. Remember which windows are protected
    db.exec("CREATE TEMP TABLE IF NOT EXISTS protected_windows (project_id INTEGER, start_ts INTEGER, end_ts INTEGER)");
    db.exec("DELETE FROM protected_windows");
    const insertWindow = db.prepare("INSERT INTO protected_windows VALUES (@project_id, @start_ts, @end_ts)");
    const windows = protectedWindows(db, now);
    for (const w of windows) insertWindow.run(w);
    result.protectedWindows = windows.length;

    const notProtected = `NOT EXISTS (SELECT 1 FROM temp.protected_windows p
      WHERE p.project_id = s.project_id AND s.timestamp >= p.start_ts AND s.timestamp < p.end_ts)`;

    // 1. Raw older than 48 hours becomes 1-minute rollups, then the raw rows are deleted
    result.minuteRollupsMade = db
      .prepare(
        `INSERT INTO snapshot_rollups (${COLUMNS})
         SELECT s.project_id, s.service, s.instance, (s.timestamp / 60000) * 60000, 60,
                AVG(s.cpu), MIN(s.cpu), MAX(s.cpu),
                AVG(s.memory), MIN(s.memory), MAX(s.memory),
                MIN(s.containers), MAX(s.db_connections), MAX(s.network), COUNT(*),
                MIN(s.http_ok), AVG(s.response_ms), MAX(s.response_ms), COUNT(s.response_ms)
         FROM snapshots s
         WHERE s.timestamp < ? AND ${notProtected}
         GROUP BY s.project_id, s.service, s.instance, (s.timestamp / 60000)
         ${UPSERT}`
      )
      .run(rawCut).changes;

    result.rawDeleted = db
      .prepare(`DELETE FROM snapshots AS s WHERE s.timestamp < ? AND ${notProtected}`)
      .run(rawCut).changes;
    result.rawRolledUp = result.rawDeleted;

    // 2. 1-minute rollups older than 14 days become 12-hour rollups
    result.longRollupsMade = db
      .prepare(
        `INSERT INTO snapshot_rollups (${COLUMNS})
         SELECT project_id, service, instance, (bucket_start / ${BIG_BUCKET_MS}) * ${BIG_BUCKET_MS}, ${BIG_BUCKET_MS / 1000},
                SUM(cpu_avg * sample_count) / SUM(sample_count), MIN(cpu_min), MAX(cpu_max),
                SUM(mem_avg * sample_count) / SUM(sample_count), MIN(mem_min), MAX(mem_max),
                MIN(containers_min), MAX(db_conn_max), MAX(net_max), SUM(sample_count),
                MIN(http_ok_min), SUM(response_ms_avg * probe_count) / NULLIF(SUM(probe_count), 0),
                MAX(response_ms_max), SUM(probe_count)
         FROM snapshot_rollups
         WHERE bucket_seconds = 60 AND bucket_start < ?
         GROUP BY project_id, service, instance, (bucket_start / ${BIG_BUCKET_MS})
         ${UPSERT}`
      )
      .run(bigCut).changes;

    result.minuteRollupsDeleted = db
      .prepare("DELETE FROM snapshot_rollups WHERE bucket_seconds = 60 AND bucket_start < ?")
      .run(bigCut).changes;

    db.exec("DROP TABLE IF EXISTS temp.protected_windows");
  });
  work();

  // 3. Give the freed space back to the disk (VACUUM cannot run inside a transaction)
  if (vacuum && result.rawDeleted + result.minuteRollupsDeleted >= VACUUM_MIN_ROWS) {
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
      db.pragma("wal_checkpoint(TRUNCATE)");
      result.vacuumed = true;
    } catch (err) {
      // For example the backend is busy writing. The space is reused by new data anyway.
      result.vacuumError = err.message;
    }
  }

  result.sizeBefore = sizeBefore;
  result.sizeAfter = fileSize(db);
  result.seconds = (Date.now() - started) / 1000;
  log(
    `Retention done in ${result.seconds}s: ${result.rawRolledUp} raw rows -> ${result.minuteRollupsMade} 1-minute rollups, ` +
      `${result.minuteRollupsDeleted} old rollups -> ${result.longRollupsMade} 12-hour rollups, ` +
      `${result.protectedWindows} protected windows, file ${(sizeBefore / 1e6).toFixed(1)} MB -> ${(result.sizeAfter / 1e6).toFixed(1)} MB` +
      (result.vacuumError ? ` (file not shrunk now: ${result.vacuumError})` : "")
  );
  return result;
}

module.exports = { runRetention, runPostgresRetention, RAW_KEEP_MS, MINUTE_KEEP_MS, BIG_BUCKET_MS, PROTECT_MS };
