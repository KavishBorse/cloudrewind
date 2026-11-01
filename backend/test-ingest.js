// Quick tester for POST /ingest.
// Usage:  node test-ingest.js <API_KEY> <ok|wrongkey|bad|flood>
const [key, mode = "ok"] = process.argv.slice(2);
const URL = process.env.INGEST_URL || "http://localhost:5000/ingest";

if (!key) {
  console.log("Usage: node test-ingest.js <API_KEY> <ok|wrongkey|bad|flood>");
  process.exit(1);
}

async function send(body, apiKey = key) {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const good = () => ({
  service: "main",
  cpu: Math.round(Math.random() * 400) / 10 + 20,
  memory: Math.round(Math.random() * 300) / 10 + 40,
  containers: 3,
  db_connections: Math.round(Math.random() * 10) + 10,
  network: Math.round(Math.random() * 400) + 300,
});

async function main() {
  if (mode === "ok") {
    const r = await send(good());
    console.log(`Expected 201 ->`, r.status, r.text);
  } else if (mode === "wrongkey") {
    const r = await send(good(), "cr_thisisawrongkey");
    console.log(`Expected 401 ->`, r.status, r.text);
  } else if (mode === "bad") {
    const cases = [
      ["cpu is 150", { ...good(), cpu: 150 }],
      ["cpu is text", { ...good(), cpu: "high" }],
      ["memory missing", { ...good(), memory: undefined }],
      ["containers is 3.5", { ...good(), containers: 3.5 }],
      ["extra field", { ...good(), secret: "x" }],
      ["timestamp in the future", { ...good(), timestamp: Date.now() + 3600_000 }],
      ["timestamp 2 days old", { ...good(), timestamp: Date.now() - 2 * 86400_000 }],
      ["bad service name", { ...good(), service: "my service!" }],
    ];
    for (const [label, body] of cases) {
      const r = await send(body);
      console.log(`Expected 400 | ${label.padEnd(24)} ->`, r.status, r.text);
      await new Promise((resolve) => setTimeout(resolve, 1100)); // stay under the rate limit
    }
  } else if (mode === "flood") {
    const results = [];
    for (let i = 0; i < 15; i++) results.push((await send(good())).status);
    console.log("15 quick requests ->", results.join(" "));
    console.log("Expected: 201 until the limit (10 per 10 seconds) is used up, then 429.");
    console.log("Tip: wait 10 seconds before running this, so earlier tests do not use up the limit.");
  } else {
    console.log("Unknown mode. Use ok, wrongkey, bad or flood.");
  }
}

main().catch((err) => console.log("Could not reach the backend:", err.message));
