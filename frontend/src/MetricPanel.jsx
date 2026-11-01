import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
  ResponsiveContainer,
} from "recharts";
import { computeStats, eventStyle, formatClock, round1 } from "./chartData";

// All panels share this id, so hovering one chart shows the same moment on the others.
const SYNC_ID = "cloudrewind-metrics";

const fmt = (v, unit) => (v == null ? "–" : `${round1(v)}${unit}`);

// One metric = one panel: title, stats line, and a chart with its own vertical axis.
// Clicking the chart calls onPick(timestamp) so the page can rewind to that moment.
export default function MetricPanel({
  metric,
  data,
  gaps,
  domain,
  ticks,
  tickFormatter,
  longRange,
  events = [],
  selectedTime,
  nowLabel,
  nowValue,
  onPick,
}) {
  const stats = computeStats(data, metric.key);
  // Old data is summarised: the solid line is the average, the dashed line is the highest value in each period
  const hasMax = data.some((r) => r[`${metric.key}_max`] != null);
  // Evenly spaced axis labels (0, 2.5, 5, 7.5, 10). Containers use whole numbers.
  const top = domain[1];
  const yTicks = metric.step
    ? Array.from({ length: top + 1 }, (_, i) => i)
    : [0, 1, 2, 3, 4].map((i) => (top * i) / 4);

  function handleClick(state) {
    const index = Number(state?.activeIndex);
    const row = Number.isInteger(index) ? data[index] : null;
    const timestamp = row?.timestamp ?? state?.activeLabel;
    if (typeof timestamp === "number") onPick(timestamp);
  }

  return (
    <div className="rounded-xl bg-slate-800 p-4 border border-slate-700" data-testid={`panel-${metric.key}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold" style={{ color: metric.color }}>
          {metric.title}
        </h3>
        <p className="text-xs text-slate-400">
          {nowLabel} <span className="text-slate-100">{fmt(nowValue, metric.unit)}</span>
          <span className="mx-2 text-slate-600">|</span>
          Average <span className="text-slate-100">{fmt(stats?.avg, metric.unit)}</span>
          <span className="mx-2 text-slate-600">|</span>
          Max <span className="text-slate-100">{fmt(stats?.max, metric.unit)}</span>
          {stats && <span> at {formatClock(stats.maxAt, true, longRange)}</span>}
        </p>
      </div>

      <div className="mt-2 cursor-crosshair [&_*]:outline-none">
        <ResponsiveContainer width="100%" height={150}>
          <LineChart data={data} syncId={SYNC_ID} onClick={handleClick} margin={{ top: 5, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#334155" strokeDasharray="3 3" />
            <XAxis
              dataKey="timestamp"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              ticks={ticks}
              tickFormatter={tickFormatter}
              stroke="#94a3b8"
              tick={{ fontSize: 11 }}
            />
            <YAxis
              domain={domain}
              allowDecimals={!metric.step}
              ticks={yTicks}
              tickFormatter={(v) => round1(v)}
              width={44}
              stroke="#94a3b8"
              tick={{ fontSize: 11 }}
            />
            <Tooltip
              labelFormatter={(ts) => formatClock(ts, true, longRange)}
              formatter={(v, name) => [fmt(v, metric.unit), name]}
              contentStyle={{ background: "#1e293b", border: "1px solid #334155" }}
            />
            <Line
              type={metric.step ? "stepAfter" : "monotone"}
              dataKey={metric.key}
              name={metric.title}
              stroke={metric.color}
              dot={false}
              isAnimationActive={false}
            />
            {hasMax && (
              <Line
                type="monotone"
                dataKey={`${metric.key}_max`}
                name={`${metric.title} (highest)`}
                stroke={metric.color}
                strokeDasharray="4 3"
                strokeOpacity={0.6}
                dot={false}
                isAnimationActive={false}
              />
            )}
            {gaps.map((g) => (
              <ReferenceArea
                key={g.from}
                x1={g.from}
                x2={g.to}
                fill="#f87171"
                fillOpacity={0.12}
                label={{ value: "No data", fill: "#fca5a5", fontSize: 11 }}
              />
            ))}
            {events.map((e) => (
              <ReferenceLine key={`event-${e.id}`} x={e.timestamp} stroke={eventStyle(e.event_type).color} strokeDasharray="2 4" strokeOpacity={0.8} />
            ))}
            {selectedTime !== null && <ReferenceLine x={selectedTime} stroke="#facc15" strokeWidth={2} />}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}