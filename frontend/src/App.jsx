import { useEffect, useState } from "react";
import axios from "axios";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

const API = "http://localhost:5000";
const HISTORY = 360; // 360 snapshots = 30 minutes at 5s intervals

const formatTime = (ts) => new Date(ts).toLocaleTimeString();

function MetricCard({ label, value, unit, warn }) {
  return (
    <div className="rounded-xl bg-slate-800 p-4 border border-slate-700">
      <p className="text-sm text-slate-400">{label}</p>
      <p className={`mt-1 text-3xl font-bold ${warn ? "text-red-400" : "text-white"}`}>
        {value ?? "–"}
        <span className="text-base font-normal text-slate-400 ml-1">{unit}</span>
      </p>
    </div>
  );
}

export default function App() {
  const [snapshots, setSnapshots] = useState([]);
  const [error, setError] = useState(null);
  const [selectedTime, setSelectedTime] = useState(null); // null means live
  const [rewindSnapshot, setRewindSnapshot] = useState(null);

  const isRewind = selectedTime !== null;

  // Live polling: runs every 5s, paused while rewinding
  useEffect(() => {
    if (isRewind) return;
    async function load() {
      try {
        const res = await axios.get(`${API}/snapshots`, { params: { limit: HISTORY } });
        setSnapshots(res.data);
        setError(null);
      } catch {
        setError("Cannot reach the backend on port 5000. Is it running?");
      }
    }
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [isRewind]);

  // Rewind: fetch the snapshot nearest to the slider position
  useEffect(() => {
    if (selectedTime === null) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await axios.get(`${API}/snapshot`, { params: { time: selectedTime } });
        if (!cancelled) setRewindSnapshot(res.data);
      } catch {
        if (!cancelled) setError("Could not load that snapshot.");
      }
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedTime]);

  function backToLive() {
    setSelectedTime(null);
    setRewindSnapshot(null);
  }

  const first = snapshots[0]?.timestamp;
  const last = snapshots[snapshots.length - 1]?.timestamp;
  const latest = snapshots[snapshots.length - 1];
  const shown = isRewind ? rewindSnapshot ?? latest : latest;
  const recent = [...snapshots].reverse().slice(0, 15);

  // Highest container count seen = the "normal" number
  const normalContainers = Math.max(0, ...snapshots.map((s) => s.containers ?? 0));
  const isDown = (count) => count != null && count < normalContainers;

  return (
    <div className="min-h-screen bg-slate-900 text-white p-6">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold">CloudRewind</h1>
        <p className="text-slate-400 text-sm mb-6">
          {isRewind ? "Rewind mode: viewing a past moment" : "Live system state, refreshed every 5 seconds"}
        </p>

        {error && (
          <div className="mb-4 rounded-lg bg-red-900/40 border border-red-700 p-3 text-red-200">
            {error}
          </div>
        )}

        {!shown && !error && <p className="text-slate-400">Loading...</p>}

        {shown && (
          <>
            {/* Timeline scrubber */}
            <div className="mb-6 rounded-xl bg-slate-800 p-4 border border-slate-700">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm text-slate-400">
                  {isRewind ? (
                    <>
                      Snapshot from{" "}
                      <span className="text-cyan-300 font-semibold">{formatTime(shown.timestamp)}</span>
                    </>
                  ) : (
                    "Drag the slider to rewind"
                  )}
                </p>
                {isRewind && (
                  <button
                    onClick={backToLive}
                    className="rounded-lg bg-cyan-500 px-3 py-1 text-sm font-semibold text-slate-900 hover:bg-cyan-400"
                  >
                    Back to live
                  </button>
                )}
              </div>
              <input
                type="range"
                min={first}
                max={last}
                step={1000}
                value={selectedTime ?? last}
                onChange={(e) => setSelectedTime(Number(e.target.value))}
                className="w-full accent-cyan-400"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>{formatTime(first)}</span>
                <span>{formatTime(last)}</span>
              </div>
            </div>

            {/* Metric cards for the live or rewound snapshot */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <MetricCard label="CPU" value={shown.cpu} unit="%" warn={shown.cpu > 80} />
              <MetricCard label="Memory" value={shown.memory} unit="%" warn={shown.memory > 80} />
              <MetricCard label="DB connections" value={shown.db_connections} unit="" warn={shown.db_connections > 40} />
              <MetricCard label="Network" value={shown.network} unit="KB/s" />
            </div>

            <div className="mt-4 rounded-xl bg-slate-800 p-4 border border-slate-700">
              <p className="text-sm text-slate-400 mb-1">Containers running</p>
              <p className={`text-2xl font-bold ${isDown(shown.containers) ? "text-red-400" : "text-green-400"}`}>
                {shown.containers ?? "–"}
              </p>
            </div>

            {/* CPU and memory chart with the slider position marked */}
            <h2 className="mt-8 mb-2 text-lg font-semibold">CPU and memory over time</h2>
            <div className="rounded-xl bg-slate-800 p-4 border border-slate-700">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={snapshots}>
                  <CartesianGrid stroke="#334155" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="timestamp"
                    type="number"
                    scale="time"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={formatTime}
                    stroke="#94a3b8"
                    tick={{ fontSize: 12 }}
                  />
                  <YAxis domain={[0, 100]} stroke="#94a3b8" tick={{ fontSize: 12 }} />
                  <Tooltip
                    labelFormatter={formatTime}
                    contentStyle={{ background: "#1e293b", border: "1px solid #334155" }}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="cpu" name="CPU %" stroke="#38bdf8" dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="memory" name="Memory %" stroke="#f472b6" dot={false} isAnimationActive={false} />
                  {isRewind && <ReferenceLine x={selectedTime} stroke="#facc15" strokeWidth={2} />}
                </LineChart>
              </ResponsiveContainer>
            </div>

            <h2 className="mt-8 mb-2 text-lg font-semibold">Recent snapshots</h2>
            <div className="rounded-xl border border-slate-700 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-800 text-slate-400 text-left">
                  <tr>
                    <th className="p-2">Time</th>
                    <th className="p-2">CPU</th>
                    <th className="p-2">Memory</th>
                    <th className="p-2">DB conn</th>
                    <th className="p-2">Containers</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((s) => {
                    const down = isDown(s.containers);
                    const selected = rewindSnapshot && s.id === rewindSnapshot.id;
                    return (
                      <tr key={s.id} className={`border-t border-slate-800 ${selected ? "bg-cyan-900/30" : ""}`}>
                        <td className="p-2">{formatTime(s.timestamp)}</td>
                        <td className="p-2">{s.cpu}%</td>
                        <td className="p-2">{s.memory}%</td>
                        <td className="p-2">{s.db_connections ?? "–"}</td>
                        <td className={`p-2 ${down ? "text-red-400" : "text-green-400"}`}>
                          {down ? "restarting" : "all running"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}