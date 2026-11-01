const express = require("express");
const crypto = require("crypto");
const { z } = require("zod");
const { db } = require("../db");
const { requireAuth } = require("../middleware/requireAuth");
const { requireWorkspace, requireWorkspaceRole } = require("../middleware/requireWorkspace");
const { ownsProject } = require("../middleware/ownsProject");
const { fetchEc2Metrics, LOOKBACK_MS } = require("../awsCloudWatch");
const { createCloudWatchClient } = require("../awsCredentials");

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireWorkspace, ownsProject);
router.use((req, res, next) => {
  if (req.project.is_demo === 1) return res.status(403).json({ error: "AWS CloudWatch is available for real projects, not the simulated demo project" });
  next();
});

const awsConnection = z.object({
  region: z.string().regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/, "Enter a valid AWS region, such as us-east-1"),
  instance_id: z.string().regex(/^i-[0-9a-f]{8}(?:[0-9a-f]{9})?$/, "Enter a valid EC2 instance ID"),
  agent_service: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/, "Agent service may only use letters, numbers, - and _").default("main"),
  agent_instance: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/, "Agent instance may only use letters, numbers, dots, - and _").default("default"),
  role_arn: z.union([
    z.literal(""),
    z.string().regex(/^arn:[a-z0-9-]+:iam::\d{12}:role\/[\w+=,.@/-]+$/, "Enter a valid AWS IAM role ARN"),
  ]).default(""),
});

async function connectionFor(projectId) {
  return db.prepare(
    "SELECT project_id, region, instance_id, agent_service, agent_instance, role_arn, external_id, last_synced_at, last_attempt_at, created_at, updated_at FROM aws_connections WHERE project_id = ?"
  ).get(projectId);
}

router.get("/connection", async (req, res) => {
  const connection = await connectionFor(req.project.id);
  res.json(connection ? { configured: true, ...connection } : { configured: false });
});

router.put("/connection", requireWorkspaceRole("owner", "admin"), async (req, res) => {
  const parsed = awsConnection.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const now = Date.now();
  const { region, instance_id, agent_service, agent_instance, role_arn } = parsed.data;
  const existing = await connectionFor(req.project.id);
  const externalId = existing?.external_id || crypto.randomBytes(32).toString("hex");
  await db.prepare(
    `INSERT INTO aws_connections (project_id, region, instance_id, agent_service, agent_instance, role_arn, external_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET region = excluded.region,
       instance_id = excluded.instance_id,
       agent_service = excluded.agent_service, agent_instance = excluded.agent_instance,
       role_arn = excluded.role_arn, external_id = excluded.external_id,
       last_synced_at = CASE WHEN aws_connections.region != excluded.region OR aws_connections.instance_id != excluded.instance_id OR COALESCE(aws_connections.role_arn, '') != COALESCE(excluded.role_arn, '') THEN NULL ELSE aws_connections.last_synced_at END,
       last_attempt_at = CASE WHEN aws_connections.region != excluded.region OR aws_connections.instance_id != excluded.instance_id OR COALESCE(aws_connections.role_arn, '') != COALESCE(excluded.role_arn, '') THEN NULL ELSE aws_connections.last_attempt_at END,
       updated_at = excluded.updated_at`
  ).run(req.project.id, region, instance_id, agent_service, agent_instance, role_arn || null, externalId, now, now);

  res.json({ configured: true, ...await connectionFor(req.project.id) });
});

router.delete("/connection", requireWorkspaceRole("owner", "admin"), async (req, res) => {
  await db.prepare("DELETE FROM aws_connections WHERE project_id = ?").run(req.project.id);
  res.json({ ok: true });
});

router.get("/metrics", async (req, res) => {
  const connection = await connectionFor(req.project.id);
  if (!connection) return res.status(409).json({ error: "Connect an EC2 instance first" });

  const from = req.query.from === undefined ? Date.now() - LOOKBACK_MS : Number(req.query.from);
  const to = req.query.to === undefined ? Date.now() : Number(req.query.to);
  if (!Number.isFinite(from) || from <= 0) return res.status(400).json({ error: "from must be a time in milliseconds" });
  if (!Number.isFinite(to) || to <= 0) return res.status(400).json({ error: "to must be a time in milliseconds" });
  if (from >= to) return res.status(400).json({ error: "from must be before to" });

  const points = await db.prepare(
    `SELECT metric_name, timestamp, value, unit, statistic, period_seconds, fetched_at
     FROM aws_metric_points
     WHERE project_id = ? AND region = ? AND instance_id = ? AND timestamp >= ? AND timestamp <= ?
     ORDER BY timestamp, metric_name LIMIT 2000`
  ).all(req.project.id, connection.region, connection.instance_id, from, to);
  res.json({ source: "aws_cloudwatch", region: connection.region, instance_id: connection.instance_id, points });
});

router.post("/sync", requireWorkspaceRole("owner", "admin"), async (req, res) => {
  const connection = await connectionFor(req.project.id);
  if (!connection) return res.status(409).json({ error: "Connect an EC2 instance first" });

  const attemptAt = Date.now();
  if (connection.last_attempt_at && attemptAt - connection.last_attempt_at < 60_000) {
    const waitSeconds = Math.ceil((60_000 - (attemptAt - connection.last_attempt_at)) / 1000);
    return res.status(429).json({ error: `Please wait ${waitSeconds} seconds before syncing again` });
  }

  // Claim the one-minute sync slot atomically so two parallel requests cannot
  // both pass the throttle and make duplicate CloudWatch calls.
  const claim = await db.prepare(
    "UPDATE aws_connections SET last_attempt_at = ? WHERE project_id = ? AND (last_attempt_at IS NULL OR last_attempt_at <= ?)"
  ).run(attemptAt, req.project.id, attemptAt - 60_000);
  if (!claim.changes) {
    const latest = await connectionFor(req.project.id);
    const elapsed = Date.now() - (latest?.last_attempt_at ?? attemptAt);
    const waitSeconds = Math.max(1, Math.ceil((60_000 - elapsed) / 1000));
    return res.status(429).json({ error: `Please wait ${waitSeconds} seconds before syncing again` });
  }

  let result;
  try {
    // The SDK uses its standard credential chain: a local AWS profile or the
    // backend's attached IAM role. No AWS access keys are accepted or stored here.
    const client = await createCloudWatchClient(connection);
    result = await fetchEc2Metrics({ client, instanceId: connection.instance_id });
  } catch (error) {
    const name = error?.name || error?.Code || "";
    const cause = error?.cause;
    const details = `${name} ${error?.message || ""} ${cause?.name || ""} ${cause?.Code || ""} ${cause?.message || ""}`;
    if (/CredentialsProviderError|CredentialProviderError|Could not load credentials/i.test(details)) {
      return res.status(424).json({ error: "AWS credentials are not available to the CloudRewind backend. Configure an AWS profile or an IAM role for the backend process." });
    }
    if (/ExpiredToken|InvalidClientTokenId/i.test(details)) {
      return res.status(401).json({ error: "The AWS credentials have expired or are invalid. Refresh the backend identity or check the assumed role, then try again." });
    }
    if (/AccessDenied|UnauthorizedOperation/i.test(details)) {
      return res.status(403).json({ error: connection.role_arn
        ? "The assumed AWS role needs read access for CloudWatch GetMetricStatistics."
        : "The backend AWS identity needs read access for CloudWatch GetMetricStatistics." });
    }
    if (name === "AssumeRoleFailure") {
      return res.status(403).json({ error: "Could not assume the customer AWS role. Check its trust policy, External ID, and the backend identity's sts:AssumeRole permission." });
    }
    console.error("CloudWatch sync failed:", name || "AWS error");
    return res.status(502).json({ error: "CloudWatch could not return metrics for this instance and region. Check that the instance is in that region and try again." });
  }

  const fetchedAt = Date.now();
  try {
    const save = db.transaction(async (transactionDb, points) => {
      const insert = transactionDb.prepare(
        `INSERT INTO aws_metric_points
         (project_id, region, instance_id, metric_name, timestamp, value, unit, statistic, period_seconds, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, region, instance_id, metric_name, timestamp) DO UPDATE SET
           region = excluded.region, value = excluded.value, unit = excluded.unit,
           statistic = excluded.statistic, period_seconds = excluded.period_seconds, fetched_at = excluded.fetched_at`
      );
      for (const point of points) {
        await insert.run(req.project.id, connection.region, connection.instance_id, point.metric_name,
          point.timestamp, point.value, point.unit, point.statistic, point.period_seconds, fetchedAt);
      }
      await transactionDb.prepare("UPDATE aws_connections SET last_synced_at = ?, updated_at = ? WHERE project_id = ?")
        .run(fetchedAt, fetchedAt, req.project.id);
    });
    await save(result.points);
  } catch (error) {
    console.error("CloudWatch points could not be stored:", error?.code || error?.message || "database error");
    return res.status(503).json({ error: "CloudWatch returned metrics, but CloudRewind could not save them. Check database health and retry after the sync cooldown." });
  }

  res.json({
    source: "aws_cloudwatch",
    instance_id: connection.instance_id,
    region: connection.region,
    points_saved: result.points.length,
    from: result.start_time,
    to: result.end_time,
    fetched_at: fetchedAt,
    period_seconds: 300,
  });
});

module.exports = router;
