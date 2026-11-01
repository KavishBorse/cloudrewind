import { useEffect, useState } from "react";
import api from "./api";

const when = (timestamp) => (timestamp ? new Date(timestamp).toLocaleString() : "—");
const durationLabel = (minutes) => minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;

async function downloadReport(projectId, incidentId) {
  const res = await api.get(`/projects/${projectId}/report`, {
    params: { incident: incidentId },
    responseType: "blob",
  });
  const url = URL.createObjectURL(res.data);
  const link = document.createElement("a");
  link.href = url;
  link.download = `cloudrewind-incident-${incidentId}.md`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function IncidentExplorer({ projectId, onJump }) {
  const [incidents, setIncidents] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [bundle, setBundle] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [groqAvailable, setGroqAvailable] = useState(false);
  const [analysisMode, setAnalysisMode] = useState("summary");
  const [durationChoice, setDurationChoice] = useState("60");
  const [customDuration, setCustomDuration] = useState(120);
  const [confirmGroq, setConfirmGroq] = useState(false);
  const [analysisNotice, setAnalysisNotice] = useState(null);
  const durationMinutes = durationChoice === "custom" ? Number(customDuration) : Number(durationChoice);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await api.get(`/projects/${projectId}/incidents`);
        if (active) {
          setIncidents(res.data);
          setError(null);
        }
      } catch {
        if (active) setError("Could not load incidents.");
      }
    }
    load();
    const timer = setInterval(load, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    api.get(`/projects/${projectId}/narrative-status`)
      .then((res) => { if (active) setGroqAvailable(res.data.groq_available === true); })
      .catch(() => { if (active) setGroqAvailable(false); });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    if (!selectedId) return undefined;
    let active = true;
    async function loadBundle() {
      try {
        const res = await api.get(`/projects/${projectId}/incidents/${selectedId}`);
        if (active) setBundle(res.data);
      } catch {
        if (active) setError("Could not load this incident.");
      }
    }
    loadBundle();
    const timer = setInterval(loadBundle, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId, selectedId]);

  function explain() {
    if (!selectedId) return;
    setError(null);
    setAnalysisNotice(null);
    setConfirmGroq(true);
  }

  async function generateAnalysis() {
    if (!selectedId) return;
    setConfirmGroq(false);
    setBusy(true);
    try {
      const res = await api.post(`/projects/${projectId}/incidents/${selectedId}/narrative`, {
        provider: "groq",
        mode: analysisMode,
        durationMinutes,
        consentToGroq: true,
      });
      setBundle((current) => current && {
        ...current,
        summary_text: res.data.summary,
        summary_source: res.data.source,
        summary_mode: res.data.mode,
        summary_window_minutes: res.data.analysis_window?.duration_minutes ?? null,
        analysis_window: res.data.analysis_window,
        analysis_is_stale: res.data.analysis_is_stale === true,
        possible_causes: res.data.possible_causes || [],
      });
      setAnalysisNotice(res.data.notice || null);
    } catch {
      setError("Could not analyze this time window. Check the backend and Groq configuration, then try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 rounded-xl border border-slate-700 bg-slate-800 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Incidents</h2>
          <p className="text-xs text-slate-400">Rule-based flags link unusual readings to their supporting data.</p>
        </div>
        <span className="rounded-full bg-slate-700 px-3 py-1 text-xs text-slate-300">{incidents.length} recent</span>
      </div>

      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      {incidents.length === 0 ? (
        <p className="mt-4 text-sm text-slate-400">No incidents detected yet. Try one of the demo scenarios below.</p>
      ) : (
        <div className="mt-4 grid gap-3 md:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)]">
          <div className="space-y-2">
            {incidents.map((incident) => (
              <button
                key={incident.id}
                onClick={() => setSelectedId(incident.id)}
                className={`w-full rounded-lg border p-3 text-left ${selectedId === incident.id ? "border-cyan-400 bg-cyan-950/40" : "border-slate-700 bg-slate-900/40 hover:border-slate-500"}`}
              >
                <span className={`mr-2 inline-block rounded px-2 py-0.5 text-[10px] uppercase ${incident.severity === "critical" ? "bg-red-900 text-red-200" : "bg-amber-900 text-amber-200"}`}>
                  {incident.severity}
                </span>
                <span className="text-sm font-medium">{incident.trigger_metric || "System anomaly"}</span>
                <p className="mt-1 text-xs text-slate-400">{when(incident.start_ts)} · {incident.status}</p>
              </button>
            ))}
          </div>

          {bundle && bundle.id === selectedId && (
            <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold">Incident {bundle.id}</h3>
                  <p className="text-xs text-slate-400">{when(bundle.start_ts)} · {bundle.services.join(", ")}</p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <label className="text-[11px] text-slate-400">
                    Analysis
                    <select value={analysisMode} onChange={(event) => setAnalysisMode(event.target.value)} className="ml-1 rounded border border-slate-600 bg-slate-950 px-2 py-1 text-xs text-slate-200">
                      <option value="summary">Summary</option>
                      <option value="likely_cause">Possible causes</option>
                    </select>
                  </label>
                  <label className="text-[11px] text-slate-400">
                    Look back
                    <select value={durationChoice} onChange={(event) => setDurationChoice(event.target.value)} className="ml-1 rounded border border-slate-600 bg-slate-950 px-2 py-1 text-xs text-slate-200">
                      <option value="15">15 minutes</option>
                      <option value="60">1 hour</option>
                      <option value="360">6 hours</option>
                      <option value="1440">24 hours</option>
                      <option value="custom">Custom</option>
                    </select>
                  </label>
                  {durationChoice === "custom" && (
                    <label className="text-[11px] text-slate-400">
                      Minutes
                      <input type="number" min="15" max="10080" step="15" value={customDuration} onChange={(event) => setCustomDuration(event.target.value)} className="ml-1 w-20 rounded border border-slate-600 bg-slate-950 px-2 py-1 text-xs text-slate-200" />
                    </label>
                  )}
                  <button onClick={explain} disabled={busy || !groqAvailable || !Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 10080} className="rounded border border-cyan-700 px-2 py-1 text-xs text-cyan-200 hover:border-cyan-400 disabled:opacity-50">
                    {busy ? "Analyzing…" : groqAvailable ? "Generate with Groq" : "Groq setup needed"}
                  </button>
                  <button onClick={() => downloadReport(projectId, bundle.id).catch(() => setError("Could not download the report."))} className="rounded border border-slate-600 px-2 py-1 text-xs hover:border-cyan-400">
                    Download report
                  </button>
                </div>
              </div>
              {!groqAvailable && <p className="mt-2 text-[11px] text-amber-300">Add GROQ_API_KEY to backend/.env and restart the backend to enable AI analysis.</p>}

              <p className="mt-3 text-sm text-slate-200">{bundle.summary_text}</p>
              <p className="mt-1 text-[11px] text-slate-500">
                {bundle.summary_source === "groq" ? "Groq AI" : "Rule-based summary"}
                {bundle.analysis_window && ` · ${durationLabel(bundle.analysis_window.duration_minutes)} ending ${when(bundle.analysis_window.to)}`}
                {bundle.summary_mode === "likely_cause" && " · possible causes only"}
                {" · Metrics show correlation, not proof of cause."}
              </p>
              {bundle.analysis_is_stale && <p className="mt-2 rounded bg-slate-800 p-2 text-xs text-slate-400">New readings arrived after this analysis. Generate it again to include the latest metrics.</p>}
              {analysisNotice && <p className="mt-2 rounded border border-amber-900 bg-amber-950/30 p-2 text-xs text-amber-200">{analysisNotice}</p>}

              {bundle.summary_mode === "likely_cause" && (
                <div className="mt-4">
                  <h4 className="text-sm font-semibold">Possible contributing factors</h4>
                  {bundle.possible_causes?.length ? (
                    <div className="mt-2 space-y-2">
                      {bundle.possible_causes.map((cause, index) => (
                        <div key={`${index}-${cause.hypothesis}`} className="rounded border border-amber-900/70 bg-amber-950/20 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm text-amber-100">{cause.hypothesis}</p>
                            <span className="rounded bg-slate-800 px-2 py-1 text-[10px] uppercase text-slate-300">{cause.confidence || "low"} confidence</span>
                          </div>
                          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-400">
                            {(cause.evidence || []).map((fact, factIndex) => <li key={`${factIndex}-${fact}`}>{fact}</li>)}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 rounded bg-slate-800 p-2 text-xs text-slate-400">No possible contributor was supported by the selected window. Try a longer lookback or check that metrics were collected.</p>
                  )}
                </div>
              )}

              <h4 className="mt-4 text-sm font-semibold">Evidence sequence</h4>
              <div className="mt-2 space-y-2">
                {bundle.evidence.map((item) => (
                  <div key={`${item.service}-${item.instance || "default"}-${item.metric}`} className="flex flex-wrap items-center justify-between gap-2 rounded bg-slate-800 p-2 text-xs">
                    <span>
                      <span className="font-medium text-slate-100">{item.metric_label}</span>
                      <span className="text-slate-400"> on {item.service}{item.instance && item.instance !== "default" ? ` · ${item.instance}` : ""}: {item.value}{item.peak_value !== item.value ? ` (peak ${item.peak_value})` : ""}</span>
                      <span className="block text-slate-500">{when(item.first_seen_ts)} · {item.rule.replaceAll("_", " ")}</span>
                    </span>
                    <button onClick={() => onJump(item.first_seen_ts, item.service, item.instance)} className="text-cyan-300 hover:underline">View data</button>
                  </div>
                ))}
              </div>

              <h4 className="mt-4 text-sm font-semibold">AWS CloudWatch context</h4>
              {bundle.aws_evidence.length === 0 ? (
                <p className="mt-2 rounded bg-slate-800 p-2 text-xs text-slate-400">No CloudWatch points were synced for this incident window.</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {bundle.aws_evidence.map((item) => (
                    <div key={`${item.region}-${item.instance_id}-${item.metric_name}-${item.timestamp}`} className="flex flex-wrap items-center justify-between gap-2 rounded border border-orange-950/70 bg-slate-800 p-2 text-xs">
                      <span>
                        <span className="font-medium text-orange-100">{item.metric_name}</span>
                        <span className="text-slate-300"> · {item.value} {item.unit} · {item.region}/{item.instance_id}</span>
                        <span className="block text-slate-500">CloudWatch · {when(item.timestamp)} · {item.period_seconds}s {item.statistic}</span>
                        {item.agent_cpu_avg != null && (
                          <span className="block text-cyan-200">Mapped agent CPU: {item.agent_cpu_avg}% average ({item.agent_sample_count} samples) · source gap {item.cpu_gap_points > 0 ? "+" : ""}{item.cpu_gap_points} points</span>
                        )}
                      </span>
                      <button onClick={() => onJump(item.timestamp, item.agent_service, item.agent_instance)} className="text-cyan-300 hover:underline">Rewind</button>
                    </div>
                  ))}
                </div>
              )}

              {bundle.deploy && (
                <p className="mt-3 rounded border border-violet-900 bg-violet-950/30 p-2 text-xs text-violet-200">
                  Nearby deploy: {bundle.deploy.description || "deploy event"} at {when(bundle.deploy.timestamp)}
                </p>
              )}

              {bundle.diff?.changes?.length > 0 && (
                <>
                  <h4 className="mt-4 text-sm font-semibold">Before vs incident</h4>
                  <div className="mt-2 space-y-1">
                    {bundle.diff.changes.map((change) => (
                      <div key={change.metric} className="flex justify-between rounded bg-slate-800 px-2 py-1.5 text-xs">
                        <span className={change.major ? "text-amber-200" : "text-slate-300"}>{change.label}{change.major ? " · major change" : ""}</span>
                        <span className="text-slate-100">{change.before} → {change.after} ({change.delta > 0 ? "+" : ""}{change.delta})</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {bundle.similar_incidents?.length > 0 && (
                <>
                  <h4 className="mt-4 text-sm font-semibold">Earlier incidents with similar signals</h4>
                  <div className="mt-2 space-y-1">
                    {bundle.similar_incidents.map((item) => (
                      <button key={item.id} onClick={() => setSelectedId(item.id)} className="flex w-full justify-between rounded bg-slate-800 px-2 py-1.5 text-left text-xs hover:bg-slate-700">
                        <span>Incident {item.id} · {when(item.start_ts)}</span>
                        <span className="text-cyan-200">{item.similarity}% signal overlap</span>
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-[10px] text-slate-500">Signal overlap is a simple match, not proof that the incidents share a cause.</p>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {confirmGroq && bundle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="groq-consent-title" className="w-full max-w-lg rounded-xl border border-slate-600 bg-slate-900 p-5 shadow-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">External AI processing</p>
            <h3 id="groq-consent-title" className="mt-2 text-lg font-semibold text-slate-100">Send this metric window to Groq?</h3>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              CloudRewind will send incident severity and trigger metric, plus the {durationLabel(durationMinutes)} window ending at {when(bundle.last_flag_ts || bundle.end_ts || bundle.start_ts)}. It includes time-sampled agent readings with metric values, timestamps, anonymized service/host labels, and aggregation details, plus CloudWatch metric names, values, timestamps, periods, units, statistics, and AWS region. Project/account/resource IDs, email, source code, logs, and deployment descriptions are excluded.
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-400">
              Groq says inference data is not retained by default, though reliability or abuse investigations may temporarily retain request content for up to 30 days unless Zero Data Retention is enabled. See the <a href="https://console.groq.com/docs/your-data" target="_blank" rel="noreferrer" className="text-cyan-300 underline">Groq data policy</a>. Possible causes are hypotheses, not confirmed root causes.
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button onClick={() => setConfirmGroq(false)} className="rounded border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:border-slate-400">Cancel</button>
              <button onClick={generateAnalysis} disabled={busy || !Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 10080} className="rounded bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50">Send selected metrics</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
