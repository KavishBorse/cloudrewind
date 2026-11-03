// Pure helper functions for the dashboard charts. No React in this file.

export const RANGES = [
  { label: "5 min", ms: 5 * 60 * 1000 },
  { label: "15 min", ms: 15 * 60 * 1000 },
  { label: "30 min", ms: 30 * 60 * 1000 },
  { label: "1 h", ms: 60 * 60 * 1000 },
  { label: "24 h", ms: 24 * 60 * 60 * 1000 },
  { label: "7 d", ms: 7 * 24 * 60 * 60 * 1000 },
];

// From this range on, time labels also show the date
export const LONG_RANGE_MS = 24 * 60 * 60 * 1000;

// One entry per chart panel. "percent" metrics get the Auto / 0-100% toggle.
export const METRICS = [
  { key: "cpu", title: "CPU", unit: "%", color: "#38bdf8", percent: true },
  { key: "memory", title: "Memory", unit: "%", color: "#f472b6", percent: true },
  { key: "network", title: "Network", unit: " KB/s", color: "#a3e635" },
  { key: "response_ms", title: "HTTP response time", unit: " ms", color: "#fb923c" },
  { key: "db_connections", title: "DB connections", unit: "", color: "#fbbf24" },
  { key: "db_connected", title: "Database connectivity", unit: "", color: "#22d3ee", step: true, status: true },
  { key: "containers", title: "Containers running", unit: "", color: "#34d399", step: true },
];

// Events sent with POST /events. Colours differ from the metric colours and the yellow rewind marker.
export const EVENT_TYPES = {
  deploy: { label: "Deploy", color: "#a78bfa" },
  config_change: { label: "Config change", color: "#fb923c" },
  restart: { label: "Restart", color: "#94a3b8" },
};
export const eventStyle = (type) => EVENT_TYPES[type] ?? { label: type, color: "#94a3b8" };

const KEYS = METRICS.map((m) => m.key);

export const round1 = (n) => Math.round(n * 10) / 10;

// Keep only the snapshots inside the last rangeMs (measured from the newest snapshot)
export function filterRange(snapshots, rangeMs) {
  if (snapshots.length === 0) return [];
  const from = snapshots[snapshots.length - 1].timestamp - rangeMs;
  return snapshots.filter((s) => s.timestamp >= from);
}

// Where snapshots are missing for a while, break the lines and report the gap
// (so the chart shows a red "No data" area instead of a made-up line).
export function buildChart(snapshots) {
  if (snapshots.length < 2) return { data: snapshots, gaps: [] };
  const deltas = snapshots
    .slice(1)
    .map((s, i) => s.timestamp - snapshots[i].timestamp)
    .sort((a, b) => a - b);
  const typical = deltas[Math.floor(deltas.length / 2)];
  const gapMs = Math.max(15000, typical * 3);

  const data = [];
  const gaps = [];
  snapshots.forEach((s, i) => {
    if (i > 0 && s.timestamp - snapshots[i - 1].timestamp > gapMs) {
      const from = snapshots[i - 1].timestamp;
      const empty = { timestamp: from + 1 };
      for (const k of KEYS) {
        empty[k] = null;
        empty[`${k}_max`] = null;
      }
      data.push(empty);
      gaps.push({ from, to: s.timestamp });
    }
    data.push(s);
  });
  return { data, gaps };
}

// Now / Average / Max (and when the max happened) for one metric.
// Old data is summarised: the average is in "cpu", the highest value in "cpu_max".
export function computeStats(data, key) {
  let sum = 0;
  let count = 0;
  let max = null;
  let maxAt = null;
  for (const row of data) {
    const v = row[key];
    if (v == null) continue;
    const peak = row[`${key}_max`] ?? v;
    sum += v;
    count++;
    if (max === null || peak > max) {
      max = peak;
      maxAt = row.timestamp;
    }
  }
  return count === 0 ? null : { avg: sum / count, max, maxAt };
}

// Round a number up to a "nice" axis value: 1, 2, 2.5, 5, 10 times a power of ten
function niceCeil(x) {
  if (x <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * power >= x) return m * power;
  }
  return 10 * power;
}

// Vertical axis range. Always starts at 0.
// "auto" fits the data; "fixed" (percent metrics only) is 0 to 100.
export function yDomain(metric, data, mode, normalContainers) {
  if (metric.percent && mode === "fixed") return [0, 100];
  if (metric.status) return [0, 1];
  const values = data.flatMap((r) => [r[metric.key], r[`${metric.key}_max`]]).filter((v) => v != null);
  const max = values.length ? Math.max(...values) : 0;
  if (metric.key === "containers") return [0, Math.max(normalContainers, max, 1) + 1];
  // Pick a round step so the 5 axis labels read 0, 25, 50, 75, 100 (never 0, 7, 14, 21...)
  const step = niceCeil(Math.max(max * 1.15, 10) / 4);
  const top = step * 4;
  return [0, metric.percent ? Math.min(100, top) : top];
}

// A few evenly spaced time labels (fewer labels = no crowding)
export function makeTicks(first, last, count = 4) {
  if (first == null || last == null || first === last) return first == null ? [] : [first];
  const step = (last - first) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(first + step * i));
}

// Short clock label: 14:05 (or 14:05:30 when the range is short). With a date for long ranges: 17 Oct, 14:05
export function formatClock(ts, withSeconds = false, withDate = false) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  });
  return withDate ? `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}` : time;
}
