const express = require("express");
const cors = require("cors");
const { PORT } = require("./config");
const { insertSnapshot, getSnapshots, getClosestSnapshot, getDemoProjects } = require("./db");
const { createSimulator } = require("./simulator");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// TEMPORARY: routes without login, so the current dashboard keeps working.
// They are removed on Day 7, when the frontend moves to /projects/:id/... with login.
const firstDemoId = () => getDemoProjects()[0]?.id;

app.get("/snapshots", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 1000, 5000);
  res.json(getSnapshots(firstDemoId(), limit));
});

app.get("/snapshot", (req, res) => {
  const time = Number(req.query.time);
  if (!time) return res.status(400).json({ error: "time query param required" });
  const snapshot = getClosestSnapshot(firstDemoId(), time);
  if (!snapshot) return res.status(404).json({ error: "no snapshots yet" });
  res.json(snapshot);
});

// Recorder: every 5 seconds, one simulated snapshot for each demo project
const simulators = new Map();
setInterval(() => {
  for (const project of getDemoProjects()) {
    if (!simulators.has(project.id)) simulators.set(project.id, createSimulator());
    const snap = simulators.get(project.id)();
    insertSnapshot(project.id, snap);
    console.log(`Saved snapshot | project ${project.id} | cpu ${snap.cpu}% | mem ${snap.memory}%`);
  }
}, 5000);

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));