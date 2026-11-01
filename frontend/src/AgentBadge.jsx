// Small status label for a project: simulated, waiting, online, or offline since a time

function formatSince(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString() : d.toLocaleString();
}

export default function AgentBadge({ project }) {
  const base = "inline-flex items-center gap-1.5 text-xs rounded-full px-2.5 py-0.5";

  if (project.is_demo === 1) {
    return <span className={`${base} bg-cyan-900/50 text-cyan-300`}>Simulated data</span>;
  }
  if (project.agent_online) {
    return (
      <span className={`${base} bg-green-900/40 text-green-300`}>
        <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
        Agent online
      </span>
    );
  }
  if (project.last_seen_at) {
    return (
      <span className={`${base} bg-red-900/40 text-red-300`}>
        <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
        Agent offline since {formatSince(project.last_seen_at)}
      </span>
    );
  }
  return <span className={`${base} bg-slate-700 text-slate-300`}>Waiting for the agent</span>;
}
