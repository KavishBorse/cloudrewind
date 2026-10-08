const LEAK_PER_TICK = 0.5; // how fast memory climbs each snapshot
const RESTART_AT = 92;     // memory % where the container crashes
const MEMORY_START = 40;

const state = { memory: MEMORY_START };

const rand = (min, max) => Math.random() * (max - min) + min;
const round = (n) => Math.round(n * 10) / 10;
const clamp = (n) => Math.min(100, Math.max(0, n));

function generateSnapshot() {
  const containers = [
    { name: "web-1", status: "running" },
    { name: "api-2", status: "running" },
    { name: "worker-3", status: "running" },
  ];

  // The failure story: api-2 slowly leaks memory
  state.memory += LEAK_PER_TICK + rand(-0.2, 0.3);
  const memory = clamp(state.memory);

  // When memory is nearly full, api-2 crashes and restarts clean
  if (memory >= RESTART_AT) {
    containers[1].status = "restarting";
    state.memory = MEMORY_START;
  }

  // CPU and DB connections rise a bit as memory pressure builds
  const pressure = memory - MEMORY_START;
  const cpu = clamp(25 + rand(-5, 5) + pressure * 0.3);
  const db_connections = Math.round(rand(10, 20) + pressure * 0.2);
  const network = rand(5, 15);

  return {
    timestamp: Date.now(),
    cpu: round(cpu),
    memory: round(memory),
    containers,
    db_connections,
    network: round(network),
  };
}

module.exports = { generateSnapshot };