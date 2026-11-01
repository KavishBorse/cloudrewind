#!/usr/bin/env node
// CloudRewind agent v1
// Reads this machine's CPU and memory (and network on Linux) every few seconds
// and sends them to your CloudRewind project. Nothing else is read or sent.
// It only makes outbound requests. It opens no ports and accepts no commands.

const os = require("os");
const fs = require("fs");

const VERSION = "1.2.0";
const MAX_BUFFER = 120;        // snapshots kept in memory while the server is unreachable
const MAX_PER_FLUSH = 4;       // snapshots sent per round (the server allows 10 per 10 seconds)

// ---------- options ----------

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const HELP = `CloudRewind agent ${VERSION}

Usage:
  node index.js [--url=http://localhost:5000] [--service=main] [--instance=host-1] [--interval=5]
               [--health-url=https://your-app.example/health]
  node index.js --dry-run        Print what would be sent. Sends nothing.

Options:
  --url=...       Backend address. Default: http://localhost:5000
  --service=...   Name of this service. Default: main
  --instance=...  Host or replica name. Default: this machine's hostname
  --interval=N    Seconds between readings (2 to 3600). Default: 5
  --health-url=... Optional HTTP(S) health endpoint to probe from this machine
                  (or set CLOUDREWIND_HEALTH_URL)
  --dry-run       Show the data, send nothing
  --help          Show this text
`;

const known = new Set(["url", "service", "instance", "interval", "health-url", "dry-run", "help"]);
const opts = {};
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith("--")) fail(`Unexpected argument "${arg}". Write options as --name=value. Try --help.`);
  const [name, ...rest] = arg.slice(2).split("=");
  if (!known.has(name)) fail(`Unknown option --${name}. Try --help.`);
  opts[name] = rest.length ? rest.join("=") : true;
}

if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

const dryRun = opts["dry-run"] === true;
const key = process.env.CLOUDREWIND_KEY;
const service = typeof opts.service === "string" ? opts.service : "main";
const cleanHostname = os.hostname().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 80) || "unknown";
const instance = typeof opts.instance === "string" ? opts.instance : process.env.CLOUDREWIND_INSTANCE || cleanHostname;
const intervalSeconds = opts.interval === undefined ? 5 : Number(opts.interval);
let url = typeof opts.url === "string" ? opts.url : "http://localhost:5000";
const healthUrlInput = typeof opts["health-url"] === "string" ? opts["health-url"] : process.env.CLOUDREWIND_HEALTH_URL;

if (!dryRun) {
  if (!key) fail("No API key. Set CLOUDREWIND_KEY in the agent environment. (Use --dry-run to try without one.)");
  if (!/^cr_[0-9a-f]{64}$/.test(key)) fail("That does not look like a CloudRewind API key. It should start with cr_.");
}
if (!/^[a-zA-Z0-9_-]{1,40}$/.test(service)) fail("--service may only use letters, numbers, - and _ (1 to 40 characters).");
if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(instance)) fail("--instance may only use letters, numbers, dots, - and _ (1 to 80 characters).");
if (!Number.isFinite(intervalSeconds) || intervalSeconds < 2 || intervalSeconds > 3600) {
  fail("--interval must be a number from 2 to 3600 (seconds).");
}

let parsedUrl;
try {
  parsedUrl = new URL(url);
} catch {
  fail(`--url is not a valid address: ${url}`);
}
if (!["http:", "https:"].includes(parsedUrl.protocol)) fail("--url must start with http:// or https://");
url = url.replace(/\/+$/, "");

let healthUrl = null;
if (healthUrlInput) {
  try {
    healthUrl = new URL(healthUrlInput);
  } catch {
    fail("--health-url must be a valid HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(healthUrl.protocol) || healthUrl.username || healthUrl.password) {
    fail("--health-url must use HTTP or HTTPS and must not contain embedded credentials.");
  }
}

const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(parsedUrl.hostname);
if (parsedUrl.protocol === "http:" && !isLocal && !dryRun) {
  console.warn("Warning: this address uses plain http. Your API key and data travel unencrypted. Use https:// outside local testing.");
}
if (os.cpus().length === 0) fail("Could not read CPU information on this machine.");

const intervalMs = intervalSeconds * 1000;

// ---------- measuring ----------

const round = (n) => Math.round(n * 10) / 10;
const clamp = (n) => Math.min(100, Math.max(0, n));

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const time of Object.values(cpu.times)) total += time;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

// CPU needs two readings: usage is the share of time NOT idle between them.
let previousCpu = cpuTimes();
function readCpu() {
  const now = cpuTimes();
  const idleDelta = now.idle - previousCpu.idle;
  const totalDelta = now.total - previousCpu.total;
  previousCpu = now;
  return totalDelta > 0 ? clamp(100 * (1 - idleDelta / totalDelta)) : 0;
}

function readMemory() {
  return clamp(100 * (1 - os.freemem() / os.totalmem()));
}

// Network: Linux only (reads /proc/net/dev). Elsewhere the field is simply left out.
function networkBytes() {
  try {
    let bytes = 0;
    for (const line of fs.readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) {
      const [name, data] = line.split(":");
      if (!data || name.trim() === "lo") continue;
      const fields = data.trim().split(/\s+/).map(Number);
      bytes += (fields[0] || 0) + (fields[8] || 0); // received + transmitted
    }
    return bytes;
  } catch {
    return null;
  }
}

const initialNetworkBytes = networkBytes();
let previousNet = initialNetworkBytes === null ? null : { bytes: initialNetworkBytes, at: Date.now() };
function readNetwork() {
  if (previousNet === null) return undefined;
  const bytes = networkBytes();
  const now = Date.now();
  const kbPerSecond = (bytes - previousNet.bytes) / 1024 / ((now - previousNet.at) / 1000);
  previousNet = { bytes, at: now };
  return kbPerSecond >= 0 ? kbPerSecond : undefined; // a counter reset gives a negative number: skip it
}

function measure() {
  const snapshot = { service, instance, timestamp: Date.now(), cpu: round(readCpu()), memory: round(readMemory()) };
  const network = readNetwork();
  if (network !== undefined) snapshot.network = round(network);
  return snapshot;
}

async function probeHealth() {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": `CloudRewind-Agent/${VERSION}` },
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => {});
    return { http_status: response.status, response_ms: round(Date.now() - started) };
  } catch {
    return { http_status: 0, response_ms: round(Date.now() - started) };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------- sending ----------

const buffer = [];
let flushing = false;
let failures = 0;
let nextAttemptAt = 0;
let online = true;
let bufferFullWarned = false;

const clock = (ts) => new Date(ts).toLocaleTimeString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Returns "ok", "drop" (server refused this snapshot, do not retry), "fatal" (bad key) or "retry"
async function send(snapshot) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${url}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify(snapshot),
      signal: controller.signal,
    });
    if (res.status === 201) return "ok";
    if (res.status === 401) return "fatal";
    if (res.status === 400 || res.status === 413) {
      console.error(`The server refused a snapshot (${res.status}): ${await res.text().catch(() => "")}`);
      return "drop";
    }
    return "retry"; // 429, 5xx, anything else
  } catch {
    return "retry";
  } finally {
    clearTimeout(timer);
  }
}

async function flush() {
  if (flushing || Date.now() < nextAttemptAt) return;
  flushing = true;
  try {
    let sent = 0;
    while (buffer.length > 0 && sent < MAX_PER_FLUSH) {
      const snapshot = buffer[0];
      const outcome = await send(snapshot);

      if (outcome === "fatal") {
        console.error("The server rejected the API key. It may have been rotated or deleted. Get a key from the Projects page and restart the agent.");
        return shutdown(1);
      }
      if (outcome === "retry") {
        failures++;
        nextAttemptAt = Date.now() + Math.min(60000, 1000 * 2 ** failures);
        if (online) {
          online = false;
          console.error(`Cannot reach ${url}. Keeping snapshots in memory and retrying...`);
        }
        return;
      }

      buffer.shift(); // sent, or refused for good
      sent++;
      failures = 0;
      bufferFullWarned = false;
      if (!online) {
        online = true;
        console.log("Connection restored. Sending the snapshots that were kept.");
      }
      if (outcome === "ok") {
        const health = snapshot.http_status == null ? "" : `  HTTP ${snapshot.http_status} ${snapshot.response_ms}ms`;
        console.log(`${clock(snapshot.timestamp)}  cpu ${snapshot.cpu}%  memory ${snapshot.memory}%${health}  sent`);
      }
    }
  } finally {
    flushing = false;
  }
}

// ---------- main loop ----------

let timer = null;

let sampling = false;
async function tick() {
  if (sampling) return;
  sampling = true;
  try {
  const snapshot = measure();
  if (healthUrl) Object.assign(snapshot, await probeHealth());

  if (dryRun) {
    console.log(`${clock(snapshot.timestamp)}  would send: ${JSON.stringify(snapshot)}`);
    return;
  }

  buffer.push(snapshot);
  if (buffer.length > MAX_BUFFER) {
    buffer.shift();
    if (!bufferFullWarned) {
      bufferFullWarned = true;
      console.error("Memory buffer is full. The oldest snapshots are being dropped until the server is reachable.");
    }
  }
  flush();
  } finally {
    sampling = false;
  }
}

function schedule(delay) {
  timer = setTimeout(async () => {
    await tick();
    schedule(intervalMs);
  }, delay);
}

async function shutdown(code) {
  clearTimeout(timer);
  if (!dryRun && buffer.length > 0) {
    nextAttemptAt = 0;
    await Promise.race([flush(), sleep(3000)]); // one last try, at most 3 seconds
  }
  console.log("Agent stopped.");
  process.exit(code);
}

async function start() {
  console.log(`CloudRewind agent ${VERSION}`);
  console.log(`  Server:   ${url}`);
  console.log(`  Service:  ${service}`);
  console.log(`  Instance: ${instance}`);
  console.log(`  Interval: ${intervalSeconds}s`);
  console.log(`  Sends:    cpu, memory${previousNet ? ", network" : ""}${healthUrl ? ", HTTP status and latency" : ""}`);
  console.log(`  Health:   ${healthUrl ? "HTTP status and latency only" : "disabled"}`);
  console.log(`  Mode:     ${dryRun ? "DRY RUN: nothing is sent" : "live"}`);
  console.log("Press Ctrl+C to stop.\n");

  if (!dryRun) {
    try {
      const res = await fetch(`${url}/ingest/ping`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(10000) });
      if (res.status === 401) {
        fail("The server rejected the API key. Check that you copied the whole key, and that it was not rotated.");
      }
      if (res.ok) console.log(`Connected to project "${(await res.json()).project}".`);
      else console.warn(`Server answered ${res.status} to the key check. Will keep trying.`);
    } catch {
      console.warn(`Cannot reach ${url} yet. Will keep trying.`);
    }
  }

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  schedule(1000); // first reading after 1 second, then every interval
}

start();
