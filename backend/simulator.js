const MEMORY_START = 40;
const NORMAL_CONTAINERS = 3;
const SCENARIOS = new Set(["cpu_spike", "memory_leak", "db_flood", "container_death", "bad_deploy", "normal_control"]);
const demoSimulators = new Map();

const rand = (min, max) => Math.random() * (max - min) + min;
const round = (n) => Math.round(n * 10) / 10;
const clamp = (n) => Math.min(100, Math.max(0, n));

// Each demo project gets its own simulator, so fault scenarios do not affect other demos.
function createSimulator() {
  let scenario = null;

  function next() {
    const snapshot = {
      service: "main",
      timestamp: Date.now(),
      cpu: round(clamp(25 + rand(-5, 5))),
      memory: round(clamp(MEMORY_START + rand(-3, 3))),
      containers: NORMAL_CONTAINERS,
      db_connections: Math.round(rand(10, 20)),
      network: round(rand(300, 900)), // KB/s
    };

    if (scenario) {
      scenario.ticksLeft--;
      if (scenario.type === "cpu_spike") snapshot.cpu = 96;
      if (scenario.type === "memory_leak" || scenario.type === "bad_deploy") {
        scenario.leak = Math.min(96, scenario.leak + 8);
        snapshot.memory = scenario.leak;
        snapshot.cpu = Math.max(snapshot.cpu, round(45 + (scenario.leak - MEMORY_START) * 0.7));
      }
      if (scenario.type === "db_flood") snapshot.db_connections = 98;
      if (scenario.type === "container_death") snapshot.containers = 0;
      if (scenario.ticksLeft <= 0) {
        scenario = null;
      }
    }

    return snapshot;
  }

  next.startScenario = (type) => {
    if (!SCENARIOS.has(type)) return { ok: false, error: "Unknown scenario" };
    if (scenario) return { ok: false, error: `Scenario ${scenario.type} is already running` };
    scenario = { type, ticksLeft: 12, leak: MEMORY_START };
    return { ok: true, type, duration_seconds: 60 };
  };

  return next;
}

function getDemoSimulator(projectId) {
  if (!demoSimulators.has(projectId)) demoSimulators.set(projectId, createSimulator());
  return demoSimulators.get(projectId);
}

function nextDemoSnapshot(projectId) {
  return getDemoSimulator(projectId)();
}

function triggerDemoScenario(projectId, type) {
  return getDemoSimulator(projectId).startScenario(type);
}

module.exports = { createSimulator, nextDemoSnapshot, triggerDemoScenario, SCENARIOS: [...SCENARIOS] };
