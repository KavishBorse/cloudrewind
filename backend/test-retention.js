// Test for tiered retention. Uses a temporary database, never your real one.
// Usage:  node test-retention.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { runMigrations } = require("./migrate");
const { runRetention } = require("./retention");
const { createSnapshotQueries } = require("./snapshotQuery");
const { listProjectStreams } = require("./projectStreams");

async function main() {
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const STEP = 5000; // one snapshot every 5 seconds
const DAYS = 20;   // 10 days of old data is the plan's test; 20 also reaches the 12-hour rollups (older than 14 days)

const file = path.join(os.tmpdir(), "cloudrewind-retention-test.db");
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });

const db = new Database(file);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
runMigrations(db);

const now = Math.floor(Date.now() / STEP) * STEP;
db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES ('t@t.t', 'x', ?)").run(now);
db.prepare("INSERT INTO projects (user_id, name, api_key_hash, api_key_prefix, created_at) VALUES (1, 'Test', 'h', 'cr_test', ?)").run(now);

// Moments with known behaviour
const spikeA = now - 4 * DAY;                    // CPU 95 for 30 s, will live in a 1-minute rollup
const spikeB = now - 17 * DAY;                   // CPU 97 for 30 s, will live in a 12-hour rollup
const gapStart = now - 6 * DAY;                  // no data for 4 hours
const gapEnd = gapStart + 4 * HOUR;
const bookmarkAt = now - 5 * DAY;                // raw data around it must stay raw
const incidentStart = now - 9 * DAY;             // so must raw data around this incident
const incidentEnd = incidentStart + 3 * MIN;
db.prepare("INSERT INTO bookmarks (project_id, user_id, timestamp, created_at) VALUES (1, 1, ?, ?)").run(bookmarkAt, now);
db.prepare("INSERT INTO incidents (project_id, start_ts, end_ts, last_flag_ts, created_at) VALUES (1, ?, ?, ?, ?)").run(incidentStart, incidentEnd, incidentEnd, now);

// ---- make the fake data ----
const insert = db.prepare(
  "INSERT INTO snapshots (project_id, service, timestamp, cpu, memory, containers, db_connections, network, http_status, http_ok, response_ms) VALUES (1, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?)"
);
let total = 0;
db.transaction(() => {
  for (let t = now - DAYS * DAY; t <= now; t += STEP) {
    if (t >= gapStart && t < gapEnd) continue;
    const k = (t - (now - DAYS * DAY)) / STEP;
    let cpu = 20 + 5 * Math.sin(k / 50);
    if ((t >= spikeA && t < spikeA + 30000) || (t >= spikeB && t < spikeB + 30000)) cpu = t >= spikeB && t < spikeB + 30000 ? 97 : 95;
    const memory = 40 + (k % 600) / 12;
    const healthFailed = (t >= spikeA && t < spikeA + 30000) || (t >= spikeB && t < spikeB + 30000);
    const httpStatus = healthFailed ? 503 : 200;
    const responseMs = healthFailed ? 1800 : 20 + (k % 30);
    insert.run(t, cpu, memory, k % 600 >= 595 ? 2 : 3, 10 + (k % 11), 300 + (k % 500), httpStatus, healthFailed ? 0 : 1, responseMs);
    total++;
  }
})();
// This stream has only old data, so retention moves every reading into a rollup.
db.prepare(
  "INSERT INTO snapshots (project_id, service, instance, timestamp, cpu, memory) VALUES (1, 'worker', 'old-host', ?, 35, 45)"
).run(now - 17 * DAY - 30_000);
total++;
console.log(`Made ${total} fake snapshots over ${DAYS} days (one every 5 seconds).`);

// ---- what must stay raw ----
const aligned = (ts, pad) => [Math.floor((ts - pad) / MIN) * MIN, Math.ceil((ts + pad) / MIN) * MIN];
const protect = [aligned(bookmarkAt, 10 * MIN), [aligned(incidentStart, 10 * MIN)[0], aligned(incidentEnd, 10 * MIN)[1]]];
const countIn = (a, b) => db.prepare("SELECT COUNT(*) n FROM snapshots WHERE timestamp >= ? AND timestamp < ?").get(a, b).n;
const protectedBefore = protect.map(([a, b]) => countIn(a, b));

// ---- run retention ----
const sizeBefore = fs.statSync(file).size;
const result = await runRetention(db, { now });

// ---- checks ----
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failed++;
};

const q = createSnapshotQueries(db);
const rawLeft = db.prepare("SELECT COUNT(*) n FROM snapshots").get().n;
const rollupSamples = db.prepare("SELECT SUM(sample_count) n FROM snapshot_rollups").get().n;
const oldRaw = db.prepare("SELECT COUNT(*) n FROM snapshots WHERE timestamp < ?").get(now - 48 * HOUR - MIN).n;
const protectedAfter = protect.map(([a, b]) => countIn(a, b));
const protectedTotal = protectedAfter.reduce((a, b) => a + b, 0);

check("no sample lost (raw rows + rollup samples = original)", rawLeft + rollupSamples === total, `${rawLeft} + ${rollupSamples} = ${rawLeft + rollupSamples}, expected ${total}`);
check("raw data older than 48 hours is only the protected windows", oldRaw === protectedTotal, `${oldRaw} old raw rows, ${protectedTotal} protected`);
check("protected windows keep every raw row", protectedBefore.every((n, i) => n === protectedAfter[i] && n > 100), `bookmark ${protectedAfter[0]} rows, incident ${protectedAfter[1]} rows`);
check("recent 48 hours untouched", countIn(now - 48 * HOUR + MIN, now + 1) > 34000);
check("1-minute rollups exist (2 to 14 days)", db.prepare("SELECT COUNT(*) n FROM snapshot_rollups WHERE bucket_seconds = 60").get().n > 15000);
check("12-hour rollups exist (older than 14 days)", db.prepare("SELECT COUNT(*) n FROM snapshot_rollups WHERE bucket_seconds = 43200").get().n >= 8);
check("no 1-minute rollup older than 14 days left", db.prepare("SELECT COUNT(*) n FROM snapshot_rollups WHERE bucket_seconds = 60 AND bucket_start < ?").get(now - 14 * DAY - 12 * HOUR).n === 0);
const discoveredStreams = await listProjectStreams(db, 1);
check("service discovery can still find streams kept only in rollups", discoveredStreams.some((row) => row.service === "worker" && row.instance === "old-host" && row.last_seen_at === null), discoveredStreams.map((row) => `${row.service}/${row.instance}`).join(", "));
const oldHost = await q.getClosestSnapshot(1, now - 17 * DAY - 30_000, "worker", "old-host");
check("an old-only instance remains queryable after retention", oldHost?.summary === true && oldHost.service === "worker" && oldHost.instance === "old-host");

const spikeAMax = db.prepare("SELECT MAX(cpu_max) m FROM snapshot_rollups WHERE bucket_start >= ? AND bucket_start < ?").get(spikeA - MIN, spikeA + MIN).m;
const spikeBMax = db.prepare("SELECT MAX(cpu_max) m FROM snapshot_rollups WHERE bucket_start >= ? AND bucket_start < ?").get(spikeB - 12 * HOUR, spikeB + 12 * HOUR).m;
check("short spike survives in a 1-minute rollup (max kept)", spikeAMax >= 95, `cpu_max ${spikeAMax}`);
check("short spike survives in a 12-hour rollup (max kept)", spikeBMax >= 97, `cpu_max ${spikeBMax}`);
const healthAMin = db.prepare("SELECT MIN(http_ok_min) min, MAX(response_ms_max) max, SUM(probe_count) n FROM snapshot_rollups WHERE bucket_start >= ? AND bucket_start < ?").get(spikeA - MIN, spikeA + MIN);
const healthBMin = db.prepare("SELECT MIN(http_ok_min) min, MAX(response_ms_max) max, SUM(probe_count) n FROM snapshot_rollups WHERE bucket_seconds = 43200 AND bucket_start >= ? AND bucket_start < ?").get(spikeB - 12 * HOUR, spikeB + 12 * HOUR);
check("failed health checks and latency survive in 1-minute rollups", healthAMin.min === 0 && healthAMin.max === 1800 && healthAMin.n > 0, `http_ok_min ${healthAMin.min}, response_ms_max ${healthAMin.max}`);
check("failed health checks and latency survive in 12-hour rollups", healthBMin.min === 0 && healthBMin.max === 1800 && healthBMin.n > 0, `http_ok_min ${healthBMin.min}, response_ms_max ${healthBMin.max}`);

// Reading back through the same code the API uses
const last30 = await q.getSnapshotRange(1, { from: now - 30 * MIN, to: now, now });
check("last 30 minutes: raw rows, no summary", last30.length > 300 && last30.every((r) => !r.summary && !r.bucket_seconds), `${last30.length} rows`);

const week = await q.getSnapshotRange(1, { from: now - 7 * DAY, to: now, limit: 600, now });
check("7 days: about the limit, mixes summary and raw", week.length <= 700 && week.some((r) => r.summary) && week.some((r) => !r.summary), `${week.length} rows`);
check("7 days: rows are in time order", week.every((r, i) => i === 0 || r.timestamp >= week[i - 1].timestamp));

const around = await q.getSnapshotRange(1, { from: spikeA - 30 * MIN, to: spikeA + 30 * MIN, now });
check("old range still shows the spike", Math.max(...around.map((r) => r.cpu_max ?? r.cpu)) >= 95, `${around.length} rows, summary=${around[0].summary}`);

const twenty = await q.getSnapshotRange(1, { from: now - 20 * DAY, to: now, limit: 600, now });
check("20 days: shows the 12-hour spike", Math.max(...twenty.map((r) => r.cpu_max ?? r.cpu)) >= 97, `${twenty.length} rows`);

const gapRows = await q.getSnapshotRange(1, { from: gapStart - 2 * HOUR, to: gapEnd + 2 * HOUR, now });
let biggestGap = 0;
gapRows.forEach((r, i) => i && (biggestGap = Math.max(biggestGap, r.timestamp - gapRows[i - 1].timestamp)));
check("the 4-hour gap is still a gap (not filled in)", biggestGap >= 3.9 * HOUR, `largest gap ${(biggestGap / HOUR).toFixed(2)} h`);

const prot = await q.getSnapshotRange(1, { from: bookmarkAt - 5 * MIN, to: bookmarkAt + 5 * MIN, now });
check("short view of a bookmark: full raw detail", prot.length >= 110 && prot.every((r) => !r.summary), `${prot.length} rows`);

const nearSpike = await q.getClosestSnapshot(1, spikeA + 10000);
check("rewind to an old moment answers from a rollup", nearSpike && nearSpike.summary === true && nearSpike.cpu_max >= 95, `cpu_max ${nearSpike?.cpu_max}`);
const nearBookmark = await q.getClosestSnapshot(1, bookmarkAt);
check("rewind to a bookmark answers with a raw snapshot", nearBookmark && !nearBookmark.summary, `timestamp offset ${nearBookmark ? nearBookmark.timestamp - bookmarkAt : "none"} ms`);
const nearNew = await q.getClosestSnapshot(1, now - 10 * MIN);
check("rewind to a recent moment answers with a raw snapshot", nearNew && !nearNew.summary);

const sizeAfter = fs.statSync(file).size + (fs.existsSync(file + "-wal") ? fs.statSync(file + "-wal").size : 0);
check("database file got smaller", sizeAfter < sizeBefore * 0.5 && result.vacuumed, `${(sizeBefore / 1e6).toFixed(1)} MB -> ${(sizeAfter / 1e6).toFixed(1)} MB (${Math.round((1 - sizeAfter / sizeBefore) * 100)}% smaller)`);

const second = await runRetention(db, { now, log: () => {} });
check("running it again changes nothing", second.rawDeleted === 0 && second.minuteRollupsDeleted === 0 && second.longRollupsMade === 0);

// A bookmark deleted later: its raw data becomes a rollup on the next run and merges cleanly
db.prepare("DELETE FROM bookmarks").run();
const third = await runRetention(db, { now, log: () => {} });
const totalAfterRelease = db.prepare("SELECT COUNT(*) n FROM snapshots").get().n + db.prepare("SELECT SUM(sample_count) n FROM snapshot_rollups").get().n;
check("releasing a bookmark rolls its raw data up without losing samples", third.rawDeleted > 0 && totalAfterRelease === total, `${third.rawDeleted} rows rolled up`);

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
db.close();
fs.rmSync(file, { force: true });
for (const suffix of ["-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
