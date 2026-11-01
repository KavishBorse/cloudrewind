const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { PORT, CORS_ORIGINS } = require("./config");
const { db, insertSnapshot, getDemoProjects } = require("./db");
const { nextDemoSnapshot } = require("./simulator");
const { runRetention } = require("./retention");
const { processSnapshot } = require("./incidentService");

const app = express();
const allowedOrigins = new Set(CORS_ORIGINS);
app.use(cors({
  origin(origin, callback) {
    // Requests without an Origin header come from local tools such as curl.
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(null, false);
  },
}));
app.use(express.json({ limit: "10kb" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.get("/ready", async (req, res) => {
  try {
    await db.prepare("SELECT 1 AS ready").get();
    res.json({ status: "ready", database: db.driver });
  } catch (error) {
    console.error("Readiness check failed:", error.message);
    res.status(503).json({ status: "not_ready" });
  }
});

app.use("/auth", require("./routes/auth"));
app.use("/workspaces", require("./routes/workspaces"));
app.use("/projects", require("./routes/projects"));
app.use("/projects/:id/aws", require("./routes/aws"));
app.use("/ingest", require("./routes/ingest"));
app.use("/events", require("./routes/events"));

// Unknown address: answer in JSON like everything else
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Any error: answer in JSON, never an HTML error page
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Request body too large (max 10 KB)" });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Body is not valid JSON" });
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
});

async function recordDemoSnapshots() {
  try {
    for (const project of await getDemoProjects()) {
      const snap = nextDemoSnapshot(project.id);
      await insertSnapshot(project.id, snap);
      await processSnapshot({ ...snap, project_id: project.id });
      console.log(`Saved snapshot | project ${project.id} | cpu ${snap.cpu}% | mem ${snap.memory}%`);
    }
  } catch (err) {
    console.error("Demo snapshot job failed:", err);
  }
}

async function start() {
  await db.initialize();

  // Recorder: every 5 seconds, one simulated snapshot for each demo project.
  // Every stored reading goes through the same incident detector as agent data.
  const demoTimer = setInterval(recordDemoSnapshots, 5000);

  // Retention: every day at 03:00 old raw data becomes 1-minute rollups, then 12-hour rollups.
  // To run it by hand: node run-retention.js
  const retentionTask = cron.schedule("0 3 * * *", async () => {
    try {
      await runRetention(db);
    } catch (err) {
      console.error("Retention job failed:", err);
    }
  });

  const server = app.listen(PORT, () => console.log(`Backend running on port ${PORT} (${db.driver})`));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(demoTimer);
    retentionTask.stop();
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}

if (require.main === module) {
  start().catch(async (error) => {
    console.error("Backend startup failed:", error);
    await db.close().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = { app, start };
