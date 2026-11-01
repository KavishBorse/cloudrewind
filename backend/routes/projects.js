const express = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("node:crypto");
const { z } = require("zod");
const { GROQ_API_KEY } = require("../config");
const { db, getSnapshotRange, getClosestSnapshot, getEvents } = require("../db");
const { listProjectStreams } = require("../projectStreams");
const { generateApiKey } = require("../apiKeys");
const { requireAuth } = require("../middleware/requireAuth");
const { requireWorkspace, requireWorkspaceRole } = require("../middleware/requireWorkspace");
const { ownsProject } = require("../middleware/ownsProject");
const { diffSnapshots, listIncidents, getIncidentBundle, makeSummary, DETECTOR_VERSION } = require("../incidentService");
const { generateGroqAnalysis } = require("../groqNarrative");
const { triggerDemoScenario, SCENARIOS } = require("../simulator");

const router = express.Router();
router.use(requireAuth); // everything below needs a logged-in user
router.use(requireWorkspace);

const MAX_PROJECTS = 10;
const AGENT_ONLINE_MS = 30 * 1000; // no data for 30 seconds = agent offline

// What the browser is allowed to see about a project (never the key hash)
function present(p) {
  return {
    id: p.id,
    name: p.name,
    environment: p.environment || "production",
    is_demo: p.is_demo,
    api_key_prefix: p.api_key_prefix,
    last_seen_at: p.last_seen_at,
    created_at: p.created_at,
    agent_online: p.is_demo === 0 && p.last_seen_at !== null && Date.now() - p.last_seen_at < AGENT_ONLINE_MS,
  };
}

const newProject = z.object({
  name: z.string().trim().min(1, "Give the project a name").max(60, "Name is too long (max 60 characters)"),
  environment: z.enum(["production", "staging", "development", "other"]).default("production"),
});

// My projects (never includes key hashes)
router.get("/", async (req, res) => {
  const projects = await db
    .prepare(
      `SELECT id, name, environment, is_demo, api_key_prefix, last_seen_at, created_at
       FROM projects WHERE workspace_id = ? ORDER BY id`
    )
    .all(req.workspace.id);
  res.json(projects.map(present));
});

// Create a project. The full API key is returned here once and never again.
router.post("/", requireWorkspaceRole("owner", "admin"), async (req, res) => {
  const parsed = newProject.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const count = (await db.prepare("SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?").get(req.workspace.id)).n;
  if (count >= MAX_PROJECTS) {
    return res.status(400).json({ error: `You can have up to ${MAX_PROJECTS} projects` });
  }

  const { key, hash, prefix } = generateApiKey();
  const now = Date.now();
  const inserted = await db
    .prepare(
      `INSERT INTO projects (user_id, workspace_id, name, environment, api_key_hash, api_key_prefix, is_demo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .run(req.user.id, req.workspace.id, parsed.data.name, parsed.data.environment, hash, prefix, now);
  const id = inserted.lastInsertRowid;

  res.status(201).json({
    project: { id: Number(id), name: parsed.data.name, environment: parsed.data.environment, is_demo: 0, api_key_prefix: prefix, last_seen_at: null, created_at: now, agent_online: false },
    apiKey: key,
  });
});

// Sample telemetry is opt-in and kept in an unmistakably separate project.
router.post("/demo", requireWorkspaceRole("owner", "admin"), async (req, res) => {
  const count = (await db.prepare("SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?").get(req.workspace.id)).n;
  if (count >= MAX_PROJECTS) {
    return res.status(400).json({ error: `You can have up to ${MAX_PROJECTS} projects` });
  }
  const existing = await db.prepare(
    "SELECT id FROM projects WHERE workspace_id = ? AND is_demo = 1 LIMIT 1"
  ).get(req.workspace.id);
  if (existing) return res.status(409).json({ error: "This workspace already has a sample project" });

  const now = Date.now();
  const unusedKeyHash = crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
  const inserted = await db.prepare(
    `INSERT INTO projects (user_id, workspace_id, name, environment, api_key_hash, api_key_prefix, is_demo, created_at)
     VALUES (?, ?, 'CloudRewind Sample', 'development', ?, 'sample', 1, ?)`
  ).run(req.user.id, req.workspace.id, unusedKeyHash, now);
  res.status(201).json({
    project: {
      id: Number(inserted.lastInsertRowid),
      name: "CloudRewind Sample",
      environment: "development",
      is_demo: 1,
      api_key_prefix: "sample",
      last_seen_at: null,
      created_at: now,
      agent_online: false,
    },
  });
});

// One project (name, status)
router.get("/:id", ownsProject, (req, res) => {
  res.json(present(req.project));
});

// New key. The old key stops working immediately.
router.post("/:id/rotate-key", ownsProject, requireWorkspaceRole("owner", "admin"), async (req, res) => {
  if (req.project.is_demo) return res.status(400).json({ error: "Demo projects do not use an API key" });

  const { key, hash, prefix } = generateApiKey();
  await db.prepare("UPDATE projects SET api_key_hash = ?, api_key_prefix = ? WHERE id = ?").run(hash, prefix, req.project.id);
  res.json({ apiKey: key, api_key_prefix: prefix });
});

// Delete a project and all its snapshots (the database removes them with it)
router.delete("/:id", ownsProject, requireWorkspaceRole("owner", "admin"), async (req, res) => {
  await db.prepare("DELETE FROM projects WHERE id = ?").run(req.project.id);
  res.json({ ok: true });
});

// Read an optional query number (milliseconds). Returns undefined when absent, NaN when invalid.
function optionalTime(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

// Snapshots of one project.
//   ?limit=N                       latest N raw snapshots (the old behaviour)
//   ?from=ms&to=ms&service=api     a time range. Recent data is raw; older data comes from rollups
//                                  (rows then have summary: true). Long ranges are thinned out to about "limit" rows.
router.get("/:id/snapshots", ownsProject, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 1000, 10), 5000);
  const from = optionalTime(req.query.from);
  const to = optionalTime(req.query.to);
  const service = req.query.service;
  const instance = req.query.instance;

  if (Number.isNaN(from)) return res.status(400).json({ error: "from must be a time in milliseconds" });
  if (Number.isNaN(to)) return res.status(400).json({ error: "to must be a time in milliseconds" });
  if (from !== undefined && to !== undefined && from >= to) {
    return res.status(400).json({ error: "from must be before to" });
  }
  if (service !== undefined && !/^[a-zA-Z0-9_-]{1,40}$/.test(String(service))) {
    return res.status(400).json({ error: "service may only use letters, numbers, - and _ (1 to 40 characters)" });
  }
  if (instance !== undefined && !/^[a-zA-Z0-9_.-]{1,80}$/.test(String(instance))) {
    return res.status(400).json({ error: "instance may only use letters, numbers, dots, - and _ (1 to 80 characters)" });
  }

  res.json(await getSnapshotRange(req.project.id, { from, to, service, instance, limit }));
});

// Events (deploys, config changes, restarts) of one project.
//   ?from=ms&to=ms&limit=N   oldest first. Without from and to: the latest N events.
router.get("/:id/events", ownsProject, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 500);
  const from = optionalTime(req.query.from);
  const to = optionalTime(req.query.to);

  if (Number.isNaN(from)) return res.status(400).json({ error: "from must be a time in milliseconds" });
  if (Number.isNaN(to)) return res.status(400).json({ error: "to must be a time in milliseconds" });
  if (from !== undefined && to !== undefined && from >= to) {
    return res.status(400).json({ error: "from must be before to" });
  }

  res.json(await getEvents(req.project.id, { from, to, limit }));
});

// Snapshot closest to a time (?time=<milliseconds>). Old times are answered from rollups.
router.get("/:id/snapshot", ownsProject, async (req, res) => {
  const time = Number(req.query.time);
  if (!time) return res.status(400).json({ error: "time query param required" });
  const service = req.query.service;
  const instance = req.query.instance;
  if (service !== undefined && !/^[a-zA-Z0-9_-]{1,40}$/.test(String(service))) {
    return res.status(400).json({ error: "service may only use letters, numbers, - and _ (1 to 40 characters)" });
  }
  if (instance !== undefined && !/^[a-zA-Z0-9_.-]{1,80}$/.test(String(instance))) {
    return res.status(400).json({ error: "instance may only use letters, numbers, dots, - and _ (1 to 80 characters)" });
  }

  const snapshot = await getClosestSnapshot(req.project.id, time, service, instance);
  if (!snapshot) return res.status(404).json({ error: "no snapshots yet" });
  res.json(snapshot);
});

// Services currently reporting data to this project.
router.get("/:id/services", ownsProject, async (req, res) => {
  res.json(await listProjectStreams(db, req.project.id));
});

// Nearest reading for every service at one timestamp, for a synchronized cross-service view.
router.get("/:id/services-at", ownsProject, async (req, res) => {
  const time = Number(req.query.time);
  if (!Number.isFinite(time) || time <= 0) return res.status(400).json({ error: "time query param required" });
  const streams = await listProjectStreams(db, req.project.id);
  res.json(await Promise.all(streams.map(async ({ service, instance }) => ({ service, instance, snapshot: await getClosestSnapshot(req.project.id, time, service, instance) }))));
});

// Compare two exact moments. A rollup may be returned for timestamps outside raw retention.
router.get("/:id/diff", ownsProject, async (req, res) => {
  const from = optionalTime(req.query.from);
  const to = optionalTime(req.query.to);
  const service = req.query.service;
  const instance = req.query.instance;
  if (Number.isNaN(from) || from === undefined) return res.status(400).json({ error: "from must be a time in milliseconds" });
  if (Number.isNaN(to) || to === undefined) return res.status(400).json({ error: "to must be a time in milliseconds" });
  if (from >= to) return res.status(400).json({ error: "from must be before to" });
  if (service !== undefined && !/^[a-zA-Z0-9_-]{1,40}$/.test(String(service))) {
    return res.status(400).json({ error: "service may only use letters, numbers, - and _ (1 to 40 characters)" });
  }
  if (instance !== undefined && !/^[a-zA-Z0-9_.-]{1,80}$/.test(String(instance))) {
    return res.status(400).json({ error: "instance may only use letters, numbers, dots, - and _ (1 to 80 characters)" });
  }
  const [before, after] = await Promise.all([
    getClosestSnapshot(req.project.id, from, service, instance),
    getClosestSnapshot(req.project.id, to, service, instance),
  ]);
  if (!before || !after) return res.status(404).json({ error: "not enough snapshots to compare" });
  res.json(diffSnapshots(before, after));
});

// Incidents are built from validated telemetry by the backend's rule-based detector.
router.get("/:id/incidents", ownsProject, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  res.json(await listIncidents(req.project.id, { limit }));
});

// Controlled demo runs have known target signals, so their detection rate and delay can be summarized.
// This is a synthetic evaluation, not a production accuracy estimate.
router.get("/:id/experiments", ownsProject, async (req, res) => {
  if (req.project.is_demo !== 1) return res.status(403).json({ error: "Experiments are available only in demo projects" });
  const scenarios = await db
    .prepare("SELECT * FROM demo_scenarios WHERE project_id = ? ORDER BY started_at DESC LIMIT 50")
    .all(req.project.id);
  const runs = scenarios.map((scenario) => {
    const isControl = scenario.expected_metric === "none";
    const alarm = scenario.detected_at != null;
    return {
      id: scenario.id,
      scenario_type: scenario.scenario_type,
      expected_metric: scenario.expected_metric,
      detector_version: scenario.detector_version,
      started_at: scenario.started_at,
      ends_at: scenario.ends_at,
      completed: Date.now() > scenario.ends_at + 30_000,
      duration_seconds: scenario.duration_seconds,
      detected: !isControl && alarm,
      false_alarm: isControl && alarm,
      detected_at: scenario.detected_at,
      detected_metric: scenario.detected_metric,
      detection_latency_seconds: scenario.detected_at == null ? null : Math.max(0, Math.round((scenario.detected_at - scenario.started_at) / 100) / 10),
      incident_id: scenario.incident_id,
    };
  });
  const completed = runs.filter((run) => Date.now() > run.ends_at + 30_000);
  const positiveRuns = completed.filter((run) => run.expected_metric !== "none");
  const controlRuns = completed.filter((run) => run.expected_metric === "none");
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 10) / 10;
  };
  const byScenario = SCENARIOS.map((scenarioType) => {
    const group = completed.filter((run) => run.scenario_type === scenarioType);
    const isControl = scenarioType === "normal_control";
    const outcomes = group.filter((run) => isControl ? run.false_alarm : run.detected);
    return {
      scenario_type: scenarioType,
      completed_runs: group.length,
      outcome_count: outcomes.length,
      outcome_rate_percent: group.length ? Math.round((outcomes.length / group.length) * 100) : null,
      median_outcome_latency_seconds: median(outcomes.map((run) => run.detection_latency_seconds)),
      is_control: isControl,
    };
  });
  res.json({
    runs,
    by_scenario: byScenario,
    summary: {
      completed_runs: completed.length,
      positive_runs: positiveRuns.length,
      detected_runs: positiveRuns.filter((run) => run.detected).length,
      detection_rate_percent: positiveRuns.length ? Math.round((positiveRuns.filter((run) => run.detected).length / positiveRuns.length) * 100) : null,
      median_detection_latency_seconds: median(positiveRuns.filter((run) => run.detected).map((run) => run.detection_latency_seconds)),
      control_runs: controlRuns.length,
      false_alarms: controlRuns.filter((run) => run.false_alarm).length,
      false_alarm_rate_percent: controlRuns.length ? Math.round((controlRuns.filter((run) => run.false_alarm).length / controlRuns.length) * 100) : null,
    },
  });
});

router.get("/:id/incidents/:incidentId", ownsProject, async (req, res) => {
  const incidentId = Number(req.params.incidentId);
  if (!Number.isInteger(incidentId) || incidentId < 1) return res.status(400).json({ error: "Invalid incident id" });
  const bundle = await getIncidentBundle(req.project.id, incidentId);
  if (!bundle) return res.status(404).json({ error: "Incident not found" });
  res.json(bundle);
});

router.get("/:id/narrative-status", ownsProject, (_req, res) => {
  res.json({ groq_available: Boolean(GROQ_API_KEY) });
});

const narrativeRequest = z.object({
  provider: z.enum(["rules", "groq"]).default("rules"),
  mode: z.enum(["summary", "likely_cause"]).default("summary"),
  durationMinutes: z.number().int().min(15).max(10080).default(60),
  consentToGroq: z.boolean().default(false),
});

const groqNarrativeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `user:${req.user.id}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "AI analyses are limited to 10 requests per 15 minutes per user." },
});

function applyGroqNarrativeLimit(req, res, next) {
  if (req.body?.provider !== "groq") return next();
  return groqNarrativeLimiter(req, res, next);
}

// Groq is called only for an explicit, user-confirmed, bounded time window.
router.post("/:id/incidents/:incidentId/narrative", ownsProject, applyGroqNarrativeLimit, async (req, res) => {
  const incidentId = Number(req.params.incidentId);
  if (!Number.isInteger(incidentId) || incidentId < 1) return res.status(400).json({ error: "Invalid incident id" });
  const row = await db.prepare("SELECT * FROM incidents WHERE id = ? AND project_id = ?").get(incidentId, req.project.id);
  if (!row) return res.status(404).json({ error: "Incident not found" });
  const parsedRequest = narrativeRequest.safeParse(req.body || {});
  if (!parsedRequest.success) return res.status(400).json({ error: parsedRequest.error.issues[0].message });
  const { provider, mode, durationMinutes, consentToGroq } = parsedRequest.data;
  if (provider === "groq" && !consentToGroq) {
    return res.status(400).json({ error: "Confirm before sending incident metrics to Groq." });
  }

  const evidence = JSON.parse(row.evidence_json || "[]");
  let summary = makeSummary(row, evidence);
  let possibleCauses = [];
  let source = "rule-based";
  let outputMode = "summary";
  let notice = null;
  let analysisWindow = null;
  let metricCounts = { agent: 0, cloudwatch: 0 };

  if (provider === "groq") {
    const windowEnd = Number(row.last_flag_ts || row.end_ts || row.start_ts);
    const windowStart = windowEnd - durationMinutes * 60 * 1000;
    analysisWindow = { from: windowStart, to: windowEnd, duration_minutes: durationMinutes };

    const [agentReadings, awsConnection] = await Promise.all([
      getSnapshotRange(req.project.id, { from: windowStart, to: windowEnd, limit: 120 }),
      db.prepare("SELECT region, instance_id FROM aws_connections WHERE project_id = ?").get(req.project.id),
    ]);
    const awsReadings = awsConnection ? await db.prepare(
        `SELECT region, metric_name, timestamp, value, unit, statistic, period_seconds
         FROM aws_metric_points
         WHERE project_id = ? AND region = ? AND instance_id = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp, metric_name LIMIT 10000`
      ).all(req.project.id, awsConnection.region, awsConnection.instance_id, windowStart, windowEnd) : [];
    metricCounts = { agent: agentReadings.length, cloudwatch: awsReadings.length };

    if (!GROQ_API_KEY) {
      notice = "Groq is not configured on this backend, so the evidence-based rule summary is shown instead.";
    } else if (agentReadings.length === 0 && awsReadings.length === 0) {
      summary = "No agent or CloudWatch metric readings were recorded in the selected window. Try a longer duration before generating an AI analysis.";
      notice = "There are no agent or CloudWatch readings in this selected window. Try a longer duration.";
    } else {
      try {
        const analysis = await generateGroqAnalysis({
          incident: row,
          window: { start: windowStart, end: windowEnd, durationMinutes },
          agentReadings,
          awsReadings,
          mode,
        });
        summary = analysis.summary;
        possibleCauses = analysis.possible_causes;
        source = "groq";
        outputMode = mode;
      } catch (error) {
        console.warn("Groq incident analysis failed:", error.message);
        notice = "Groq could not complete the analysis, so the evidence-based rule summary is shown instead.";
      }
    }
  }

  await db.prepare(
    `UPDATE incidents SET summary_text = ?, summary_source = ?, summary_mode = ?,
     summary_window_minutes = ?, summary_window_end_ts = ?, summary_causes_json = ? WHERE id = ?`
  ).run(
    summary,
    source,
    outputMode,
    source === "groq" ? durationMinutes : null,
    source === "groq" ? analysisWindow.to : null,
    JSON.stringify(possibleCauses),
    row.id
  );
  const latestIncident = await db.prepare("SELECT last_flag_ts FROM incidents WHERE id = ? AND project_id = ?").get(row.id, req.project.id);
  const analysisIsStale = source === "groq" && latestIncident.last_flag_ts > analysisWindow.to;
  res.json({
    summary,
    possible_causes: possibleCauses,
    source,
    mode: outputMode,
    analysis_window: source === "groq" ? analysisWindow : null,
    analysis_is_stale: analysisIsStale,
    metric_counts: metricCounts,
    notice,
    causality: "These are possible contributing factors based on the selected metric window, not proven causes.",
  });
});

router.get("/:id/bookmarks", ownsProject, async (req, res) => {
  const rows = await db
    .prepare("SELECT id, timestamp, note, created_at FROM bookmarks WHERE project_id = ? AND user_id = ? ORDER BY timestamp DESC")
    .all(req.project.id, req.user.id);
  res.json(rows);
});

router.post("/:id/bookmarks", ownsProject, async (req, res) => {
  const parsed = z.object({ timestamp: z.number().int().positive(), note: z.string().trim().max(300).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const now = Date.now();
  const inserted = await db
    .prepare("INSERT INTO bookmarks (project_id, user_id, timestamp, note, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(req.project.id, req.user.id, parsed.data.timestamp, parsed.data.note || null, now);
  const id = inserted.lastInsertRowid;
  res.status(201).json({ id: Number(id), ...parsed.data, created_at: now });
});

router.delete("/:id/bookmarks/:bookmarkId", ownsProject, async (req, res) => {
  const bookmarkId = Number(req.params.bookmarkId);
  if (!Number.isInteger(bookmarkId) || bookmarkId < 1) return res.status(400).json({ error: "Invalid bookmark id" });
  const result = await db
    .prepare("DELETE FROM bookmarks WHERE id = ? AND project_id = ? AND user_id = ?")
    .run(bookmarkId, req.project.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: "Bookmark not found" });
  res.json({ ok: true });
});

// Download one incident as a compact Markdown evidence report.
router.get("/:id/report", ownsProject, async (req, res) => {
  const incidentId = Number(req.query.incident);
  if (!Number.isInteger(incidentId) || incidentId < 1) return res.status(400).json({ error: "incident query param required" });
  const bundle = await getIncidentBundle(req.project.id, incidentId);
  if (!bundle) return res.status(404).json({ error: "Incident not found" });
  const markdownText = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
  const services = bundle.services.join(", ") || "unknown";
  const evidence = bundle.evidence.map((item) => {
    const reading = item.peak_value !== item.value ? `${item.value} (peak ${item.peak_value})` : item.value;
    const source = item.instance && item.instance !== "default" ? `${item.service} (${item.instance})` : item.service;
    return `- ${new Date(item.first_seen_ts).toISOString()}: ${item.metric_label} on ${source} = ${reading}; rule: ${item.rule}`;
  });
  const awsEvidence = bundle.aws_evidence.map((item) => {
    const agentComparison = item.agent_cpu_avg == null
      ? ""
      : `; mapped agent CPU average ${item.agent_cpu_avg}% (${item.agent_sample_count} samples, CloudWatch minus agent ${item.cpu_gap_points} percentage points)`;
    return `- ${new Date(item.timestamp).toISOString()}: AWS CloudWatch ${item.metric_name} on ${item.region}/${item.instance_id} = ${item.value} ${item.unit} (${item.statistic}, ${item.period_seconds}s period)${agentComparison}`;
  });
  const changes = bundle.diff?.changes.map((item) => `- ${item.label}: ${item.before} → ${item.after} (change ${item.delta})`) ?? [];
  const analysisWindow = bundle.analysis_window
    ? `${bundle.analysis_window.duration_minutes} minutes, ${new Date(bundle.analysis_window.from).toISOString()} to ${new Date(bundle.analysis_window.to).toISOString()}`
    : "not available";
  const possibleCauses = bundle.possible_causes.map((item) => {
    const facts = (item.evidence || []).map((fact) => markdownText(fact)).join("; ");
    return `- Possible contributor (${markdownText(item.confidence || "low")} confidence): ${markdownText(item.hypothesis)}${facts ? `; evidence: ${facts}` : ""}`;
  });
  const nearbyNotes = (await db
    .prepare("SELECT timestamp, note FROM bookmarks WHERE project_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp")
    .all(req.project.id, bundle.start_ts - 10 * 60 * 1000, (bundle.end_ts ?? bundle.last_flag_ts) + 10 * 60 * 1000)
  ).filter((item) => item.note);
  const body = [
    `# CloudRewind incident ${bundle.id}`,
    "",
    `- Status: ${bundle.status}`,
    `- Severity: ${bundle.severity}`,
    `- Started: ${new Date(bundle.start_ts).toISOString()}`,
    `- Ended: ${bundle.end_ts ? new Date(bundle.end_ts).toISOString() : "still open"}`,
    `- Services: ${services}`,
    "",
    "## Evidence sequence",
    ...(evidence.length ? evidence : ["- No evidence recorded."]),
    "",
    "## AWS CloudWatch context",
    ...(awsEvidence.length ? awsEvidence : ["- No CloudWatch points were synced for this incident window."]),
    "",
    "## Before-to-incident comparison",
    ...(changes.length ? changes : ["- No comparable snapshots were available."]),
    "",
    "## Nearby deploy event",
    ...(bundle.deploy ? [`- ${new Date(bundle.deploy.timestamp).toISOString()}: ${markdownText(bundle.deploy.description || "Deploy event")}`] : ["- No deploy event was found in the correlation window."]),
    "",
    "## Nearby bookmarked notes",
    ...(nearbyNotes.length ? nearbyNotes.map((item) => `- ${new Date(item.timestamp).toISOString()}: ${markdownText(item.note)}`) : ["- No bookmarked notes in this incident window."]),
    "",
    "## Summary",
    markdownText(bundle.summary_text || "No summary available."),
    "",
    "## AI analysis details",
    `- Source: ${bundle.summary_source === "groq" ? "Groq" : "rule-based"}`,
    `- Mode: ${bundle.summary_mode || "summary"}`,
    `- Selected metric window: ${analysisWindow}`,
    ...(bundle.summary_mode === "likely_cause" ? ["", "## Possible contributing factors", ...(possibleCauses.length ? possibleCauses : ["- No supported possible contributors were returned."])] : []),
    "",
    "Possible contributors are hypotheses based on selected metric evidence. The event order is temporal evidence and does not prove causation.",
  ].join("\n");
  res.type("text/markdown").set("Content-Disposition", `attachment; filename=cloudrewind-incident-${bundle.id}.md`).send(body);
});

// Trigger a repeatable fault in the built-in demo project. Real projects cannot be manipulated this way.
router.post("/:id/simulate-crash", ownsProject, requireWorkspaceRole("owner", "admin"), async (req, res) => {
  if (req.project.is_demo !== 1) return res.status(403).json({ error: "Fault scenarios are available only in demo projects" });
  const parsed = z.object({ type: z.enum(SCENARIOS) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const now = Date.now();
  const activeRun = await db
    .prepare("SELECT ends_at FROM demo_scenarios WHERE project_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(req.project.id);
  if (activeRun && now < activeRun.ends_at + 30_000) {
    return res.status(409).json({ error: `Wait ${Math.ceil((activeRun.ends_at + 30_000 - now) / 1000)} seconds for the current evaluation run to finish.` });
  }
  const result = triggerDemoScenario(req.project.id, parsed.data.type);
  if (!result.ok) return res.status(409).json({ error: result.error });
  const expectedMetric = {
    cpu_spike: "cpu",
    memory_leak: "memory",
    db_flood: "db_connections",
    container_death: "containers",
    bad_deploy: "memory",
    normal_control: "none",
  }[parsed.data.type];
  let deployEventId = null;
  if (parsed.data.type === "bad_deploy") {
    deployEventId = Number((await db.prepare("INSERT INTO events (project_id, timestamp, event_type, description, meta) VALUES (?, ?, 'deploy', ?, ?)")
      .run(req.project.id, Date.now(), "Simulated bad deploy", JSON.stringify({ version: "demo" }))).lastInsertRowid);
  }
  const startedAt = Date.now();
  const insertedScenario = await db.prepare(
    `INSERT INTO demo_scenarios
     (project_id, scenario_type, expected_metric, detector_version, started_at, ends_at, duration_seconds, deploy_event_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.project.id, parsed.data.type, expectedMetric, DETECTOR_VERSION, startedAt, startedAt + result.duration_seconds * 1000, result.duration_seconds, deployEventId, startedAt);
  const scenarioId = Number(insertedScenario.lastInsertRowid);
  res.status(202).json({ ...result, scenario_id: scenarioId });
});

module.exports = router;
