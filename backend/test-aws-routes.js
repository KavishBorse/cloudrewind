const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  const port = await freePort();
  const dbFile = path.join(os.tmpdir(), `cloudrewind-aws-route-test-${process.pid}-${Date.now()}.db`);
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    PORT: String(port),
    JWT_SECRET: "aws-route-test-secret-not-for-production",
    GROQ_API_KEY: "",
    CLOUDREWIND_DB_PATH: dbFile,
    CORS_ORIGINS: "http://localhost:5173",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_SHARED_CREDENTIALS_FILE: path.join(os.tmpdir(), `cloudrewind-no-aws-${process.pid}`),
    AWS_CONFIG_FILE: path.join(os.tmpdir(), `cloudrewind-no-aws-config-${process.pid}`),
  };
  const child = spawn(process.execPath, ["server.js"], { cwd: __dirname, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });

  try {
    let healthy = false;
    let lastError = "no response";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode != null) throw new Error(`Backend exited early: ${stdout} ${stderr}`);
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) { healthy = true; break; }
        lastError = `HTTP ${response.status}`;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        lastError = `${error.message}${error.cause?.code ? ` (${error.cause.code}: ${error.cause.message})` : ""}`;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(healthy, `Backend did not become healthy on ${baseUrl}: ${lastError}; ${stdout} ${stderr}`);
    const readiness = await fetch(`${baseUrl}/ready`);
    assert.equal(readiness.status, 200, "readiness also confirms the configured database responds");
    assert.deepEqual(await readiness.json(), { status: "ready", database: "sqlite" });

    const signup = await fetch(`${baseUrl}/auth/signup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: "Route Test", organization_name: "CloudRewind QA", email: `aws-test-${process.pid}@example.test`, password: "test-password-123" }),
    });
    assert.equal(signup.status, 201);
    const signupData = await signup.json();
    const { token } = signupData;
    assert.equal(signupData.user.full_name, "Route Test");
    assert.equal(signupData.user.organization_name, "CloudRewind QA");
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const profile = await fetch(`${baseUrl}/auth/me`, { headers: auth });
    assert.equal(profile.status, 200);
    assert.equal((await profile.json()).user.full_name, "Route Test", "account profile details are available to the signed-in account");

    const workspacesResponse = await fetch(baseUrl + "/workspaces", { headers: auth });
    assert.equal(workspacesResponse.status, 200);
    const workspaces = await workspacesResponse.json();
    assert.equal(workspaces.length, 1, "signup creates one default workspace");
    assert.equal(workspaces[0].role, "owner");
    assert.equal(workspaces[0].member_count, 1);
    const ownerWorkspaceId = workspaces[0].id;

    const projects = await fetch(`${baseUrl}/projects`, { headers: auth });
    assert.deepEqual(await projects.json(), [], "new accounts start with a clean workspace and no simulated telemetry");
    const createSample = await fetch(`${baseUrl}/projects/demo`, { method: "POST", headers: auth });
    assert.equal(createSample.status, 201, "a user can opt into an isolated sample project");
    const demoProject = (await createSample.json()).project;
    assert.equal(demoProject.is_demo, 1);
    const duplicateSample = await fetch(`${baseUrl}/projects/demo`, { method: "POST", headers: auth });
    assert.equal(duplicateSample.status, 409, "a workspace can have at most one sample project");
    const demoConnection = await fetch(`${baseUrl}/projects/${demoProject.id}/aws/connection`, {
      method: "PUT", headers: auth, body: JSON.stringify({ region: "us-east-1", instance_id: "i-0123456789abcdef0" }),
    });
    assert.equal(demoConnection.status, 403, "AWS integration stays out of the synthetic demo project");

    const createProject = await fetch(`${baseUrl}/projects`, {
      method: "POST", headers: auth, body: JSON.stringify({ name: "AWS integration test", environment: "staging" }),
    });
    assert.equal(createProject.status, 201);
    const { project, apiKey } = await createProject.json();
    assert.equal(project.environment, "staging", "a monitored project stores its environment separately");
    const endpoint = `${baseUrl}/projects/${project.id}/aws`;

    const invalid = await fetch(`${endpoint}/connection`, {
      method: "PUT", headers: auth, body: JSON.stringify({ region: "not-a-region", instance_id: "i-0123456789abcdef0" }),
    });
    assert.equal(invalid.status, 400, "invalid AWS region is rejected");

    const invalidMapping = await fetch(`${endpoint}/connection`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ region: "us-east-1", instance_id: "i-0123456789abcdef0", agent_service: "bad service", agent_instance: "host-1" }),
    });
    assert.equal(invalidMapping.status, 400, "invalid agent mapping identifiers are rejected");

    const invalidRole = await fetch(`${endpoint}/connection`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ region: "us-east-1", instance_id: "i-0123456789abcdef0", role_arn: "not-an-arn" }),
    });
    assert.equal(invalidRole.status, 400, "invalid AWS role ARNs are rejected");

    const save = await fetch(`${endpoint}/connection`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ region: "us-east-1", instance_id: "i-0123456789abcdef0", agent_service: "api", agent_instance: "host-1", role_arn: "arn:aws:iam::123456789012:role/CloudRewindReadOnly" }),
    });
    assert.equal(save.status, 200, "project owner can save an EC2 target");
    const savedConnection = await save.json();
    assert.equal(savedConnection.configured, true);
    assert.equal(savedConnection.agent_service, "api");
    assert.equal(savedConnection.agent_instance, "host-1");
    assert.equal(savedConnection.role_arn, "arn:aws:iam::123456789012:role/CloudRewindReadOnly");
    assert.match(savedConnection.external_id, /^[a-f0-9]{64}$/, "a unique external ID is generated for role trust configuration");

    const update = await fetch(`${endpoint}/connection`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ region: "us-east-1", instance_id: "i-0123456789abcdef0", agent_service: "api", agent_instance: "host-2", role_arn: savedConnection.role_arn }),
    });
    assert.equal(update.status, 200);
    assert.equal((await update.json()).external_id, savedConnection.external_id, "updating an agent mapping preserves the role's external ID");

    const metrics = await fetch(`${endpoint}/metrics`, { headers: auth });
    assert.equal(metrics.status, 200);
    const metricResponse = await metrics.json();
    assert.equal(metricResponse.source, "aws_cloudwatch");
    assert.deepEqual(metricResponse.points, []);

    const syncResponses = await Promise.all([0, 1].map(() => fetch(`${endpoint}/sync`, { method: "POST", headers: auth })));
    const syncStatuses = syncResponses.map((response) => response.status).sort((a, b) => a - b);
    assert.deepEqual(syncStatuses, [424, 429], "parallel sync requests claim one slot; the other fails only because this test has no AWS credentials");

    const event = await fetch(baseUrl + "/events", {
      method: "POST", headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ event_type: "deploy", description: "route-test deploy", meta: { version: "test" } }),
    });
    assert.equal(event.status, 201, "agent API key can record a deploy event");

    const ingest = await fetch(baseUrl + "/ingest", {
      method: "POST", headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ service: "api", instance: "host-1", cpu: 95, memory: 55, containers: 3, db_connections: 12, network: 320 }),
    });
    assert.equal(ingest.status, 201, "real-project telemetry is accepted from the agent API");

    const streamsResponse = await fetch(baseUrl + "/projects/" + project.id + "/services", { headers: auth });
    assert.equal(streamsResponse.status, 200);
    const streams = await streamsResponse.json();
    assert.equal(streams.length, 1);
    assert.equal(streams[0].service, "api");
    assert.equal(streams[0].instance, "host-1");
    assert.ok(Number.isFinite(streams[0].last_seen_at));

    const incidentsResponse = await fetch(baseUrl + "/projects/" + project.id + "/incidents", { headers: auth });
    assert.equal(incidentsResponse.status, 200);
    const incidents = await incidentsResponse.json();
    assert.equal(incidents.length, 1, "critical agent reading opens an incident");
    assert.equal(incidents[0].severity, "critical");
    assert.equal(incidents[0].evidence[0].instance, "host-1");

    const bundleResponse = await fetch(baseUrl + "/projects/" + project.id + "/incidents/" + incidents[0].id, { headers: auth });
    assert.equal(bundleResponse.status, 200);
    const bundle = await bundleResponse.json();
    assert.equal(bundle.deploy?.description, "route-test deploy", "incident context associates the nearby deploy event");
    assert.equal(bundle.aws_evidence.length, 0, "unsynced CloudWatch data remains separate and is not fabricated");

    const narrativeStatus = await fetch(`${baseUrl}/projects/${project.id}/narrative-status`, { headers: auth });
    assert.deepEqual(await narrativeStatus.json(), { groq_available: false }, "the route reports Groq unavailable when no backend key is configured");
    const noConsent = await fetch(`${baseUrl}/projects/${project.id}/incidents/${incidents[0].id}/narrative`, {
      method: "POST", headers: auth, body: JSON.stringify({ provider: "groq", mode: "summary", durationMinutes: 60 }),
    });
    assert.equal(noConsent.status, 400, "the API requires explicit consent before any Groq request");
    const invalidWindow = await fetch(`${baseUrl}/projects/${project.id}/incidents/${incidents[0].id}/narrative`, {
      method: "POST", headers: auth, body: JSON.stringify({ provider: "groq", mode: "summary", durationMinutes: 5, consentToGroq: true }),
    });
    assert.equal(invalidWindow.status, 400, "the API rejects lookback windows below the 15-minute minimum");
    const localFallback = await fetch(`${baseUrl}/projects/${project.id}/incidents/${incidents[0].id}/narrative`, {
      method: "POST", headers: auth, body: JSON.stringify({ provider: "groq", mode: "likely_cause", durationMinutes: 60, consentToGroq: true }),
    });
    assert.equal(localFallback.status, 200);
    const fallbackBody = await localFallback.json();
    assert.equal(fallbackBody.source, "rule-based", "no API key falls back locally without contacting Groq");
    assert.equal(fallbackBody.metric_counts.agent, 1, "the selected lookback reads the project telemetry in that window");
    assert.equal(fallbackBody.analysis_window, null, "a local fallback is not mislabeled as a Groq analysis");
    assert.match(fallbackBody.notice, /not configured/);

    const report = await fetch(baseUrl + "/projects/" + project.id + "/report?incident=" + incidents[0].id, { headers: auth });
    assert.equal(report.status, 200);
    const reportText = await report.text();
    assert.match(reportText, /Evidence sequence/);
    assert.match(reportText, /route-test deploy/);

    const remove = await fetch(`${endpoint}/connection`, { method: "DELETE", headers: auth });
    assert.equal(remove.status, 200);
    assert.equal((await remove.json()).ok, true);

    const inviteResponse = await fetch(baseUrl + "/workspaces/invitations", {
      method: "POST", headers: auth,
      body: JSON.stringify({ email: "teammate-" + process.pid + "@example.test", role: "member" }),
    });
    assert.equal(inviteResponse.status, 201, "workspace owners can create an email-bound invite");
    const invite = await inviteResponse.json();
    const inviteToken = new URL(invite.invite_url).pathname.split("/").pop();
    const wrongEmailPreview = await fetch(baseUrl + "/workspaces/invitations/" + inviteToken, { headers: auth });
    assert.equal(wrongEmailPreview.status, 404, "the invite does not reveal workspace details to another account");

    const teammateSignup = await fetch(baseUrl + "/auth/signup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_name: "Workspace Teammate", organization_name: "Separate Team",
        email: invite.email, password: "team-test-password-123",
      }),
    });
    assert.equal(teammateSignup.status, 201);
    const teammateAuth = { Authorization: "Bearer " + (await teammateSignup.json()).token, "Content-Type": "application/json" };
    const isolatedAccess = await fetch(baseUrl + "/projects/" + project.id, {
      headers: { ...teammateAuth, "X-Workspace-Id": String(ownerWorkspaceId) },
    });
    assert.equal(isolatedAccess.status, 403, "an unrelated account cannot select another workspace");
    const invitePreview = await fetch(baseUrl + "/workspaces/invitations/" + inviteToken, { headers: teammateAuth });
    assert.equal(invitePreview.status, 200, "only the invited account can inspect the invite");
    const accepted = await fetch(baseUrl + "/workspaces/invitations/" + inviteToken + "/accept", { method: "POST", headers: teammateAuth });
    assert.equal(accepted.status, 200);

    const teammateWorkspacesResponse = await fetch(baseUrl + "/workspaces", { headers: teammateAuth });
    const teammateWorkspaces = await teammateWorkspacesResponse.json();
    assert.equal(teammateWorkspaces.length, 2, "accepting an invite adds the shared workspace without removing the teammate's own");
    const sharedWorkspace = teammateWorkspaces.find((workspace) => workspace.id === ownerWorkspaceId);
    assert.equal(sharedWorkspace.role, "member");
    const sharedHeaders = { ...teammateAuth, "X-Workspace-Id": String(ownerWorkspaceId) };
    const sharedProjects = await fetch(baseUrl + "/projects", { headers: sharedHeaders });
    assert.equal(sharedProjects.status, 200);
    assert.ok((await sharedProjects.json()).some((item) => item.id === project.id), "members can view projects shared with their workspace");
    const forbiddenCreate = await fetch(baseUrl + "/projects", {
      method: "POST", headers: sharedHeaders, body: JSON.stringify({ name: "Member-created project" }),
    });
    assert.equal(forbiddenCreate.status, 403, "members cannot create workspace projects");

    const membersResponse = await fetch(baseUrl + "/workspaces/members", { headers: { ...auth, "X-Workspace-Id": String(ownerWorkspaceId) } });
    const members = await membersResponse.json();
    const teammate = members.find((member) => member.email === invite.email);
    assert.ok(teammate, "owner can see the accepted member");
    const removeTeammate = await fetch(baseUrl + "/workspaces/members/" + teammate.id, {
      method: "DELETE", headers: { ...auth, "X-Workspace-Id": String(ownerWorkspaceId) },
    });
    assert.equal(removeTeammate.status, 200);
    const afterRemoval = await fetch(baseUrl + "/projects/" + project.id, { headers: sharedHeaders });
    assert.equal(afterRemoval.status, 403, "removed members immediately lose workspace access");

    console.log("Platform onboarding, AWS, and Groq narrative route checks passed (isolated temporary DB; no external AI or AWS calls made).");
  } finally {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbFile + suffix, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
