// Quick tester for POST /events.
// Usage:  node test-events.js <API_KEY> <ok|wrongkey|bad|flood>
const [key, mode = "ok"] = process.argv.slice(2);
const URL = process.env.EVENTS_URL || "http://localhost:5000/events";

if (!key) {
  console.log("Usage: node test-events.js <API_KEY> <ok|wrongkey|bad|flood>");
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

async function main() {
  if (mode === "ok") {
    const r = await send({ event_type: "deploy", description: "test deploy v1.0", meta: { version: "v1.0" } });
    console.log("Expected 201 ->", r.status, r.text);
  } else if (mode === "wrongkey") {
    const r = await send({ event_type: "deploy" }, "cr_thisisawrongkey");
    console.log("Expected 401 ->", r.status, r.text);
  } else if (mode === "bad") {
    const cases = [
      ["unknown event_type", { event_type: "party" }],
      ["event_type missing", { description: "x" }],
      ["extra field", { event_type: "deploy", secret: "x" }],
      ["description too long", { event_type: "deploy", description: "x".repeat(201) }],
      ["meta value is an object", { event_type: "deploy", meta: { a: { b: 1 } } }],
      ["meta has 11 keys", { event_type: "deploy", meta: Object.fromEntries(Array.from({ length: 11 }, (_, i) => ["k" + i, i])) }],
      ["timestamp in the future", { event_type: "deploy", timestamp: Date.now() + 3600_000 }],
      ["timestamp 8 days old", { event_type: "deploy", timestamp: Date.now() - 8 * 86400_000 }],
    ];
    for (const [label, body] of cases) {
      const r = await send(body);
      console.log(`Expected 400 | ${label.padEnd(26)} ->`, r.status, r.text);
    }
  } else if (mode === "flood") {
    const results = [];
    for (let i = 0; i < 25; i++) results.push((await send({ event_type: "restart", description: "flood test" })).status);
    console.log("25 quick events ->", results.join(" "));
    console.log("Expected: 201 until the limit (20 per minute) is used up, then 429.");
    console.log("Note: this adds 20 restart events to the project. Use a test project.");
  } else {
    console.log("Unknown mode. Use ok, wrongkey, bad or flood.");
  }
}

main().catch((err) => console.log("Could not reach the backend:", err.message));