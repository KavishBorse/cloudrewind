import { useEffect, useState } from "react";
import api from "./api";

const PAGE_SIZE = 50;
const RANGE_OPTIONS = [
  { label: "Last hour", value: 60 * 60 * 1000 },
  { label: "24 hours", value: 24 * 60 * 60 * 1000 },
  { label: "7 days", value: 7 * 24 * 60 * 60 * 1000 },
  { label: "30 days", value: 30 * 24 * 60 * 60 * 1000 },
  { label: "All retained", value: "all" },
];

const valueOrDash = (value, suffix = "") => (value == null ? "–" : `${Math.round(Number(value) * 10) / 10}${suffix}`);
const rangeValue = (value) => (value == null ? "–" : `${valueOrDash(value)}%`);

function resolutionLabel(row) {
  if (!row.summary) return "Raw reading";
  const seconds = Number(row.bucket_seconds);
  if (seconds === 60) return "1-minute rollup";
  if (seconds === 43200) return "12-hour rollup";
  return `${seconds >= 3600 ? `${seconds / 3600}h` : `${seconds}s`} rollup`;
}

export default function SnapshotHistory({ open, onClose, projectId, service, instance }) {
  const [range, setRange] = useState("all");
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState({ rows: [], total: 0, has_more: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setLoading(true);
    setError(null);
    const rangeMs = RANGE_OPTIONS.find((option) => String(option.value) === range)?.value ?? "all";
    const params = {
      page,
      limit: PAGE_SIZE,
      service,
      instance,
      to: Date.now(),
      ...(rangeMs === "all" ? {} : { from: Date.now() - rangeMs }),
    };
    api.get(`/projects/${projectId}/history`, { params })
      .then((response) => {
        if (active) setResult(response.data);
      })
      .catch(() => {
        if (active) setError("Could not load the telemetry history. Please retry.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [open, projectId, service, instance, range, page, reload]);

  if (!open) return null;
  const pageCount = Math.max(1, Math.ceil(result.total / PAGE_SIZE));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-6"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="snapshot-history-title"
        className="flex max-h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-[#45483d] bg-[#171914] shadow-2xl"
      >
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[#34372f] p-5 sm:p-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-200">Telemetry archive</p>
            <h2 id="snapshot-history-title" className="mt-1 text-xl font-semibold text-slate-100">Application history</h2>
            <p className="mt-1 text-sm text-slate-400">
              {service} · {instance} · {result.total.toLocaleString()} retained records
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300 hover:bg-white/5" aria-label="Close history">
            Close
          </button>
        </header>

        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#34372f] px-5 py-3 sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-400">
              Period
              <select
                value={range}
                onChange={(event) => { setRange(event.target.value); setPage(1); }}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100"
              >
                {RANGE_OPTIONS.map((option) => <option key={option.label} value={String(option.value)}>{option.label}</option>)}
              </select>
            </label>
            <span className="max-w-2xl text-xs text-slate-500">
              Newest first. Exact raw samples are kept for 48 hours; older history is shown as 1-minute and 12-hour rollups. Incident and bookmark windows may stay raw longer.
            </span>
          </div>
          <button
            onClick={() => setReload((value) => value + 1)}
            disabled={loading}
            className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-200 hover:bg-white/5 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        {error && <p role="alert" className="mx-5 mt-4 rounded-lg border border-red-800 bg-red-950/40 p-3 text-sm text-red-200 sm:mx-6">{error}</p>}

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="min-w-[1450px] w-full text-left text-xs sm:text-sm">
            <thead className="sticky top-0 z-10 bg-[#26291f] text-slate-300">
              <tr>
                {["Time", "Record type", "CPU", "CPU min / max", "Memory", "Memory min / max", "DB status", "DB conn", "Containers", "Network KB/s", "HTTP", "Latency ms", "Samples"].map((label) => (
                  <th key={label} className="whitespace-nowrap px-3 py-3 font-medium">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!loading && result.rows.map((row) => (
                <tr key={`${row.kind}-${row.record_id}`} className="border-t border-[#2b2e26] text-slate-200 hover:bg-white/[0.025]">
                  <td className="whitespace-nowrap px-3 py-3">{new Date(row.timestamp).toLocaleString()}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-400">{resolutionLabel(row)}</td>
                  <td className="px-3 py-3">{rangeValue(row.cpu)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-400">{row.summary ? `${rangeValue(row.cpu_min)} / ${rangeValue(row.cpu_max)}` : "–"}</td>
                  <td className="px-3 py-3">{rangeValue(row.memory)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-400">{row.summary ? `${rangeValue(row.memory_min)} / ${rangeValue(row.memory_max)}` : "–"}</td>
                  <td className={`whitespace-nowrap px-3 py-3 ${row.db_connected == null ? "text-slate-500" : Number(row.db_connected) === 1 ? "text-green-400" : "text-red-400"}`}>
                    {row.db_connected == null ? "–" : Number(row.db_connected) === 1 ? "Connected" : "Disconnected"}
                  </td>
                  <td className="px-3 py-3">{row.db_connections ?? "–"}</td>
                  <td className="px-3 py-3">{row.containers ?? "–"}</td>
                  <td className="px-3 py-3">{valueOrDash(row.network)}</td>
                  <td className="px-3 py-3">{row.http_status ?? (row.http_ok == null ? "–" : Number(row.http_ok) === 1 ? "OK" : "Failed")}</td>
                  <td className="px-3 py-3">{valueOrDash(row.response_ms)}</td>
                  <td className="px-3 py-3">{Number(row.sample_count || 1).toLocaleString()}</td>
                </tr>
              ))}
              {!loading && !error && result.rows.length === 0 && (
                <tr><td colSpan={13} className="px-4 py-12 text-center text-slate-500">No telemetry records in this period.</td></tr>
              )}
              {loading && (
                <tr><td colSpan={13} className="px-4 py-12 text-center text-slate-400">Loading history…</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[#34372f] p-4 sm:px-6">
          <p className="text-sm text-slate-400">
            {result.total === 0 ? "No records" : `Page ${page} of ${pageCount} · showing ${Math.min(PAGE_SIZE, result.total)} per page`}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1 || loading}
              className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-200 hover:bg-white/5 disabled:opacity-40"
            >Previous</button>
            <button
              onClick={() => setPage((current) => current + 1)}
              disabled={!result.has_more || loading}
              className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-200 hover:bg-white/5 disabled:opacity-40"
            >Next</button>
          </div>
        </footer>
      </section>
    </div>
  );
}
