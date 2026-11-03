// Reading snapshots back, for live data and for old data that retention has turned into rollups.
// Rows keep the same field names either way (timestamp, cpu, memory, containers, db_connected, db_connections, network, response_ms),
// so the charts do not care where the numbers came from. Extra fields describe what the row is:
//   summary: true      row comes from a rollup (a 1-minute or 12-hour summary)
//   bucket_seconds     row covers this many seconds (a rollup, or raw data thinned out for a long range)
//   cpu_max, memory_max  the highest value in that period (a short spike is not hidden by the average)

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

const MAX_RAW_SPAN_FOR_PROTECTED = 2 * 60 * 60 * 1000; // show protected raw data inside old ranges only for short views
const NEAR_RAW_MS = 30 * 1000; // a raw snapshot this close to the requested time always wins

function createSnapshotQueries(db) {
  const scopeWhere = (service, instance) => `${service !== undefined ? " AND service = ?" : ""}${instance !== undefined ? " AND instance = ?" : ""}`;
  const args = (projectId, service, instance, ...rest) => [projectId, ...(service !== undefined ? [service] : []), ...(instance !== undefined ? [instance] : []), ...rest];

  // Latest N raw snapshots, oldest first so charts read left to right
  async function getSnapshots(projectId, limit, service, instance) {
    return (await db
      .prepare(`SELECT * FROM snapshots WHERE project_id = ?${scopeWhere(service, instance)} ORDER BY timestamp DESC LIMIT ?`)
      .all(...args(projectId, service, instance, limit))
    ).reverse();
  }

  // Everything before this time has been summarised (null when nothing was rolled up yet)
  async function rolledUpTo(projectId, service, instance) {
    const row = await db
      .prepare(`SELECT MAX(bucket_start + bucket_seconds * 1000) AS t FROM snapshot_rollups WHERE project_id = ?${scopeWhere(service, instance)}`)
      .get(...args(projectId, service, instance));
    return row?.t ?? 0;
  }

  // Raw rows in [from, to). Thinned out (averaged in time buckets) when there are more than "limit".
  async function rawRows(projectId, service, instance, from, to, limit) {
    if (to <= from || limit <= 0) return [];
    const where = `project_id = ?${scopeWhere(service, instance)} AND timestamp >= ? AND timestamp < ?`;
    const base = args(projectId, service, instance, from, to);
    const count = (await db.prepare(`SELECT COUNT(*) AS n FROM snapshots WHERE ${where}`).get(...base)).n;

    if (count <= limit) {
      return db.prepare(`SELECT * FROM snapshots WHERE ${where} ORDER BY timestamp`).all(...base);
    }

    const bucketMs = Math.max(5000, Math.ceil((to - from) / limit / 5000) * 5000);
    return (await db
      .prepare(
        `SELECT service, instance, CAST(AVG(timestamp) AS BIGINT) AS ts, (timestamp / CAST(? AS BIGINT)) AS b,
                AVG(cpu) AS cpu, MAX(cpu) AS cpu_max, AVG(memory) AS memory, MAX(memory) AS memory_max,
                MIN(containers) AS containers, MIN(db_connected) AS db_connected,
                MAX(db_connections) AS db_connections, MAX(network) AS network,
                NULL AS http_status, MIN(http_ok) AS http_ok, AVG(response_ms) AS response_ms,
                MAX(response_ms) AS response_ms_max, COUNT(response_ms) AS probe_count,
                COUNT(*) AS n
         FROM snapshots WHERE ${where} GROUP BY service, instance, b ORDER BY ts`
      )
      .all(bucketMs, ...base)
    ).map((r) => ({
        id: `g${r.b}:${r.service}:${r.instance}`,
        project_id: projectId,
        service: r.service,
        instance: r.instance,
        timestamp: r.ts,
        cpu: round1(r.cpu),
        cpu_max: round1(r.cpu_max),
        memory: round1(r.memory),
        memory_max: round1(r.memory_max),
        containers: r.containers,
        db_connected: r.db_connected,
        db_connections: r.db_connections,
        network: round1(r.network),
        http_status: r.http_status,
        http_ok: r.http_ok,
        response_ms: round1(r.response_ms),
        response_ms_max: round1(r.response_ms_max),
        probe_count: r.probe_count,
        sample_count: r.n,
        bucket_seconds: bucketMs / 1000,
      }));
  }

  // Rollup buckets that start in [from, to). Merged into bigger buckets when there are too many for "limit".
  async function rollupRows(projectId, service, instance, from, to, limit) {
    if (to <= from || limit <= 0) return [];
    const bucketMs = Math.max(60000, Math.ceil((to - from) / limit / 60000) * 60000);
    return (await db
      .prepare(
        `SELECT service, instance, CAST(AVG(bucket_start + bucket_seconds * 500) AS BIGINT) AS ts, (bucket_start / CAST(? AS BIGINT)) AS b,
                SUM(cpu_avg * sample_count) / SUM(sample_count) AS cpu, MIN(cpu_min) AS cpu_min, MAX(cpu_max) AS cpu_max,
                SUM(mem_avg * sample_count) / SUM(sample_count) AS memory, MIN(mem_min) AS mem_min, MAX(mem_max) AS mem_max,
                MIN(containers_min) AS containers, MIN(db_connected_min) AS db_connected,
                MAX(db_conn_max) AS db_connections, MAX(net_max) AS network,
                MIN(http_ok_min) AS http_ok,
                SUM(response_ms_avg * probe_count) / NULLIF(SUM(probe_count), 0) AS response_ms,
                MAX(response_ms_max) AS response_ms_max, SUM(probe_count) AS probe_count,
                SUM(sample_count) AS n, MAX(bucket_seconds) AS bs
         FROM snapshot_rollups
         WHERE project_id = ?${scopeWhere(service, instance)} AND bucket_start >= ? AND bucket_start < ?
         GROUP BY service, instance, b ORDER BY ts`
      )
      .all(bucketMs, ...args(projectId, service, instance, from, to))
    ).map((r) => ({
        id: `r${r.b}:${r.service}:${r.instance}`,
        project_id: projectId,
        service: r.service,
        instance: r.instance,
        timestamp: r.ts,
        cpu: round1(r.cpu),
        cpu_min: round1(r.cpu_min),
        cpu_max: round1(r.cpu_max),
        memory: round1(r.memory),
        memory_min: round1(r.mem_min),
        memory_max: round1(r.mem_max),
        containers: r.containers,
        db_connected: r.db_connected,
        db_connections: r.db_connections,
        network: round1(r.network),
        http_status: null,
        http_ok: r.http_ok,
        response_ms: round1(r.response_ms),
        response_ms_max: round1(r.response_ms_max),
        probe_count: r.probe_count,
        sample_count: r.n,
        bucket_seconds: Math.max(r.bs, bucketMs / 1000),
        summary: true,
      }));
  }

  // A range of snapshots. Picks raw or rollup data by where the range falls:
  //   after the rolled-up point -> raw rows,  before it -> rollups (plus protected raw rows for short views).
  // Without "from" this is the old behaviour: the latest N raw snapshots.
  async function getSnapshotRange(projectId, { from, to, service, instance, limit = 1000, now = Date.now() } = {}) {
    if (from == null) return getSnapshots(projectId, limit, service, instance);

    const end = (to ?? now) + 1; // "to" is included
    const rolled = await rolledUpTo(projectId, service, instance);
    const oldEnd = Math.min(end, rolled);
    const rows = [];
    let limitLeft = limit;

    if (rolled > 0 && from < oldEnd) {
      const share = (oldEnd - from) / (end - from);
      const oldLimit = Math.min(limit, Math.max(50, Math.round(limit * share)));
      rows.push(...await rollupRows(projectId, service, instance, from, oldEnd, oldLimit));
      // Protected windows stay raw, so a short view of an old incident still has full detail
      if (end - from <= MAX_RAW_SPAN_FOR_PROTECTED) rows.push(...await rawRows(projectId, service, instance, from, oldEnd, oldLimit));
      limitLeft = Math.max(50, limit - oldLimit);
    }

    rows.push(...await rawRows(projectId, service, instance, Math.max(from, rolled), end, limitLeft));
    return rows.sort((a, b) => a.timestamp - b.timestamp);
  }

  function rollupToRow(r) {
    return {
      id: `r${r.id}`,
      project_id: r.project_id,
      service: r.service,
      instance: r.instance,
      timestamp: r.bucket_start + r.bucket_seconds * 500,
      cpu: round1(r.cpu_avg),
      cpu_min: round1(r.cpu_min),
      cpu_max: round1(r.cpu_max),
      memory: round1(r.mem_avg),
      memory_min: round1(r.mem_min),
      memory_max: round1(r.mem_max),
      containers: r.containers_min,
      db_connected: r.db_connected_min,
      db_connections: r.db_conn_max,
      network: round1(r.net_max),
      http_status: null,
      http_ok: r.http_ok_min,
      response_ms: round1(r.response_ms_avg),
      response_ms_max: round1(r.response_ms_max),
      probe_count: r.probe_count,
      sample_count: r.sample_count,
      bucket_seconds: r.bucket_seconds,
      summary: true,
    };
  }

  // The snapshot nearest to a time. Looks in raw data first, then in rollups for old times.
  async function getClosestSnapshot(projectId, time, service, instance) {
    const raw = (op, order) =>
      db
        .prepare(`SELECT * FROM snapshots WHERE project_id = ?${scopeWhere(service, instance)} AND timestamp ${op} ? ORDER BY timestamp ${order} LIMIT 1`)
        .get(...args(projectId, service, instance, time));
    const roll = (op, order) =>
      db
        .prepare(`SELECT * FROM snapshot_rollups WHERE project_id = ?${scopeWhere(service, instance)} AND bucket_start ${op} ? ORDER BY bucket_start ${order} LIMIT 1`)
        .get(...args(projectId, service, instance, time));

    const candidates = [];
    for (const r of await Promise.all([raw("<=", "DESC"), raw(">=", "ASC")])) {
      if (r) candidates.push({ row: r, dist: Math.abs(r.timestamp - time), isRaw: true });
    }
    for (const r of await Promise.all([roll("<=", "DESC"), roll(">=", "ASC")])) {
      if (!r) continue;
      const start = r.bucket_start;
      const stop = start + r.bucket_seconds * 1000;
      const dist = time >= start && time <= stop ? 0 : Math.min(Math.abs(time - start), Math.abs(time - stop));
      candidates.push({ row: rollupToRow(r), dist, isRaw: false });
    }
    if (candidates.length === 0) return null;

    const nearRaw = candidates.filter((c) => c.isRaw && c.dist <= NEAR_RAW_MS).sort((a, b) => a.dist - b.dist)[0];
    if (nearRaw) return nearRaw.row;
    return candidates.sort((a, b) => a.dist - b.dist)[0].row;
  }

  return { getSnapshots, getSnapshotRange, getClosestSnapshot };
}

module.exports = { createSnapshotQueries };
