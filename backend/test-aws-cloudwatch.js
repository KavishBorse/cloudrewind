const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { fetchEc2Metrics, EC2_METRICS, PERIOD_SECONDS } = require("./awsCloudWatch");
const { AssumeRoleCommand } = require("@aws-sdk/client-sts");
const { assumeRoleCredentials, createCloudWatchClient } = require("./awsCredentials");
const { runMigrations } = require("./migrate");
const { getIncidentBundle } = require("./incidentService");

async function verifyAwsStorage() {
  const db = new Database(":memory:");
  runMigrations(db);
  const now = Date.now();
  db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES ('aws-test@example.test', 'x', ?)").run(now);
  db.prepare("INSERT INTO projects (user_id, name, api_key_hash, api_key_prefix, created_at) VALUES (1, 'AWS test', 'h', 'cr_test', ?)").run(now);
  db.prepare("INSERT INTO aws_connections (project_id, region, instance_id, agent_service, agent_instance, created_at, updated_at) VALUES (1, 'us-east-1', 'i-0123456789abcdef0', 'api', 'host-1', ?, ?)").run(now, now);
  const save = db.prepare(
    `INSERT INTO aws_metric_points
       (project_id, region, instance_id, metric_name, timestamp, value, unit, statistic, period_seconds, fetched_at)
     VALUES (1, 'us-east-1', 'i-0123456789abcdef0', 'CPUUtilization', ?, ?, 'Percent', 'Average', 300, ?)
     ON CONFLICT(project_id, region, instance_id, metric_name, timestamp) DO UPDATE SET value = excluded.value`
  );
  save.run(now, 10, now);
  save.run(now, 20, now + 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM aws_metric_points").get().n, 1, "re-sync replaces a point instead of duplicating it");
  assert.equal(db.prepare("SELECT value FROM aws_metric_points").get().value, 20);

  const addSnapshot = db.prepare("INSERT INTO snapshots (project_id, service, instance, timestamp, cpu, memory) VALUES (1, 'api', 'host-1', ?, ?, 50)");
  addSnapshot.run(now, 10);
  addSnapshot.run(now + 1000, 20);
  const incidentId = Number(db.prepare(
    `INSERT INTO incidents (project_id, start_ts, last_flag_ts, trigger_metric, services, evidence_json, created_at)
     VALUES (1, ?, ?, 'cpu', '["api@host-1"]', ?, ?)`
  ).run(now, now + 1000, JSON.stringify([{
    metric: "cpu", metric_label: "CPU", service: "api", instance: "host-1",
    value: 90, peak_value: 90, first_seen_ts: now, peak_seen_ts: now, rule: "cpu_at_or_above_90",
  }]), now).lastInsertRowid);
  const bundle = await getIncidentBundle(1, incidentId, { database: db });
  assert.equal(bundle.aws_evidence.length, 1, "incident detail includes nearby CloudWatch samples");
  assert.equal(bundle.aws_evidence[0].agent_cpu_avg, 15, "CloudWatch CPU is compared with the mapped agent stream in the same period");
  assert.equal(bundle.aws_evidence[0].cpu_gap_points, 5);
  db.close();
}

function verifyExistingConnectionMigration() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE aws_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL UNIQUE,
    region TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    last_synced_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  runMigrations(db);
  const columns = db.prepare("PRAGMA table_info(aws_connections)").all().map((column) => column.name);
  assert.ok(columns.includes("agent_service"), "existing AWS connections gain an agent service mapping");
  assert.ok(columns.includes("agent_instance"), "existing AWS connections gain an agent instance mapping");
  assert.ok(columns.includes("role_arn"), "existing AWS connections gain an optional IAM role ARN");
  assert.ok(columns.includes("external_id"), "existing AWS connections gain a generated external ID");
  assert.ok(columns.includes("last_attempt_at"), "existing AWS connections gain sync throttling state");
  db.close();
}

function verifyAccountAndEnvironmentMigration() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    api_key_hash TEXT NOT NULL,
    api_key_prefix TEXT NOT NULL,
    db_max_connections INTEGER DEFAULT 100,
    is_demo INTEGER DEFAULT 0,
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL
  );`);
  const now = Date.now();
  const userId = db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES ('workspace-migration@example.test', 'x', ?)").run(now).lastInsertRowid;
  const projectId = db.prepare(
    "INSERT INTO projects (user_id, name, api_key_hash, api_key_prefix, created_at) VALUES (?, 'Existing app', 'hash', 'cr_old', ?)"
  ).run(userId, now).lastInsertRowid;
  runMigrations(db);
  const userColumns = db.prepare("PRAGMA table_info(users)").all().map((column) => column.name);
  const projectColumns = db.prepare("PRAGMA table_info(projects)").all().map((column) => column.name);
  assert.ok(userColumns.includes("full_name"), "existing accounts gain a full name field");
  assert.ok(userColumns.includes("organization_name"), "existing accounts gain an optional organization field");
  assert.ok(projectColumns.includes("environment"), "existing monitored projects gain an environment field");
  assert.ok(projectColumns.includes("workspace_id"), "existing projects gain a workspace link");
  const project = db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(projectId);
  const membership = db.prepare("SELECT role FROM workspace_members WHERE user_id = ?").get(userId);
  assert.ok(project.workspace_id, "existing projects are assigned to their account's workspace");
  assert.equal(membership.role, "owner", "existing accounts become owners of their migrated workspace");
  db.close();
}

async function verifyAssumeRole() {
  let assumeInput;
  const stsClient = {
    async send(command) {
      assert.ok(command instanceof AssumeRoleCommand, "STS adapter sends AssumeRole");
      assumeInput = command.input;
      return { Credentials: {
        AccessKeyId: "temporary-access-key",
        SecretAccessKey: "temporary-secret-key",
        SessionToken: "temporary-session-token",
        Expiration: new Date("2026-10-25T10:30:00.000Z"),
      } };
    },
  };
  const roleArn = "arn:aws:iam::123456789012:role/CloudRewindReadOnly";
  const externalId = "project-specific-external-id";
  const expectedCredentials = {
    accessKeyId: "temporary-access-key",
    secretAccessKey: "temporary-secret-key",
    sessionToken: "temporary-session-token",
    expiration: new Date("2026-10-25T10:30:00.000Z"),
  };
  const credentials = await assumeRoleCredentials({
    region: "us-east-1", roleArn, externalId, projectId: 42, client: stsClient,
  });
  assert.deepEqual(assumeInput, {
    RoleArn: roleArn,
    RoleSessionName: "CloudRewind-42",
    ExternalId: externalId,
    DurationSeconds: 900,
  });
  assert.deepEqual(credentials, expectedCredentials, "temporary STS credentials are mapped to the SDK provider shape");

  let options;
  const assumedClient = await createCloudWatchClient({
    project_id: 42, region: "us-east-1", role_arn: roleArn, external_id: externalId,
  }, { stsClient, cloudWatchClientFactory: (value) => { options = value; return { kind: "cloudwatch" }; } });
  assert.deepEqual(options, { region: "us-east-1", credentials: expectedCredentials });
  assert.equal(assumedClient.kind, "cloudwatch");

  await createCloudWatchClient({ region: "us-east-1", role_arn: null }, {
    cloudWatchClientFactory: (value) => { options = value; return {}; },
  });
  assert.deepEqual(options, { region: "us-east-1" }, "direct mode leaves credentials to the AWS SDK's default chain");
}

async function main() {
  const fixedNow = Date.parse("2026-10-25T10:17:47.000Z");
  const calls = [];
  const fakeClient = {
    async send(command) {
      const input = command.input;
      calls.push(input);
      const metric = EC2_METRICS.find((item) => item.name === input.MetricName);
      const value = {
        CPUUtilization: 31.5,
        NetworkIn: 1_500_000,
        NetworkOut: 600_000,
        StatusCheckFailed: 0,
      }[input.MetricName];
      return {
        Datapoints: [
          { Timestamp: new Date("2026-10-25T10:10:00.000Z"), [metric.statistic]: value },
          { Timestamp: new Date("2026-10-25T10:05:00.000Z"), [metric.statistic]: value - 1 },
          { Timestamp: new Date("2026-10-25T10:15:00.000Z"), [metric.statistic]: null },
        ],
      };
    },
  };

  const result = await fetchEc2Metrics({ client: fakeClient, instanceId: "i-0123456789abcdef0", now: fixedNow });
  assert.equal(calls.length, 4, "one read request is made for each selected EC2 metric");
  assert.equal(result.points.length, 8, "null measurements are skipped");
  assert.equal(result.points[0].timestamp, Date.parse("2026-10-25T10:05:00.000Z"), "points are sorted chronologically");
  assert.equal(result.start_time, Date.parse("2026-10-25T04:15:00.000Z"));
  assert.equal(result.end_time, Date.parse("2026-10-25T10:15:00.000Z"));
  assert.ok(calls.every((input) => input.Namespace === "AWS/EC2"));
  assert.ok(calls.every((input) => input.Period === PERIOD_SECONDS));
  assert.ok(calls.every((input) => input.Dimensions[0].Value === "i-0123456789abcdef0"));
  assert.deepEqual(calls.map((input) => input.MetricName).sort(), EC2_METRICS.map((item) => item.name).sort());
  await verifyAwsStorage();
  verifyExistingConnectionMigration();
  verifyAccountAndEnvironmentMigration();
  await verifyAssumeRole();
  console.log("AWS CloudWatch adapter checks passed (mock client; no AWS account was contacted).");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
