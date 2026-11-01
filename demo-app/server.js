// A tiny "app" to watch with CloudRewind. It can burn CPU and leak memory on request,
// so you get REAL spikes and a REAL container crash to rewind to.
//
//   GET /                      help text
//   GET /status                what it is doing right now
//   GET /load?seconds=30       burn CPU on every core for N seconds
//   GET /leak/start            leak memory until the container is killed
//   GET /leak/stop             stop leaking and free the memory

const http = require("http");
const os = require("os");
const { Worker, isMainThread, workerData } = require("worker_threads");

// A CPU worker just spins until its time is up
if (!isMainThread) {
  const end = Date.now() + workerData.ms;
  while (Date.now() < end) {
    // busy loop
  }
  return;
}

const PORT = 3000;
const LEAK_MB_PER_STEP = 25;  // every 500 ms, so about 50 MB per second
const leaked = [];
let leakTimer = null;
let loadUntil = 0;

function startLoad(seconds) {
  const ms = seconds * 1000;
  loadUntil = Date.now() + ms;
  for (let i = 0; i < os.cpus().length; i++) {
    new Worker(__filename, { workerData: { ms } });
  }
}

function startLeak() {
  if (leakTimer) return;
  leakTimer = setInterval(() => {
    // fill(1) writes to every byte, so the memory is really used
    leaked.push(Buffer.alloc(LEAK_MB_PER_STEP * 1024 * 1024, 1));
  }, 500);
}

function stopLeak() {
  clearInterval(leakTimer);
  leakTimer = null;
  leaked.length = 0;
}

function status() {
  return {
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    cpuLoadSecondsLeft: Math.max(0, Math.round((loadUntil - Date.now()) / 1000)),
    leaking: leakTimer !== null,
    leakedMB: leaked.length * LEAK_MB_PER_STEP,
  };
}

const HELP = `CloudRewind demo app

  /status              what it is doing now
  /load?seconds=30     burn CPU on every core
  /leak/start          leak memory until this container is killed
  /leak/stop           stop leaking
`;

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (obj) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj) + "\n");
    };

    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(HELP);
    }
    if (url.pathname === "/status") return json(status());
    if (url.pathname === "/load") {
      const seconds = Math.min(120, Math.max(1, Number(url.searchParams.get("seconds")) || 30));
      startLoad(seconds);
      return json({ ok: true, burningCpuForSeconds: seconds });
    }
    if (url.pathname === "/leak/start") {
      startLeak();
      return json({ ok: true, leaking: true });
    }
    if (url.pathname === "/leak/stop") {
      stopLeak();
      return json({ ok: true, leaking: false });
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found\n");
  })
  .listen(PORT, () => console.log(`Demo app listening on port ${PORT}`));
