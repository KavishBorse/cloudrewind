process.env.JWT_SECRET ||= "local-groq-test-secret";

const assert = require("node:assert/strict");
const { compactMetricsWindow, generateGroqAnalysis } = require("./groqNarrative");

const incident = { severity: "critical", trigger_metric: "cpu", start_ts: 1_800_000_000_000, last_flag_ts: 1_800_000_060_000 };
const window = { start: 1_800_000_000_000, end: 1_800_000_060_000, durationMinutes: 1 };
const agentReadings = [{
  id: 999,
  project_id: 55,
  service: "private-api-name",
  instance: "private-hostname",
  timestamp: 1_800_000_030_000,
  cpu: 97,
  cpu_max: 99,
  memory: 71,
  response_ms: 430,
  sample_count: 3,
}];
const awsReadings = [{
  instance_id: "i-private-id",
  metric_name: "CPUUtilization",
  value: 92,
  unit: "Percent",
  region: "us-east-1",
  timestamp: 1_800_000_030_000,
  period_seconds: 300,
  statistic: "Average",
}];

async function main() {
  const compact = compactMetricsWindow({ incident, window, agentReadings, awsReadings });
  const compactText = JSON.stringify(compact.payload);
  assert.equal(compact.payload.agent_metrics[0].service, "service-1");
  assert.equal(compact.payload.agent_metrics[0].instance, "instance-1");
  assert.equal(compact.payload.aws_cloudwatch_metrics[0].metric, "CPUUtilization");
  assert.ok(!compactText.includes("private-api-name"));
  assert.ok(!compactText.includes("private-hostname"));
  assert.ok(!compactText.includes("i-private-id"));
  assert.ok(!compactText.includes("project_id"));

  let requestUrl;
  let requestOptions;
  const responseText = JSON.stringify({
    summary: "CPU stayed near saturation while the incident was active. CloudWatch CPU was also elevated during the same selected window.",
    possible_causes: [{
      hypothesis: "Sustained compute pressure may have contributed to the incident.",
      evidence_refs: ["agent-1", "aws-1", "not-a-real-reading"],
      confidence: "moderate",
    }, {
      hypothesis: "This unsupported item should be removed.",
      evidence_refs: ["not-a-real-reading"],
      confidence: "high",
    }],
  });

  const result = await generateGroqAnalysis({
    incident,
    window,
    agentReadings,
    awsReadings,
    mode: "likely_cause",
    apiKey: "mock-api-key",
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestOptions = options;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: responseText } }] }) };
    },
  });

  assert.equal(requestUrl, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(requestOptions.headers.Authorization, "Bearer mock-api-key");
  assert.equal(result.possible_causes.length, 1);
  assert.deepEqual(result.possible_causes[0].evidence, [compact.references["agent-1"], compact.references["aws-1"]]);
  assert.equal(result.possible_causes[0].confidence, "moderate");
  assert.ok(!JSON.stringify(JSON.parse(requestOptions.body)).includes("private-hostname"));

  console.log("Groq narrative tests passed (mocked provider; no external request made).");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
