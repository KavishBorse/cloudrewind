import { useEffect, useState } from "react";
import api from "./api";

const when = (timestamp) => (timestamp ? new Date(timestamp).toLocaleString() : "—");
const streamKey = (service, instance) => `${service}:${instance}`;

export default function DashboardTools({ projectId, selectedTime, latestTime, onJump }) {
  const [services, setServices] = useState([]);
  const [selectedStream, setSelectedStream] = useState("main:default");
  const [service, instance] = selectedStream.split(":");
  const [atTime, setAtTime] = useState([]);
  const [bookmarks, setBookmarks] = useState([]);
  const [note, setNote] = useState("");
  const [points, setPoints] = useState({ a: null, b: null });
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function loadBookmarks() {
    try {
      const res = await api.get(`/projects/${projectId}/bookmarks`);
      setBookmarks(res.data);
    } catch {
      setError("Could not load bookmarks.");
    }
  }

  useEffect(() => {
    let active = true;
    async function loadServices() {
      try {
        const res = await api.get(`/projects/${projectId}/services`);
        if (!active) return;
        setServices(res.data);
        const keys = res.data.map((item) => streamKey(item.service, item.instance));
        setSelectedStream((current) => keys.length && !keys.includes(current) ? keys[0] : current);
      } catch {
        if (active) setError("Could not load project services.");
      }
    }
    async function loadBookmarks() {
      try {
        const res = await api.get(`/projects/${projectId}/bookmarks`);
        if (active) setBookmarks(res.data);
      } catch {
        if (active) setError("Could not load bookmarks.");
      }
    }
    loadServices();
    loadBookmarks();
    const timer = setInterval(loadServices, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId]);

  const cursor = selectedTime ?? latestTime;
  useEffect(() => {
    if (!cursor) return undefined;
    let active = true;
    api
      .get(`/projects/${projectId}/services-at`, { params: { time: cursor } })
      .then((res) => active && setAtTime(res.data.filter((item) => item.snapshot)))
      .catch(() => active && setAtTime([]));
    return () => {
      active = false;
    };
  }, [projectId, cursor]);

  function setPoint(which) {
    if (!selectedTime) return;
    setPoints((current) => ({ ...current, [which]: selectedTime }));
    setDiff(null);
  }

  async function compare() {
    if (!points.a || !points.b || points.a === points.b) return;
    setBusy(true);
    setError(null);
    try {
      const [from, to] = [points.a, points.b].sort((a, b) => a - b);
      const res = await api.get(`/projects/${projectId}/diff`, { params: { from, to, service, instance } });
      setDiff(res.data);
    } catch (err) {
      setError(err.response?.data?.error || "Could not compare these moments.");
    } finally {
      setBusy(false);
    }
  }

  async function addBookmark() {
    const timestamp = selectedTime ?? latestTime;
    if (!timestamp) return;
    setError(null);
    try {
      await api.post(`/projects/${projectId}/bookmarks`, { timestamp, note });
      setNote("");
      await loadBookmarks();
    } catch (err) {
      setError(err.response?.data?.error || "Could not save the bookmark.");
    }
  }

  async function removeBookmark(id) {
    try {
      await api.delete(`/projects/${projectId}/bookmarks/${id}`);
      setBookmarks((current) => current.filter((bookmark) => bookmark.id !== id));
    } catch {
      setError("Could not remove the bookmark.");
    }
  }

  return (
    <section className="mt-8 grid gap-4 lg:grid-cols-2">
      <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
        <h2 className="text-lg font-semibold">Compare two moments</h2>
        <p className="mt-1 text-xs text-slate-400">Rewind the timeline to each moment, then save it as A or B.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <button disabled={!selectedTime} onClick={() => setPoint("a")} className="rounded border border-slate-600 px-3 py-1 disabled:opacity-40">Set A</button>
          <span className="text-slate-400">{when(points.a)}</span>
          <button disabled={!selectedTime} onClick={() => setPoint("b")} className="ml-2 rounded border border-slate-600 px-3 py-1 disabled:opacity-40">Set B</button>
          <span className="text-slate-400">{when(points.b)}</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="text-xs text-slate-400" htmlFor="diff-service">Service</label>
          <select id="diff-service" value={selectedStream} onChange={(event) => setSelectedStream(event.target.value)} className="rounded bg-slate-900 px-2 py-1 text-sm">
            {services.map((item) => (
              <option key={streamKey(item.service, item.instance)} value={streamKey(item.service, item.instance)}>
                {item.instance === "default" ? item.service : `${item.service} · ${item.instance}`}
              </option>
            ))}
          </select>
          <button onClick={compare} disabled={busy || !points.a || !points.b || points.a === points.b} className="rounded bg-cyan-500 px-3 py-1 text-sm font-semibold text-slate-900 disabled:opacity-40">
            {busy ? "Comparing…" : "Compare"}
          </button>
          <button onClick={() => { setPoints({ a: null, b: null }); setDiff(null); }} className="text-xs text-slate-400 hover:text-white">Clear</button>
        </div>
        {diff && (
          <div className="mt-4 space-y-1">
            {diff.changes.map((change) => (
              <div key={change.metric} className="flex justify-between rounded bg-slate-900 px-2 py-1.5 text-xs">
                <span className={change.major ? "text-amber-200" : "text-slate-300"}>{change.label}{change.major ? " · major" : ""}</span>
                <span>{change.before} → {change.after} ({change.delta > 0 ? "+" : ""}{change.delta})</span>
              </div>
            ))}
            {!diff.changes.length && <p className="text-xs text-slate-400">No comparable measurements in those snapshots.</p>}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
        <h2 className="text-lg font-semibold">Bookmarks</h2>
        <p className="mt-1 text-xs text-slate-400">Save a point in the timeline with a short note.</p>
        <div className="mt-3 flex gap-2">
          <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} placeholder="Optional note" className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm" />
          <button onClick={addBookmark} disabled={!cursor} className="rounded bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-900 disabled:opacity-40">Bookmark {selectedTime ? "moment" : "now"}</button>
        </div>
        <div className="mt-3 max-h-44 space-y-2 overflow-auto">
          {bookmarks.map((bookmark) => (
            <div key={bookmark.id} className="flex items-center justify-between gap-2 rounded bg-slate-900 px-3 py-2 text-xs">
              <button onClick={() => onJump(bookmark.timestamp)} className="min-w-0 text-left hover:text-cyan-300">
                <span className="block text-slate-200">{bookmark.note || "Saved moment"}</span>
                <span className="text-slate-500">{when(bookmark.timestamp)}</span>
              </button>
              <button onClick={() => removeBookmark(bookmark.id)} aria-label="Delete bookmark" className="text-slate-500 hover:text-red-300">Remove</button>
            </div>
          ))}
          {bookmarks.length === 0 && <p className="text-xs text-slate-500">No bookmarks saved.</p>}
        </div>
      </div>

      {error && <p className="text-sm text-red-300 lg:col-span-2">{error}</p>}

      {cursor && atTime.length > 1 && (
        <div className="rounded-xl border border-slate-700 bg-slate-800 p-4 lg:col-span-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">Services at the same moment</h2>
            <span className="text-xs text-slate-400">{when(cursor)}</span>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {atTime.map(({ service: serviceName, instance: instanceName, snapshot }) => (
              <button key={streamKey(serviceName, instanceName)} onClick={() => onJump(snapshot.timestamp, serviceName, instanceName)} className="rounded-lg border border-slate-700 bg-slate-900 p-3 text-left hover:border-cyan-500">
                <p className="font-semibold text-cyan-200">{serviceName}{instanceName !== "default" ? ` · ${instanceName}` : ""}</p>
                <p className="mt-1 text-xs text-slate-300">CPU {snapshot.cpu ?? "—"}% · Memory {snapshot.memory ?? "—"}%</p>
                <p className="text-xs text-slate-400">DB {snapshot.db_connected == null ? "—" : Number(snapshot.db_connected) === 1 ? "connected" : "disconnected"} · {snapshot.db_connections ?? "—"} connections · Containers {snapshot.containers ?? "—"}</p>
                {snapshot.timestamp !== cursor && <p className="mt-1 text-[10px] text-slate-500">Nearest reading {when(snapshot.timestamp)}</p>}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
