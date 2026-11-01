import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import api from "./api";

const LOOKBACK_MS = 6 * 60 * 60 * 1000;
const BUCKET_MS = 5 * 60 * 1000;
function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function latestMetric(points, name) {
  return [...points].reverse().find((point) => point.metric_name === name);
}

function Metric({ label, value, unit, alert = false }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/70 p-3">
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${alert ? "text-red-300" : "text-slate-100"}`}>
        {value == null ? "No sample" : value}
        {value != null && <span className="ml-1 text-xs font-normal text-slate-400">{unit}</span>}
      </p>
    </div>
  );
}

export default function AwsCloudWatch({ projectId, selectedTime, onRewind }) {
  const [connection, setConnection] = useState(null);
  const [form, setForm] = useState({ region: "us-east-1", instance_id: "", agent_service: "main", agent_instance: "default", role_arn: "" });
  const [agentStreams, setAgentStreams] = useState([]);
  const [mappedSnapshots, setMappedSnapshots] = useState([]);
  const [points, setPoints] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState(null);

  const streamKey = (service, instance) => `${service}:${instance}`;

  function setConnectionForm(value) {
    setForm({
      region: value.region,
      instance_id: value.instance_id,
      agent_service: value.agent_service || "main",
      agent_instance: value.agent_instance || "default",
      role_arn: value.role_arn || "",
    });
  }

  async function loadConnection() {
    const response = await api.get(`/projects/${projectId}/aws/connection`);
    setConnection(response.data);
    if (response.data.configured) setConnectionForm(response.data);
    return response.data;
  }

  async function loadMetrics(instanceId = connection?.instance_id) {
    if (!instanceId) {
      setPoints([]);
      return;
    }
    const response = await api.get(`/projects/${projectId}/aws/metrics`, {
      params: { from: Date.now() - LOOKBACK_MS, to: Date.now() },
    });
    setPoints(response.data.points);
  }

  async function loadMappedSnapshots(target) {
    if (!target?.agent_service || !target?.agent_instance) {
      setMappedSnapshots([]);
      return;
    }
    const response = await api.get(`/projects/${projectId}/snapshots`, {
      params: {
        from: Date.now() - LOOKBACK_MS,
        limit: 1200,
        service: target.agent_service,
        instance: target.agent_instance,
      },
    });
    setMappedSnapshots(response.data.filter((sample) => !sample.summary));
  }

  useEffect(() => {
    let active = true;
    async function initialize() {
      setLoading(true);
      try {
        const [response, serviceResponse] = await Promise.all([
          api.get(`/projects/${projectId}/aws/connection`),
          api.get(`/projects/${projectId}/services`).catch(() => ({ data: [] })),
        ]);
        if (!active) return;
        setConnection(response.data);
        setAgentStreams(serviceResponse.data);
        if (response.data.configured) {
          setConnectionForm(response.data);
          const [metrics, agentData] = await Promise.all([
            api.get(`/projects/${projectId}/aws/metrics`, { params: { from: Date.now() - LOOKBACK_MS, to: Date.now() } }),
            api.get(`/projects/${projectId}/snapshots`, {
              params: { from: Date.now() - LOOKBACK_MS, limit: 1200, service: response.data.agent_service, instance: response.data.agent_instance },
            }),
          ]);
          if (active) {
            setPoints(metrics.data.points);
            setMappedSnapshots(agentData.data.filter((sample) => !sample.summary));
          }
        } else if (serviceResponse.data.length) {
          setForm((current) => ({
            ...current,
            agent_service: serviceResponse.data[0].service,
            agent_instance: serviceResponse.data[0].instance,
          }));
        }
      } catch {
        if (active) setError("Could not load the AWS connection settings.");
      } finally {
        if (active) setLoading(false);
      }
    }
    initialize();
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    if (!connection?.configured) return undefined;
    const timer = setInterval(async () => {
      try {
        const response = await api.get(`/projects/${projectId}/snapshots`, {
          params: {
            from: Date.now() - LOOKBACK_MS,
            limit: 1200,
            service: connection.agent_service,
            instance: connection.agent_instance,
          },
        });
        setMappedSnapshots(response.data.filter((sample) => !sample.summary));
      } catch {
        // AWS metrics remain visible if the mapped agent stream is temporarily unavailable.
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [projectId, connection?.configured, connection?.agent_service, connection?.agent_instance]);

  const cpuComparison = useMemo(() => {
    const awsCpu = points.filter((point) => point.metric_name === "CPUUtilization");
    return awsCpu.map((point) => {
      // CloudWatch timestamps a 5-minute statistic at the start of its bucket.
      // Average the agent samples from that same bucket before comparing sources.
      const samples = mappedSnapshots.filter((sample) =>
        sample.timestamp >= point.timestamp && sample.timestamp < point.timestamp + BUCKET_MS && sample.cpu != null
      );
      return {
        timestamp: point.timestamp,
        awsCpu: Math.round(point.value * 10) / 10,
        agentCpu: samples.length
          ? Math.round((samples.reduce((sum, sample) => sum + sample.cpu, 0) / samples.length) * 10) / 10
          : null,
        agentSamples: samples.length,
      };
    });
  }, [points, mappedSnapshots]);
  const awsAtRewind = useMemo(() => selectedTime == null ? [] : points.filter((point) =>
    selectedTime >= point.timestamp && selectedTime < point.timestamp + point.period_seconds * 1000
  ), [points, selectedTime]);

  async function saveConnection(event) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      const response = await api.put(`/projects/${projectId}/aws/connection`, form);
      setConnection(response.data);
      setConnectionForm(response.data);
      setPoints([]);
      await loadMappedSnapshots(response.data);
      setEditing(false);
      setNotice("EC2 target and matching agent stream saved. Sync to read CloudWatch metrics.");
    } catch (err) {
      setError(err.response?.data?.error || "Could not save the AWS connection.");
    } finally {
      setSaving(false);
    }
  }

  async function syncMetrics() {
    setError(null);
    setNotice(null);
    setSyncing(true);
    try {
      const response = await api.post(`/projects/${projectId}/aws/sync`);
      const current = await loadConnection();
      await Promise.all([loadMetrics(current.instance_id), loadMappedSnapshots(current)]);
      setNotice(`Synced ${response.data.points_saved} CloudWatch data points. AWS reads use 5-minute periods.`);
    } catch (err) {
      setError(err.response?.data?.error || "Could not sync CloudWatch metrics.");
    } finally {
      setSyncing(false);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect this EC2 instance from the project?")) return;
    try {
      await api.delete(`/projects/${projectId}/aws/connection`);
      setConnection({ configured: false });
      setPoints([]);
      setNotice("AWS instance disconnected. Previously collected metrics remain in this project database.");
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || "Could not disconnect the AWS instance.");
    }
  }

  function connectionForm() {
    const currentStream = streamKey(form.agent_service, form.agent_instance);
    const discovered = agentStreams.some((stream) => streamKey(stream.service, stream.instance) === currentStream);
    return (
      <form onSubmit={saveConnection} className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="text-xs text-slate-400">
          AWS region
          <input required value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })} placeholder="us-east-1" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100" />
        </label>
        <label className="text-xs text-slate-400">
          EC2 instance ID
          <input required value={form.instance_id} onChange={(event) => setForm({ ...form, instance_id: event.target.value })} placeholder="i-0123456789abcdef0" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100" />
        </label>
        <label className="text-xs text-slate-400 md:col-span-2">
          Optional AWS IAM role ARN
          <input value={form.role_arn} onChange={(event) => setForm({ ...form, role_arn: event.target.value })} placeholder="arn:aws:iam::123456789012:role/CloudRewindReadOnly" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100" />
          <span className="mt-1 block text-[11px] text-slate-500">Leave blank to use the backend’s AWS profile or attached IAM role. Add a role ARN for STS AssumeRole access; the backend identity must be allowed by that role’s trust policy.</span>
        </label>
        <label className="text-xs text-slate-400 md:col-span-2">
          Agent stream running on this EC2 instance
          {agentStreams.length > 0 ? (
            <select required value={currentStream} onChange={(event) => {
              const [agent_service, agent_instance] = event.target.value.split(":");
              setForm({ ...form, agent_service, agent_instance });
            }} className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100">
              {!discovered && <option value={currentStream}>{form.agent_service} · {form.agent_instance} (not currently reporting)</option>}
              {agentStreams.map((stream) => (
                <option key={streamKey(stream.service, stream.instance)} value={streamKey(stream.service, stream.instance)}>
                  {stream.service} · {stream.instance}
                </option>
              ))}
            </select>
          ) : (
            <span className="mt-1 grid gap-2 sm:grid-cols-2">
              <input required value={form.agent_service} onChange={(event) => setForm({ ...form, agent_service: event.target.value })} placeholder="Agent service (main)" className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100" />
              <input required value={form.agent_instance} onChange={(event) => setForm({ ...form, agent_instance: event.target.value })} placeholder="Agent host (hostname)" className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100" />
            </span>
          )}
          <span className="mt-1 block text-[11px] text-slate-500">Choose the agent stream on the same EC2 machine so the CPU comparison uses the right host.</span>
        </label>
        <button type="submit" disabled={saving || loading} className="justify-self-start rounded-lg border border-orange-700 px-4 py-2 text-sm font-semibold text-orange-200 hover:bg-orange-950/40 disabled:opacity-50">
          {saving ? "Saving…" : connection?.configured ? "Save AWS mapping" : "Save instance"}
        </button>
      </form>
    );
  }

  const latestCpu = latestMetric(points, "CPUUtilization");
  const latestIn = latestMetric(points, "NetworkIn");
  const latestOut = latestMetric(points, "NetworkOut");
  const latestStatus = latestMetric(points, "StatusCheckFailed");
  const rewindCpu = awsAtRewind.find((point) => point.metric_name === "CPUUtilization");
  const rewindStatus = awsAtRewind.find((point) => point.metric_name === "StatusCheckFailed");
  const comparableBuckets = cpuComparison.filter((point) => point.agentSamples > 0);
  const largestCpuGap = comparableBuckets.reduce((largest, point) => {
    const gap = Math.abs(point.awsCpu - point.agentCpu);
    return gap > (largest?.gap ?? -1) ? { ...point, gap } : largest;
  }, null);

  return (
    <section className="mb-6 rounded-xl border border-orange-900/70 bg-slate-800 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-orange-700/70 bg-orange-950/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-200">
              AWS CloudWatch
            </span>
            {connection?.configured && <span className="text-xs text-slate-400">EC2 · {connection.instance_id} · Agent · {connection.agent_service}/{connection.agent_instance}</span>}
          </div>
          <h2 className="mt-2 text-lg font-semibold">Cloud and host evidence</h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            CloudWatch reports EC2-level CPU, network totals, and AWS status checks. The agent separately reports guest memory and application health.
          </p>
        </div>
        {connection?.configured && (
          <button onClick={syncMetrics} disabled={syncing} className="rounded-lg bg-orange-400 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-orange-300 disabled:opacity-50">
            {syncing ? "Syncing…" : "Sync CloudWatch"}
          </button>
        )}
      </div>

      {error && <div className="mt-3 rounded-lg border border-red-700 bg-red-950/40 p-3 text-sm text-red-200">{error}</div>}
      {notice && <div className="mt-3 rounded-lg border border-emerald-800 bg-emerald-950/30 p-3 text-sm text-emerald-200">{notice}</div>}

      {(!connection?.configured || connection == null) && connectionForm()}

      {connection?.configured && (
        <div className="mt-4">
          <button onClick={() => setEditing((current) => !current)} className="mb-3 text-xs text-orange-200 underline decoration-orange-800 underline-offset-2">
            {editing ? "Close AWS mapping" : "Edit AWS target or agent mapping"}
          </button>
          {editing && connectionForm()}
          {connection.role_arn && (
            <div className="mb-3 rounded-lg border border-slate-700 bg-slate-900/50 p-3 text-xs text-slate-300">
              <p>Cross-account role: <span className="font-mono text-orange-200">{connection.role_arn}</span></p>
              <p className="mt-1">Add this External ID condition to the role trust policy: <span className="break-all font-mono text-orange-200">{connection.external_id}</span></p>
              <p className="mt-1 text-slate-500">CloudRewind stores no AWS access keys. STS issues short-lived credentials for each sync.</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="AWS CPU · 5-min avg" value={latestCpu ? Math.round(latestCpu.value * 10) / 10 : null} unit="%" />
            <Metric label="Network in · per second" value={latestIn ? Math.round((latestIn.value / latestIn.period_seconds / 1024) * 10) / 10 : null} unit="KB/s" />
            <Metric label="Network out · per second" value={latestOut ? Math.round((latestOut.value / latestOut.period_seconds / 1024) * 10) / 10 : null} unit="KB/s" />
            <Metric label="AWS status check" value={latestStatus ? (latestStatus.value === 0 ? "Passed" : "Failed") : null} unit="" alert={latestStatus?.value > 0} />
          </div>

          {selectedTime != null && (
            <div className="mt-3 rounded-lg border border-orange-900/60 bg-orange-950/20 p-3 text-sm">
              <p className="font-medium text-orange-100">CloudWatch evidence at the rewound moment</p>
              {awsAtRewind.length ? (
                <p className="mt-1 text-xs text-slate-300">
                  EC2 CPU average: {rewindCpu ? `${Math.round(rewindCpu.value * 10) / 10}%` : "no sample"}
                  {rewindStatus && <> · AWS status check: {rewindStatus.value === 0 ? "passed" : "failed"}</>}
                  {" · "}{new Date(awsAtRewind[0].timestamp).toLocaleString()} period
                </p>
              ) : (
                <p className="mt-1 text-xs text-slate-400">No stored CloudWatch sample covers this time. Sync imports the most recent six hours.</p>
              )}
            </div>
          )}

          {comparableBuckets.length > 0 && (
            <div className="mt-4 rounded-lg border border-slate-700 bg-slate-900/50 p-3">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-slate-200">EC2 CPU and agent CPU</p>
                <p className="text-xs text-slate-500">Same 5-minute buckets · different measurement layers</p>
              </div>
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={cpuComparison}
                    margin={{ top: 8, right: 10, bottom: 4, left: 0 }}
                    onClick={(state) => {
                      const index = Number(state?.activeTooltipIndex);
                      const point = Number.isInteger(index) ? cpuComparison[index] : null;
                      if (point) onRewind?.(point.timestamp + BUCKET_MS / 2, connection.agent_service, connection.agent_instance);
                    }}
                    style={{ cursor: "crosshair" }}
                  >
                    <CartesianGrid stroke="#334155" strokeDasharray="3 3" />
                    <XAxis dataKey="timestamp" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={formatTime} stroke="#94a3b8" fontSize={11} />
                    <YAxis domain={[0, 100]} tickFormatter={(value) => `${value}%`} stroke="#94a3b8" fontSize={11} width={42} />
                    <Tooltip labelFormatter={(value) => new Date(value).toLocaleString()} formatter={(value, name) => [`${value}%`, name]} contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8 }} />
                    <Legend />
                    <Line name="CloudWatch EC2 CPU" type="monotone" dataKey="awsCpu" stroke="#fb923c" strokeWidth={2} dot={false} />
                    <Line name="Agent host CPU avg" type="monotone" dataKey="agentCpu" stroke="#22d3ee" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                A gap is evidence to inspect, not proof of a cause. CloudWatch includes EC2-level CPU time; the agent measures from inside the operating system.
              </p>
              <p className="mt-1 text-xs text-slate-500">Click the chart to rewind the agent timeline to that AWS 5-minute bucket.</p>
              {largestCpuGap && (
                <p className="mt-2 rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300">
                  Largest observed source gap in the loaded window: <span className="font-semibold text-orange-200">{Math.round(largestCpuGap.gap * 10) / 10} percentage points</span> at {new Date(largestCpuGap.timestamp).toLocaleString()}.
                </p>
              )}
            </div>
          )}
          {points.some((point) => point.metric_name === "CPUUtilization") && mappedSnapshots.length === 0 && (
            <p className="mt-3 rounded-lg border border-slate-700 bg-slate-900/40 p-3 text-xs text-slate-400">
              The CloudWatch CPU history is loaded. The comparison will appear after the mapped agent stream ({connection.agent_service}/{connection.agent_instance}) has readings in the same time buckets.
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>{connection.last_synced_at ? `Last successful sync ${new Date(connection.last_synced_at).toLocaleString()}` : "Not synced yet"}</span>
            <div className="flex items-center gap-3">
              <span>{points.length} readings stored locally</span>
              <button onClick={disconnect} className="text-slate-400 underline decoration-slate-600 underline-offset-2 hover:text-red-300">Disconnect</button>
            </div>
          </div>
          <details className="mt-3 text-xs text-slate-400">
            <summary className="cursor-pointer">AWS access and cost notes</summary>
            <p className="mt-2 max-w-3xl leading-relaxed">
              {connection.role_arn ? "The backend assumes the configured role with STS and short-lived credentials. The role trust policy must allow the backend identity and require the displayed External ID." : "The backend uses its AWS SDK identity (a local AWS profile during development, or an attached IAM role when deployed)."} It does not store AWS access keys. The required CloudWatch read action cannot be scoped to a single instance in IAM, so it can read metric statistics across the connected account even though CloudRewind requests only this EC2 instance. Sync is manual and rate-limited; it requests four metrics using basic 5-minute periods. AWS may charge for CloudWatch API usage beyond applicable free allowances, so check your account's billing page.
            </p>
          </details>
        </div>
      )}

      {!connection?.configured && !loading && (
        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          AWS setup can wait until you have an EC2 instance. Later, the backend can use its own AWS identity or assume a read-only role in the account you connect. No AWS credentials go in the browser; metrics are fetched only when you choose Sync.
        </p>
      )}
    </section>
  );
}
