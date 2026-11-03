const {
  db: defaultDb,
} = require("./db");
const { createSnapshotQueries } = require("./snapshotQuery");

const RECOVERY_MS = 2 * 60 * 1000;
const DETECTOR_VERSION = "rules-1.0";
const HISTORY_SIZE = 120;
const MIN_BASELINE = 20;

const METRICS = [
  { key: "cpu", label: "CPU", stdFloor: 2, hard: 90 },
  { key: "memory", label: "Memory", stdFloor: 2, hard: 90 },
  { key: "db_connections", label: "Database connections", stdFloor: 2 },
  { key: "network", label: "Network", stdFloor: 10 },
  { key: "response_ms", label: "HTTP response time", stdFloor: 25 },
];

const safeJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

function stats(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

async function readAnomalies(database, projectId, snapshot) {
  const project = await database.prepare("SELECT db_max_connections FROM projects WHERE id = ?").get(projectId);
  const anomalies = [];
  const service = snapshot.service || "main";
  const instance = snapshot.instance || "default";

  for (const metric of METRICS) {
    const value = snapshot[metric.key];
    if (value == null || !Number.isFinite(value)) continue;

    const history = (await database
      .prepare(
        `SELECT ${metric.key} AS value FROM snapshots
         WHERE project_id = ? AND service = ? AND instance = ? AND timestamp < ? AND ${metric.key} IS NOT NULL
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(projectId, service, instance, snapshot.timestamp, HISTORY_SIZE))
      .map((row) => row.value)
      .reverse();

    let evidence = null;
    if (metric.hard != null && value >= metric.hard) {
      evidence = { rule: `${metric.key}_at_or_above_${metric.hard}`, severity: "critical", z_score: null, baseline_avg: null, baseline_std: null };
    }

    if (!evidence && metric.key === "db_connections" && project?.db_max_connections) {
      const warningAt = project.db_max_connections * 0.85;
      if (value >= warningAt) {
        evidence = {
          rule: "database_connection_limit",
          severity: value >= project.db_max_connections ? "critical" : "warning",
          z_score: null,
          baseline_avg: null,
          baseline_std: null,
        };
      }
    }

    // Use the recent three readings as the signal and the earlier readings as the baseline.
    // Requiring three consecutive deviations reduces single-sample noise.
    if (!evidence && history.length >= MIN_BASELINE + 2) {
      const baseline = history.slice(0, -2);
      const recent = [...history.slice(-2), value];
      const { mean, std } = stats(baseline);
      const threshold = mean + 3 * Math.max(std, metric.stdFloor);
      if (recent.every((reading) => reading > threshold)) {
        evidence = {
          rule: "three_consecutive_z_score_deviations",
          severity: "warning",
          z_score: (value - mean) / Math.max(std, metric.stdFloor),
          baseline_avg: Math.round(mean * 10) / 10,
          baseline_std: Math.round(std * 10) / 10,
        };
      }
    }

    if (evidence) {
      anomalies.push({
        metric: metric.key,
        metric_label: metric.label,
        service,
        instance,
        timestamp: snapshot.timestamp,
        value,
        peak_value: value,
        peak_seen_ts: snapshot.timestamp,
        first_seen_ts: snapshot.timestamp,
        last_seen_ts: snapshot.timestamp,
        ...evidence,
      });
    }
  }

  if (snapshot.http_status != null) {
    const previous = await database
      .prepare(
        `SELECT http_status FROM snapshots
         WHERE project_id = ? AND service = ? AND instance = ? AND timestamp < ? AND http_status IS NOT NULL
         ORDER BY timestamp DESC LIMIT 2`
      )
      .all(projectId, service, instance, snapshot.timestamp);
    const failed = (status) => status === 0 || status >= 400;
    if (failed(snapshot.http_status) && previous.length === 2 && previous.every((row) => failed(row.http_status))) {
      anomalies.push({
        metric: "health_check",
        metric_label: "HTTP health check",
        service,
        instance,
        timestamp: snapshot.timestamp,
        value: snapshot.http_status,
        peak_value: snapshot.http_status,
        peak_seen_ts: snapshot.timestamp,
        first_seen_ts: snapshot.timestamp,
        last_seen_ts: snapshot.timestamp,
        baseline_avg: null,
        baseline_std: null,
        z_score: null,
        rule: "three_consecutive_failed_http_probes",
        severity: "critical",
      });
    }
  }

  if (snapshot.db_connected != null) {
    const previous = await database
      .prepare(
        `SELECT db_connected FROM snapshots
         WHERE project_id = ? AND service = ? AND instance = ? AND timestamp < ? AND db_connected IS NOT NULL
         ORDER BY timestamp DESC LIMIT 2`
      )
      .all(projectId, service, instance, snapshot.timestamp);
    const disconnected = (value) => Number(value) === 0;
    if (disconnected(snapshot.db_connected) && previous.length === 2 && previous.every((row) => disconnected(row.db_connected))) {
      anomalies.push({
        metric: "db_connected",
        metric_label: "Database connectivity",
        service,
        instance,
        timestamp: snapshot.timestamp,
        value: 0,
        peak_value: 0,
        peak_seen_ts: snapshot.timestamp,
        first_seen_ts: snapshot.timestamp,
        last_seen_ts: snapshot.timestamp,
        baseline_avg: null,
        baseline_std: null,
        z_score: null,
        rule: "three_consecutive_database_failures",
        severity: "critical",
      });
    }
  }

  if (snapshot.containers != null) {
    const previous = await database
      .prepare(
        `SELECT containers FROM snapshots
         WHERE project_id = ? AND service = ? AND instance = ? AND timestamp < ? AND containers IS NOT NULL
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(projectId, service, instance, snapshot.timestamp, HISTORY_SIZE);
    const normalCount = previous.length ? Math.max(...previous.map((row) => row.containers)) : null;
    if (normalCount != null && snapshot.containers < normalCount) {
      anomalies.push({
        metric: "containers",
        metric_label: "Running containers",
        service,
        instance,
        timestamp: snapshot.timestamp,
        value: snapshot.containers,
        peak_value: snapshot.containers,
        peak_seen_ts: snapshot.timestamp,
        first_seen_ts: snapshot.timestamp,
        last_seen_ts: snapshot.timestamp,
        baseline_avg: normalCount,
        baseline_std: null,
        z_score: null,
        rule: "container_count_decreased",
        severity: "warning",
      });
    }
  }

  return anomalies;
}

function mergeEvidence(previous, current) {
  const byKey = new Map(previous.map((item) => [`${item.service}:${item.instance || "default"}:${item.metric}`, item]));
  for (const item of current) {
    const key = `${item.service}:${item.instance || "default"}:${item.metric}`;
    const old = byKey.get(key);
    if (!old) {
      byKey.set(key, item);
      continue;
    }
    old.last_seen_ts = item.timestamp;
    if (item.value > (old.peak_value ?? old.value)) {
      old.peak_value = item.value;
      old.peak_seen_ts = item.timestamp;
    }
    if (item.z_score != null && (old.z_score == null || item.z_score > old.z_score)) old.z_score = item.z_score;
    if (item.severity === "critical") old.severity = "critical";
  }
  return [...byKey.values()].sort((a, b) => a.first_seen_ts - b.first_seen_ts);
}

function makeSummary(incident, evidence) {
  if (!evidence.length) return "No metric evidence was recorded for this incident.";
  const first = evidence[0];
  const date = new Date(first.first_seen_ts).toLocaleString();
  const deploy = incident.deploy_event_id ? " A deploy was recorded shortly before the incident; timing alone does not show it caused the issue." : "";
  const sourceName = (item) => item.instance && item.instance !== "default" ? `${item.service} (${item.instance})` : item.service;
  const formatValue = (item, value) => item.metric === "db_connected" ? (Number(value) === 1 ? "connected" : "disconnected") : value;
  const metrics = evidence.map((item) => `${item.metric_label} on ${sourceName(item)} (${formatValue(item, item.value)}${item.peak_value !== item.value ? `, peak ${formatValue(item, item.peak_value)}` : ""})`).join(", ");
  return `The first recorded abnormal reading was ${first.metric_label} on ${sourceName(first)} at ${date}. The incident evidence includes ${metrics}.${deploy} The sequence is temporal evidence, not proof of causation.`;
}

async function recordScenarioDetection(database, projectId, timestamp, anomalies, incidentId) {
  if (!anomalies.length) return;
  const signals = new Set(anomalies.map((item) => item.metric));
  const runs = await database
    .prepare(
      `SELECT id, expected_metric FROM demo_scenarios
       WHERE project_id = ? AND detected_at IS NULL AND started_at <= ? AND ends_at + 30000 >= ?
       ORDER BY started_at DESC LIMIT 10`
    )
    .all(projectId, timestamp, timestamp);
  const update = database.prepare(
    "UPDATE demo_scenarios SET detected_at = ?, detected_metric = ?, incident_id = ? WHERE id = ? AND detected_at IS NULL"
  );
  for (const run of runs) {
    if (run.expected_metric === "none") {
      await update.run(timestamp, anomalies[0].metric, incidentId, run.id);
    } else if (signals.has(run.expected_metric)) {
      await update.run(timestamp, run.expected_metric, incidentId, run.id);
    }
  }
}

async function processSnapshot(snapshot, { database = defaultDb } = {}) {
  const detect = database.transaction(async (transactionDb) => {
    if (transactionDb.driver === "postgres") {
      await transactionDb.prepare("SELECT id FROM projects WHERE id = ? FOR UPDATE").get(snapshot.project_id);
    }
    const anomalies = await readAnomalies(transactionDb, snapshot.project_id, snapshot);
    const open = await transactionDb
      .prepare("SELECT * FROM incidents WHERE project_id = ? AND status = 'open' ORDER BY start_ts DESC LIMIT 1")
      .get(snapshot.project_id);

    if (anomalies.length === 0) {
      if (open && snapshot.timestamp - open.last_flag_ts >= RECOVERY_MS) {
        await transactionDb
          .prepare("UPDATE incidents SET status = 'closed', end_ts = last_flag_ts WHERE id = ?")
          .run(open.id);
        return { incidentId: open.id, status: "closed", anomalies: [] };
      }
      return { incidentId: open?.id ?? null, status: open ? "open" : "normal", anomalies: [] };
    }

    const priorEvidence = open ? safeJson(open.evidence_json, []) : [];
    const evidence = mergeEvidence(priorEvidence, anomalies);
    const sourceNames = anomalies.map((item) => item.instance && item.instance !== "default" ? `${item.service}@${item.instance}` : item.service);
    const services = [...new Set([...safeJson(open?.services, []), ...sourceNames])];
    const severity = anomalies.some((item) => item.severity === "critical") || open?.severity === "critical" ? "critical" : "warning";
    const triggerMetric = open?.trigger_metric || anomalies[0].metric;
    const now = snapshot.timestamp;

    if (open) {
      const keepGeneratedAnalysis = open.summary_source === "groq";
      const summary = keepGeneratedAnalysis && open.summary_text ? open.summary_text : makeSummary(open, evidence);
      await transactionDb
        .prepare(
          `UPDATE incidents SET last_flag_ts = ?, severity = ?, services = ?, evidence_json = ?, summary_text = ?,
           summary_source = ?, summary_mode = ?, summary_window_minutes = ?, summary_window_end_ts = ?, summary_causes_json = ?
           WHERE id = ?`
        )
        .run(
          now,
          severity,
          JSON.stringify(services),
          JSON.stringify(evidence),
          summary,
          keepGeneratedAnalysis ? "groq" : "rule-based",
          keepGeneratedAnalysis ? open.summary_mode : "summary",
          keepGeneratedAnalysis ? open.summary_window_minutes : null,
          keepGeneratedAnalysis ? open.summary_window_end_ts : null,
          keepGeneratedAnalysis ? open.summary_causes_json : "[]",
          open.id
        );
      await recordScenarioDetection(transactionDb, snapshot.project_id, now, anomalies, open.id);
      return { incidentId: open.id, status: "open", anomalies };
    }

    const deploy = await transactionDb
      .prepare(
        `SELECT id FROM events WHERE project_id = ? AND event_type = 'deploy'
         AND timestamp BETWEEN ? AND ? ORDER BY ABS(timestamp - ?) LIMIT 1`
      )
      .get(snapshot.project_id, now - 15 * 60 * 1000, now, now);
    const inserted = await transactionDb
      .prepare(
        `INSERT INTO incidents
         (project_id, start_ts, last_flag_ts, status, severity, trigger_metric, services, deploy_event_id, evidence_json, created_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`
      )
      .run(snapshot.project_id, now, now, severity, triggerMetric, JSON.stringify(services), deploy?.id ?? null, JSON.stringify(evidence), now);
    const incidentId = Number(inserted.lastInsertRowid);
    const incident = { deploy_event_id: deploy?.id ?? null };
      await transactionDb.prepare("UPDATE incidents SET summary_text = ?, summary_source = 'rule-based', summary_mode = 'summary', summary_window_minutes = NULL, summary_window_end_ts = NULL, summary_causes_json = '[]' WHERE id = ?").run(makeSummary(incident, evidence), incidentId);
    await recordScenarioDetection(transactionDb, snapshot.project_id, now, anomalies, incidentId);
    return { incidentId, status: "open", anomalies };
  });
  return detect();
}

function presentIncident(row) {
  const durationMinutes = Number(row.summary_window_minutes) || null;
  const windowEnd = Number(row.summary_window_end_ts ?? row.last_flag_ts ?? row.end_ts ?? row.start_ts);
  return {
    ...row,
    services: safeJson(row.services, []),
    evidence: safeJson(row.evidence_json, []),
    possible_causes: safeJson(row.summary_causes_json, []),
    analysis_is_stale: row.summary_source === "groq" && row.last_flag_ts > windowEnd,
    analysis_window: durationMinutes ? {
      from: windowEnd - durationMinutes * 60 * 1000,
      to: windowEnd,
      duration_minutes: durationMinutes,
    } : null,
  };
}

async function listIncidents(projectId, { database = defaultDb, limit = 50 } = {}) {
  return (await database
    .prepare("SELECT * FROM incidents WHERE project_id = ? ORDER BY start_ts DESC LIMIT ?")
    .all(projectId, limit))
    .map(presentIncident);
}

function diffSnapshots(before, after) {
  if (!before || !after) return null;
  const fields = [
    ["cpu", "CPU", 20],
    ["memory", "Memory", 20],
    ["containers", "Running containers", 1],
    ["db_connections", "Database connections", 50],
    ["network", "Network", null],
  ];
  const changes = [];
  for (const [key, label, threshold] of fields) {
    const a = before[key];
    const b = after[key];
    if (a == null || b == null) continue;
    const delta = Math.round((b - a) * 10) / 10;
    const percent = a === 0 ? null : Math.round((delta / Math.abs(a)) * 1000) / 10;
    const major = threshold == null ? Math.abs(delta) >= Math.max(50, Math.abs(a) * 2) : Math.abs(delta) >= threshold;
    changes.push({ metric: key, label, before: a, after: b, delta, percent_change: percent, major });
  }
  changes.sort((a, b) => Number(b.major) - Number(a.major) || Math.abs(b.delta) - Math.abs(a.delta));
  return { before, after, changes };
}

async function findSimilarIncidents(database, projectId, incidentId, evidence) {
  const current = new Set(evidence.map((item) => `${item.service}:${item.instance || "default"}:${item.metric}`));
  if (current.size === 0) return [];
  const candidates = await database
    .prepare("SELECT id, start_ts, severity, evidence_json FROM incidents WHERE project_id = ? AND id != ? AND status = 'closed' ORDER BY start_ts DESC LIMIT 200")
    .all(projectId, incidentId);

  return candidates
    .map((row) => {
      const previous = new Set(safeJson(row.evidence_json, []).map((item) => `${item.service}:${item.instance || "default"}:${item.metric}`));
      const shared = [...current].filter((key) => previous.has(key)).length;
      const union = new Set([...current, ...previous]).size;
      return { id: row.id, start_ts: row.start_ts, severity: row.severity, similarity: union ? Math.round((shared / union) * 100) : 0, shared_signals: shared };
    })
    .filter((row) => row.similarity >= 50)
    .sort((a, b) => b.similarity - a.similarity || b.start_ts - a.start_ts)
    .slice(0, 3);
}

async function getIncidentBundle(projectId, incidentId, { database = defaultDb } = {}) {
  const row = await database.prepare("SELECT * FROM incidents WHERE id = ? AND project_id = ?").get(incidentId, projectId);
  if (!row) return null;
  const incident = presentIncident(row);
  const snapshotQueries = createSnapshotQueries(database);
  const firstService = incident.evidence[0]?.service;
  const firstInstance = incident.evidence[0]?.instance || "default";
  const before = await snapshotQueries.getClosestSnapshot(projectId, incident.start_ts - 60 * 1000, firstService, firstInstance);
  const lastTs = incident.end_ts ?? incident.last_flag_ts;
  const peakTime = incident.evidence.find((item) => item.metric === incident.trigger_metric)?.peak_seen_ts ?? incident.evidence[0]?.peak_seen_ts;
  const peak = await snapshotQueries.getClosestSnapshot(projectId, peakTime ?? Math.floor((incident.start_ts + lastTs) / 2), firstService, firstInstance);
  const after = await snapshotQueries.getClosestSnapshot(projectId, lastTs + 60 * 1000, firstService, firstInstance);
  const deploy = row.deploy_event_id
    ? await database.prepare("SELECT * FROM events WHERE id = ? AND project_id = ?").get(row.deploy_event_id, projectId)
    : null;
  const timeline = await snapshotQueries.getSnapshotRange(projectId, {
    from: incident.start_ts - 60 * 1000,
    to: lastTs + 60 * 1000,
    service: firstService,
    instance: firstInstance,
    limit: 500,
  });
  const awsPoints = await database.prepare(
    `SELECT region, instance_id, metric_name, timestamp, value, unit, statistic, period_seconds
     FROM aws_metric_points
     WHERE project_id = ? AND timestamp >= ? AND timestamp <= ?
     ORDER BY timestamp, metric_name LIMIT 500`
  ).all(projectId, incident.start_ts - 15 * 60 * 1000, lastTs + 15 * 60 * 1000);
  const mapping = await database.prepare("SELECT agent_service, agent_instance FROM aws_connections WHERE project_id = ?").get(projectId);
  const agentBucket = mapping && database.prepare(
    `SELECT AVG(cpu) AS cpu_avg, COUNT(*) AS sample_count FROM snapshots
     WHERE project_id = ? AND service = ? AND instance = ? AND timestamp >= ? AND timestamp < ? AND cpu IS NOT NULL`
  );
  const awsEvidence = await Promise.all(awsPoints.map(async (point) => {
    const comparison = agentBucket && point.metric_name === "CPUUtilization"
      ? await agentBucket.get(projectId, mapping.agent_service, mapping.agent_instance, point.timestamp, point.timestamp + point.period_seconds * 1000)
      : null;
    const agentCpu = comparison?.sample_count ? Math.round(comparison.cpu_avg * 10) / 10 : null;
    return {
      ...point,
      source: "aws_cloudwatch",
      agent_service: mapping?.agent_service ?? null,
      agent_instance: mapping?.agent_instance ?? null,
      agent_cpu_avg: agentCpu,
      agent_sample_count: comparison?.sample_count ?? 0,
      cpu_gap_points: agentCpu == null ? null : Math.round((point.value - agentCpu) * 10) / 10,
    };
  }));
  return {
    ...incident,
    deploy,
    similar_incidents: await findSimilarIncidents(database, projectId, incidentId, incident.evidence),
    before,
    peak,
    after,
    diff: diffSnapshots(before, peak),
    timeline,
    aws_evidence: awsEvidence,
  };
}

module.exports = { processSnapshot, listIncidents, getIncidentBundle, diffSnapshots, makeSummary, findSimilarIncidents, RECOVERY_MS, DETECTOR_VERSION };
