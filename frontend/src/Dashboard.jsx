import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import api, { API_BASE_URL } from "./api";
import AgentBadge from "./AgentBadge";
import EventMarkers from "./EventMarkers";
import IncidentExplorer from "./IncidentExplorer";
import DashboardTools from "./DashboardTools";
import ExperimentBench from "./ExperimentBench";
import { RANGES, LONG_RANGE_MS, METRICS, filterRange, buildChart, yDomain, makeTicks, formatClock } from "./chartData";

const HISTORY = 800; // rows asked for. The backend thins out long ranges to about this many.
const MetricPanel = lazy(() => import("./MetricPanel"));
const AwsCloudWatch = lazy(() => import("./AwsCloudWatch"));
const streamKey = (service, instance) => `${service}:${instance}`;

const formatTime = (ts, withDate = false) => (withDate ? new Date(ts).toLocaleString() : new Date(ts).toLocaleTimeString());
const shortNumber = (n) => (n == null ? "–" : Math.round(n * 10) / 10); // one decimal at most

function MetricCard({ label, value, unit, warn }) {
  const displayed = typeof value === "number" ? shortNumber(value) : value ?? "–";
  return (
    <div className="border border-[#34372f] bg-slate-900/70 p-4">
      <p className="text-sm text-slate-400">{label}</p>
      <p className={`mt-1 text-3xl font-bold ${warn ? "text-red-400" : "text-white"}`}>
        {displayed}
        {unit && <span className="text-base font-normal text-slate-400 ml-1">{unit}</span>}
      </p>
    </div>
  );
}

function ButtonGroup({ options, value, onChange }) {
  return (
    <div className="inline-flex overflow-hidden rounded-xl border border-white/10 text-sm">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 transition ${value === o.value ? "bg-cyan-300 font-semibold text-slate-950" : "bg-slate-900 text-slate-300 hover:bg-slate-800"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const { projectId } = useParams();
  const [snapshots, setSnapshots] = useState([]);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [project, setProject] = useState(null);
  const [services, setServices] = useState([]);
  const [selectedStream, setSelectedStream] = useState("main:default");
  const [selectedService, selectedInstance] = selectedStream.split(":");
  const [selectedTime, setSelectedTime] = useState(null); // null means live
  const [rewindSnapshot, setRewindSnapshot] = useState(null);
  const [rangeMs, setRangeMs] = useState(RANGES[1].ms); // 15 minutes
  const [scaleMode, setScaleMode] = useState("auto"); // "auto" or "fixed" (0 to 100 for percent metrics)

  const isRewind = selectedTime !== null;

  const rewindRef = useRef(false);
  useEffect(() => {
    rewindRef.current = isRewind;
  }, [isRewind]);

  useEffect(() => {
    let active = true;
    async function loadServices() {
      try {
        const res = await api.get(`/projects/${projectId}/services`);
        if (!active) return;
        const next = res.data;
        const nextKeys = next.map((item) => streamKey(item.service, item.instance));
        setServices(next);
        setSelectedStream((current) => nextKeys.length && !nextKeys.includes(current) ? nextKeys[0] : current);
      } catch {
        // The dashboard can still show existing data if service discovery fails temporarily.
      }
    }
    loadServices();
    const timer = setInterval(loadServices, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [projectId]);

  // Load now (and whenever the range or service changes), then every 5s. Polling is paused while rewinding.
  // The backend answers from raw data for recent times and from rollups for old times.
  useEffect(() => {
    async function load() {
      try {
        const from = Date.now() - rangeMs;
        const [snapshotsRes, projectRes, eventsRes] = await Promise.all([
          api.get(`/projects/${projectId}/snapshots`, { params: { from, limit: HISTORY, service: selectedService, instance: selectedInstance } }),
          api.get(`/projects/${projectId}`),
          // Events are extra. If they cannot be loaded, the charts still work.
          api.get(`/projects/${projectId}/events`, { params: { from, limit: 200 } }).catch(() => ({ data: [] })),
        ]);
        setSnapshots(snapshotsRes.data);
        setEvents(eventsRes.data);
        setProject(projectRes.data);
        setLoaded(true);
        setError(null);
      } catch (err) {
        setError(
          err.response?.status === 404
            ? "Project not found."
            : `Cannot reach the backend at ${API_BASE_URL}. Is it running?`
        );
      }
    }
    load();
    const id = setInterval(() => {
      if (!rewindRef.current) load();
    }, 5000);
    return () => clearInterval(id);
  }, [projectId, rangeMs, selectedService, selectedInstance]);

  // Rewind: fetch the snapshot nearest to the slider position
  useEffect(() => {
    if (selectedTime === null) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await api.get(`/projects/${projectId}/snapshot`, { params: { time: selectedTime, service: selectedService, instance: selectedInstance } });
        if (!cancelled) setRewindSnapshot(res.data);
      } catch {
        if (!cancelled) setError("Could not load that snapshot.");
      }
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedTime, projectId, selectedService, selectedInstance]);

  function backToLive() {
    setSelectedTime(null);
    setRewindSnapshot(null);
  }

  function jumpTo(timestamp, serviceName, instanceName) {
    if (serviceName) setSelectedStream(streamKey(serviceName, instanceName || "default"));
    setSelectedTime(timestamp);
  }

  // Only the chosen time range is drawn
  const visible = useMemo(() => filterRange(snapshots, rangeMs), [snapshots, rangeMs]);
  const chart = useMemo(() => buildChart(visible), [visible]);

  const first = visible[0]?.timestamp;
  const last = visible[visible.length - 1]?.timestamp;
  const latest = snapshots[snapshots.length - 1];
  const shown = isRewind ? rewindSnapshot ?? latest : latest;
  // Only exact snapshots are listed (summarised rows cover a period, not a moment)
  const recent = snapshots.filter((s) => !s.bucket_seconds).reverse().slice(0, 15);
  const isSummary = visible.some((s) => s.summary);
  const longRange = rangeMs >= LONG_RANGE_MS;

  // Highest container count seen = the "normal" number
  const normalContainers = Math.max(0, ...snapshots.map((s) => s.containers ?? 0));
  const has = (field) => snapshots.some((s) => s[field] != null); // show only what this project reports
  const isDown = (count) => count != null && count < normalContainers;

  const panels = METRICS.filter((m) => has(m.key));
  const visibleEvents = useMemo(
    () => (first == null ? [] : events.filter((e) => e.timestamp >= first && e.timestamp <= last)),
    [events, first, last]
  );
  const withSeconds = rangeMs <= 5 * 60 * 1000;
  const ticks = makeTicks(first, last);
  const tickFormatter = (ts) => formatClock(ts, withSeconds, longRange);

  return (
    <main className="px-5 py-6 sm:px-7 lg:py-8">
      <div className="mx-auto max-w-6xl">
        <Link to="/" className="text-sm font-medium text-cyan-200 underline-offset-4 hover:text-cyan-100 hover:underline">
          ← All projects
        </Link>
        <div className="mt-4 flex flex-wrap items-center gap-3 border-b border-[#34372f] pb-4">
          <h1 className="cr-page-title">{project?.name ?? "Project dashboard"}</h1>
          {project?.is_demo !== 1 && project?.environment && (
            <span className="rounded-full border border-slate-700 px-2 py-1 text-xs uppercase tracking-wide text-slate-300">
              {project.environment}
            </span>
          )}
          {project && <AgentBadge project={project} />}
          {selectedInstance !== "default" && <span className="rounded-full border border-slate-700 px-2 py-1 text-xs text-slate-300">Instance · {selectedInstance}</span>}
          {services.length > 1 && (
            <label className="ml-auto flex items-center gap-2 text-xs text-slate-400">
              Service / instance
              <select value={selectedStream} onChange={(event) => { setSelectedStream(event.target.value); setSelectedTime(null); setRewindSnapshot(null); }} className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100">
                {services.map(({ service, instance }) => (
                  <option key={streamKey(service, instance)} value={streamKey(service, instance)}>
                    {instance === "default" ? service : `${service} · ${instance}`}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <p className="mb-6 mt-2 text-sm text-slate-400">
          {isRewind ? "Rewind mode · viewing a past moment" : project?.is_demo === 1 ? "Sample telemetry · refreshed every 5 seconds" : project?.agent_online ? "Agent connected · host readings refresh every 5 seconds" : "Project timeline · waiting for host readings"}
        </p>

        {error && (
          <div className="mb-4 rounded-lg bg-red-900/40 border border-red-700 p-3 text-red-200">
            {error}
          </div>
        )}

        {project?.is_demo === 1 && (
          <ExperimentBench projectId={projectId} />
        )}

        {!loaded && !error && <p className="mb-5 text-sm text-slate-400">Loading project readings…</p>}
        {loaded && !shown && !error && (
          project?.is_demo === 1 ? (
            <section className="mb-6 rounded-2xl border border-dashed border-cyan-200/15 bg-cyan-200/[0.025] p-6 sm:p-8">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-200">Sample project</p>
              <h2 className="mt-2 text-xl font-semibold text-white">Sample readings are starting</h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">The simulator publishes a labeled reading every five seconds. Once the timeline appears, run a controlled scenario above to explore how CloudRewind records incident evidence.</p>
            </section>
          ) : (
            <section className="mb-6 rounded-2xl border border-dashed border-cyan-200/15 bg-cyan-200/[0.025] p-6 sm:p-8">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-200">No agent readings yet</p>
              <h2 className="mt-2 text-xl font-semibold text-white">Connect the machine that runs this service</h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">CloudRewind shows real host metrics after its agent sends the first snapshot. The agent runs on your server or development machine and sends metrics to this backend; it does not upload source code.</p>
              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                {[
                  ["01", "Find the project key", "Use the key shown when you created the project. If it is lost, a workspace admin can rotate it from Projects."],
                  ["02", "Set it as a secret", "Set CLOUDREWIND_KEY in the machine's environment or secret manager."],
                  ["03", "Start the agent", "Open Docs for the Node command and optional application health-check setup."],
                ].map(([number, title, description]) => (
                  <div key={number} className="rounded-xl border border-white/[0.07] bg-slate-950/50 p-4">
                    <p className="text-xs font-semibold text-cyan-200">{number}</p>
                    <h3 className="mt-2 text-sm font-semibold text-slate-200">{title}</h3>
                    <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{description}</p>
                  </div>
                ))}
              </div>
              <div className="mt-5 flex flex-wrap gap-3">
                <Link to="/docs" className="rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200">Open agent setup docs</Link>
                <Link to="/" className="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-white/5 hover:text-white">Back to Projects</Link>
              </div>
              <p className="mt-4 text-xs text-slate-500">AWS CloudWatch is optional and only applies when the monitored host is an EC2 instance. Host-agent monitoring works without AWS.</p>
            </section>
          )
        )}

        {project && project.is_demo !== 1 && (
          <Suspense fallback={<div className="mb-6 rounded-xl border border-slate-700 bg-slate-800 p-4 text-sm text-slate-400">Loading AWS integration…</div>}>
            <AwsCloudWatch
              projectId={projectId}
              selectedTime={selectedTime}
              onRewind={jumpTo}
            />
          </Suspense>
        )}

        {shown && (
          <>
            {/* Timeline scrubber */}
            <div className="mb-6 rounded-xl bg-slate-800 p-4 border border-slate-700">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm text-slate-400">
                  {isRewind ? (
                    <>
                      Snapshot from{" "}
                      <span className="text-cyan-300 font-semibold">{formatTime(shown.timestamp, longRange)}</span>
                    </>
                  ) : (
                    "Drag the slider, or click any chart, to rewind"
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
                value={Math.min(Math.max(selectedTime ?? last, first), last)}
                onChange={(e) => setSelectedTime(Number(e.target.value))}
                className="w-full accent-cyan-400"
              />
              <EventMarkers events={visibleEvents} first={first} last={last} onPick={setSelectedTime} />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>{formatTime(first, longRange)}</span>
                <span>{formatTime(last, longRange)}</span>
              </div>
            </div>

            {/* Metric cards for the live or rewound snapshot */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <MetricCard label="CPU" value={shown.cpu} unit="%" warn={shown.cpu > 80} />
              <MetricCard label="Memory" value={shown.memory} unit="%" warn={shown.memory > 80} />
              {has("db_connected") && (
                <MetricCard
                  label="Database status"
                  value={shown.db_connected == null ? "–" : Number(shown.db_connected) === 1 ? "Connected" : "Disconnected"}
                  warn={shown.db_connected != null && Number(shown.db_connected) === 0}
                />
              )}
              {has("db_connections") && (
                <MetricCard label="DB connections" value={shown.db_connections} unit="" warn={shown.db_connections > 40} />
              )}
              {has("network") && <MetricCard label="Network" value={shown.network} unit="KB/s" />}
            </div>

            {shown.http_ok != null && (
              <div className="mt-4 rounded-xl bg-slate-800 p-4 border border-slate-700">
                <p className="text-sm text-slate-400">Application health probe</p>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <p className={`text-2xl font-bold ${shown.http_ok ? "text-green-400" : "text-red-400"}`}>
                    {shown.http_ok ? "Healthy" : shown.http_status === 0 ? "No response" : "Unhealthy"}
                  </p>
                  <p className="text-sm text-slate-300">
                    {shown.http_status == null ? (shown.http_ok ? "All checks passed in this summary" : "At least one check failed in this summary") : `HTTP ${shown.http_status}`}
                    {shown.response_ms != null && <> · {shortNumber(shown.response_ms)} ms response</>}
                  </p>
                </div>
              </div>
            )}

            {has("containers") && (
              <div className="mt-4 rounded-xl bg-slate-800 p-4 border border-slate-700">
                <p className="text-sm text-slate-400 mb-1">Containers running</p>
                <p className={`text-2xl font-bold ${isDown(shown.containers) ? "text-red-400" : "text-green-400"}`}>
                  {shown.containers ?? "–"}
                </p>
              </div>
            )}

            {/* Chart controls */}
            <div className="mt-8 mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Metrics over time</h2>
              <div className="flex flex-wrap items-center gap-3">
                <ButtonGroup
                  value={rangeMs}
                  onChange={setRangeMs}
                  options={RANGES.map((r) => ({ label: r.label, value: r.ms }))}
                />
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  CPU and memory axis
                  <ButtonGroup
                    value={scaleMode}
                    onChange={setScaleMode}
                    options={[
                      { label: "Auto", value: "auto" },
                      { label: "0–100%", value: "fixed" },
                    ]}
                  />
                </div>
              </div>
            </div>

            {isSummary && (
              <div className="mb-3 rounded-lg border border-cyan-800 bg-cyan-900/20 p-3 text-sm text-cyan-100">
                <span className="font-semibold">Summary view.</span> Part of this range is older than 2 days, so it comes
                from summaries (1-minute and 12-hour). The solid line is the average; the dashed line is the highest
                value in each period, so short spikes are not lost.
              </div>
            )}

            {/* One panel per metric. The lines are always drawn from real data only. */}
            <div className="space-y-4">
              {panels.map((m) => (
                <Suspense key={m.key} fallback={<div className="rounded-xl border border-slate-700 bg-slate-800 p-4 text-sm text-slate-400">Loading chart…</div>}>
                  <MetricPanel
                    metric={m}
                    data={chart.data}
                    gaps={chart.gaps}
                    domain={yDomain(m, chart.data, scaleMode, normalContainers)}
                    ticks={ticks}
                    tickFormatter={tickFormatter}
                    longRange={longRange}
                    events={visibleEvents}
                    selectedTime={selectedTime}
                    nowLabel={isRewind ? "At marker" : "Now"}
                    nowValue={isRewind ? shown?.[m.key] : latest?.[m.key]}
                    onPick={setSelectedTime}
                  />
                </Suspense>
              ))}
            </div>

            <IncidentExplorer key={projectId} projectId={projectId} onJump={jumpTo} />
            <DashboardTools
              projectId={projectId}
              selectedTime={selectedTime}
              latestTime={latest?.timestamp}
              onJump={jumpTo}
            />

            {recent.length > 0 && (
              <>
            <h2 className="mt-8 mb-2 text-lg font-semibold">Recent snapshots</h2>
            <div className="rounded-xl border border-slate-700 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-800 text-slate-400 text-left">
                  <tr>
                    <th className="p-2">Time</th>
                    <th className="p-2">CPU</th>
                    <th className="p-2">Memory</th>
                    <th className="p-2">DB status</th>
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
                        <td className="p-2">{shortNumber(s.cpu)}%</td>
                        <td className="p-2">{shortNumber(s.memory)}%</td>
                        <td className={`p-2 ${s.db_connected == null ? "text-slate-500" : Number(s.db_connected) === 1 ? "text-green-400" : "text-red-400"}`}>
                          {s.db_connected == null ? "–" : Number(s.db_connected) === 1 ? "Connected" : "Disconnected"}
                        </td>
                        <td className="p-2">{s.db_connections ?? "–"}</td>
                        <td
                          className={`p-2 ${
                            s.containers == null ? "text-slate-500" : down ? "text-red-400" : "text-green-400"
                          }`}
                        >
                          {s.containers == null ? "–" : `${s.containers} running${down ? " · below recent high" : ""}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
