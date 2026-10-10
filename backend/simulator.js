const LEAK_PER_TICK = 0.5; // how fast memory climbs each snapshot
const RESTART_AT = 92;     // memory % where the container crashes
const MEMORY_START = 40;
const NORMAL_CONTAINERS = 3;

const rand = (min, max) => Math.random() * (max - min) + min;
const round = (n) => Math.round(n * 10) / 10;
const clamp = (n) => Math.min(100, Math.max(0, n));

// Each demo project gets its own simulator, so each keeps its own memory-leak state
function createSimulator() {
  let memory = MEMORY_START;

  return function next() {
    memory += LEAK_PER_TICK + rand(-0.2, 0.3);
    const mem = clamp(memory);

    let containers = NORMAL_CONTAINERS;
    if (mem >= RESTART_AT) {
      containers = NORMAL_CONTAINERS - 1; // one container is down during the restart
      memory = MEMORY_START;
    }

    // CPU and DB connections rise a bit as memory pressure builds
    const pressure = mem - MEMORY_START;
    return {
      service: "main",
      timestamp: Date.now(),
      cpu: round(clamp(25 + rand(-5, 5) + pressure * 0.3)),
      memory: round(mem),
      containers,
      db_connections: Math.round(rand(10, 20) + pressure * 0.2),
      network: round(rand(300, 900)), // KB/s
    };
  };
}

module.exports = { createSimulator };