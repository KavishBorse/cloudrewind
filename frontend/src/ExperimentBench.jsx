import { useEffect, useState } from "react";
import api from "./api";

const SCENARIOS = [
  ["cpu_spike", "CPU spike"],
  ["memory_leak", "Memory leak"],
  ["db_flood", "Database flood"],
  ["container_death", "Container loss"],
  ["bad_deploy", "Bad deploy"],
  ["normal_control", "Normal control"],
];

const when = (timestamp) => (timestamp ? new Date(timestamp).toLocaleString() : "—");

export default function ExperimentBench({ projectId }) {
  const [runs, setRuns] = useState([]);
  const [byScenario, setByScenario] = useState([]);
  const [summary, setSummary] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await api.get(`/projects/${projectId}/experiments`);
        if (!active) return;
        setRuns(res.data.runs);
        setByScenario(res.data.by_scenario);
        setSummary(res.data.summary);
        setError(null);
      } catch {
        if (active) setError("Could not load experiment results.");
      }
    }
    load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId]);

  function exportCsv() {
    const rows = [
      ["run_id", "scenario", "expected_metric", "detector_version", "started_at_iso", "ended_at_iso", "detected", "false_alarm", "detected_at_iso", "outcome_latency_seconds", "incident_id"],
      ...runs.map((run) => [
        run.id,
        run.scenario_type,
        run.expected_metric,
        run.detector_version,
        new Date(run.started_at).toISOString(),
        new Date(run.ends_at).toISOString(),
        run.detected,
        run.false_alarm,
        run.detected_at ? new Date(run.detected_at).toISOString() : "",
        run.detection_latency_seconds ?? "",
        run.incident_id ?? "",
      ]),
    ];
    const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `cloudrewind-scenario-results-${projectId}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function start(type) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await api.post(`/projects/${projectId}/simulate-crash`, { type });
      setMessage(`${type.replaceAll("_", " ")} started · evaluation run ${res.data.scenario_id}`);
    } catch (err) {
      setError(err.response?.data?.error || "Could not start this scenario.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-5 rounded-xl border border-slate-700 bg-slate-800 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Controlled scenario bench</h2>
          <p className="mt-1 max-w-2xl text-xs text-slate-400">
            Run a repeatable fault and record whether the detector found its expected signal and how long it took.
            Results describe this simulator only; they are not production accuracy claims.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {runs.length > 0 && <button onClick={exportCsv} className="rounded border border-slate-600 px-3 py-1.5 text-xs text-cyan-200 hover:border-cyan-400">Export CSV</button>}
          {SCENARIOS.map(([type, label]) => (
            <button key={type} disabled={busy} onClick={() => start(type)} className="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-cyan-400 disabled:opacity-40">
              {label}
            </button>
          ))}
        </div>
      </div>

      {message && <p className="mt-2 text-xs text-cyan-200">{message}</p>}
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <div className="rounded bg-slate-900 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">Positive runs detected</p>
          <p className="mt-1 text-lg font-semibold">{summary ? `${summary.detected_runs}/${summary.positive_runs}` : "—"}</p>
        </div>
        <div className="rounded bg-slate-900 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">Normal control false alarm rate</p>
          <p className="mt-1 text-lg font-semibold">{summary?.false_alarm_rate_percent == null ? "—" : `${summary.false_alarm_rate_percent}%`}</p>
        </div>
        <div className="rounded bg-slate-900 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">Median detection delay</p>
          <p className="mt-1 text-lg font-semibold">{summary?.median_detection_latency_seconds == null ? "—" : `${summary.median_detection_latency_seconds}s`}</p>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded border border-slate-700">
        <table className="w-full min-w-[500px] text-left text-xs">
          <thead className="bg-slate-900 text-slate-400">
            <tr><th className="p-2">Scenario</th><th className="p-2">Outcome / completed</th><th className="p-2">Outcome rate</th><th className="p-2">Median delay</th></tr>
          </thead>
          <tbody>
            {byScenario.map((item) => (
              <tr key={item.scenario_type} className="border-t border-slate-700">
                <td className="p-2">{item.scenario_type.replaceAll("_", " ")}</td>
                <td className="p-2">{item.outcome_count}/{item.completed_runs}</td>
                <td className="p-2">{item.outcome_rate_percent == null ? "—" : `${item.outcome_rate_percent}%`}</td>
                <td className="p-2">{item.median_outcome_latency_seconds == null ? "—" : `${item.median_outcome_latency_seconds}s`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {runs.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded border border-slate-700">
          <table className="w-full min-w-[620px] text-left text-xs">
            <thead className="bg-slate-900 text-slate-400">
              <tr><th className="p-2">Run</th><th className="p-2">Expected signal</th><th className="p-2">Rules</th><th className="p-2">Started</th><th className="p-2">Result</th><th className="p-2">Delay</th></tr>
            </thead>
            <tbody>
              {runs.slice(0, 8).map((run) => (
                <tr key={run.id} className="border-t border-slate-700">
                  <td className="p-2">{run.scenario_type.replaceAll("_", " ")}</td>
                  <td className="p-2">{run.expected_metric === "none" ? "No fault injected" : run.expected_metric.replaceAll("_", " ")}</td>
                  <td className="p-2">{run.detector_version}</td>
                  <td className="p-2 text-slate-400">{when(run.started_at)}</td>
                  <td className={`p-2 ${run.detected || run.false_alarm ? "text-emerald-300" : "text-amber-200"}`}>
                    {!run.completed
                      ? run.detected || run.false_alarm ? `Signal seen · incident ${run.incident_id}` : "Waiting for result"
                      : run.false_alarm ? `False alarm · incident ${run.incident_id}`
                        : run.expected_metric === "none" ? "No false alarm"
                          : run.detected ? `Detected · incident ${run.incident_id}` : "Not detected"}
                  </td>
                  <td className="p-2">{run.detection_latency_seconds == null ? "—" : `${run.detection_latency_seconds}s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!runs.length && <p className="mt-3 text-xs text-slate-500">No controlled scenarios have been run yet. Results will appear here as you trigger scenarios.</p>}
      <p className="mt-2 text-[10px] text-slate-500">Positive runs measure expected-signal detection; normal controls measure any unexpected detector signal. The summary includes completed runs only and excludes the 30-second detection grace period.</p>
    </section>
  );
}
