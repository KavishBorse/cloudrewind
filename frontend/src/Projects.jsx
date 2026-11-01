import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api, { API_BASE_URL } from "./api";
import AgentBadge from "./AgentBadge";
import { useWorkspace } from "./useWorkspace";

const BACKEND_URL = API_BASE_URL;
const LOCAL_BACKEND = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(BACKEND_URL);

export default function Projects() {
  const { currentWorkspace } = useWorkspace();
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [name, setName] = useState("");
  const [environment, setEnvironment] = useState("production");
  const [creating, setCreating] = useState(false);
  const [creatingSample, setCreatingSample] = useState(false);
  const [shownKey, setShownKey] = useState(null); // { projectName, apiKey }, shown only once
  const [copied, setCopied] = useState(false);

  async function loadProjects() {
    try {
      const res = await api.get("/projects");
      setProjects(res.data);
      setLoadError(null);
    } catch {
      setLoadError("Cannot load your projects. Is the backend running?");
    }
  }

  // Load now, then refresh every 10 seconds so the agent status stays current
  useEffect(() => {
    const initialLoad = setTimeout(loadProjects, 0);
    const id = setInterval(loadProjects, 10000);
    return () => {
      clearTimeout(initialLoad);
      clearInterval(id);
    };
  }, [currentWorkspace?.id]);

  function showError(err, fallback) {
    setNotice(null);
    setError(err.response?.data?.error || fallback);
  }

  function revealKey(projectName, apiKey, projectEnvironment = "production") {
    setShownKey({ projectName, apiKey, environment: projectEnvironment });
    setCopied(false);
  }

  async function createProject(e) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const res = await api.post("/projects", { name, environment });
      revealKey(res.data.project.name, res.data.apiKey, res.data.project.environment);
      setName("");
      setEnvironment("production");
      await loadProjects();
    } catch (err) {
      showError(err, "Could not create the project.");
    } finally {
      setCreating(false);
    }
  }

  async function createSampleProject() {
    setCreatingSample(true);
    setError(null);
    setNotice(null);
    try {
      await api.post("/projects/demo");
      await loadProjects();
      setNotice("Sample project created. Its telemetry is simulated and stays separate from your real projects.");
    } catch (err) {
      showError(err, "Could not create the sample project.");
    } finally {
      setCreatingSample(false);
    }
  }

  async function rotateKey(project) {
    if (!window.confirm(`Rotate the key for "${project.name}"? The old key stops working immediately.`)) return;
    setError(null);
    try {
      const res = await api.post(`/projects/${project.id}/rotate-key`);
      revealKey(project.name, res.data.apiKey, project.environment);
      await loadProjects();
    } catch (err) {
      showError(err, "Could not rotate the key.");
    }
  }

  async function deleteProject(project) {
    if (!window.confirm(`Delete "${project.name}" and all its data? This cannot be undone.`)) return;
    setError(null);
    try {
      await api.delete(`/projects/${project.id}`);
      setShownKey(null);
      await loadProjects();
    } catch (err) {
      showError(err, "Could not delete the project.");
    }
  }

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(shownKey.apiKey);
      setCopied(true);
    } catch {
      setError("Could not copy automatically. Select the key and copy it by hand.");
    }
  }

  const hasSampleProject = projects?.some((project) => project.is_demo === 1);

  return (
    <main className="mx-auto max-w-6xl px-5 py-8 sm:px-7 lg:py-10">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-[#34372f] pb-6 sm:mb-10 sm:pb-8">
        <div>
          <p className="cr-eyebrow">Workspace <span aria-hidden="true">/</span> Monitoring</p>
          <h1 className="cr-page-title mt-3">Projects</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">Connect each application environment, then use its timeline to investigate incidents across your team.</p>
        </div>
        {projects && (
          <div className="border-l border-lime-300/60 pl-3 py-1 text-sm text-slate-400">
            <span className="font-semibold tabular-nums text-slate-100">{String(projects.length).padStart(2, "0")}</span><span className="ml-2">of 10 projects</span>
          </div>
        )}
      </div>

      {(error || loadError || notice) && (
        <div role={error || loadError ? "alert" : "status"} className={"mb-5 rounded-xl border p-3 text-sm " + (error || loadError ? "border-red-400/20 bg-red-400/[0.08] text-red-200" : "border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-200")}>
          {error || loadError || notice}
        </div>
      )}

      {/* The API key is shown here once, right after creating or rotating */}
      {shownKey && (
        <div className="mb-6 border border-amber-300/20 bg-amber-300/[0.04] p-5 sm:p-6">
          <p className="font-semibold text-amber-100">Connect {shownKey.projectName} · {shownKey.environment}</p>
          <p className="mb-3 mt-1 text-sm leading-relaxed text-amber-100/75">
            This project is a monitoring destination, not a source-code import. Run the agent on the server or machine you want to observe. Copy the key now; for safety it is shown only once. If you lose it, rotate the key.
          </p>
          <div className="flex gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm">
              {shownKey.apiKey}
            </code>
            <button
              onClick={copyKey}
              className="rounded-lg bg-cyan-300 px-4 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
            <p className="mb-2 mt-4 text-xs leading-relaxed text-slate-300">
            1. Put the CloudRewind agent folder on the machine that runs your service. For this source build, run the command from the CloudRewind repository. Set <code>CLOUDREWIND_KEY</code> with a secret manager or hidden prompt; do not put the key in command arguments:
          </p>
          <code className="block break-all rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs">
            {`node agent/index.js --url=${BACKEND_URL} --service=api`}
          </code>
          {LOCAL_BACKEND && (
            <p className="mt-2 text-xs text-amber-200">
              This setup points to a local backend. It works when the agent runs on this same machine. For a remote server, configure the frontend with the CloudRewind HTTPS backend URL that the server can reach.
            </p>
          )}
          <p className="text-xs text-slate-400 mt-3 mb-1">2. Optional: add your application's public health-check URL to also record status and response time:</p>
          <code className="block break-all rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs">
            --health-url=https://your-app.example/health
          </code>
          <p className="text-xs text-slate-400 mt-3 mb-1">PowerShell example: paste the key only at the hidden prompt (it will not appear in shell history):</p>
          <code className="block break-all rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs">
            {`$secure = Read-Host "CloudRewind key" -AsSecureString
$env:CLOUDREWIND_KEY = (New-Object System.Net.NetworkCredential("", $secure)).Password
node agent/index.js --url=${BACKEND_URL} --service=api`}
          </code>
          <p className="text-xs text-slate-400 mt-3">The agent sends host readings and, if configured, HTTP status and response time. It never sends source code or the health response body. After it starts, this project should show the agent as online.</p>
          <div className="mt-4 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
            <p className="text-sm font-medium text-slate-200">3. Add AWS metrics only if this machine runs on EC2</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              The agent is the host collector; it does not authenticate to AWS. Open this project's dashboard and connect CloudWatch separately with the EC2 instance ID and region. Use the optional role ARN for a customer AWS account. Keep the agent running on that same instance so CloudRewind can align AWS and host readings. You can skip AWS; the agent works on its own.
            </p>
          </div>
          <button onClick={() => setShownKey(null)} className="mt-3 text-sm text-slate-300 underline-offset-4 hover:text-white hover:underline">
            I have saved it, hide this
          </button>
        </div>
      )}

      <form onSubmit={createProject} className="mb-5 border border-[#34372f] bg-slate-900/70 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="grid size-7 place-items-center border border-cyan-300/30 text-xs font-semibold text-cyan-200">01</span>
              <h2 className="font-semibold text-white">Connect a real environment</h2>
            </div>
            <p className="ml-9 mt-1 text-xs leading-relaxed text-slate-400">For example, “Payments API” in production. Keep staging and production in separate projects.</p>
          </div>
          <span className="rounded-full border border-emerald-300/15 bg-emerald-300/[0.06] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-200">Agent telemetry</span>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_200px_auto]">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Application or service name"
            maxLength={60}
            required
            className="rounded-xl border border-white/10 bg-slate-950 px-3.5 py-2.5 text-sm outline-none transition placeholder:text-slate-600 focus:border-cyan-300/60 focus:ring-4 focus:ring-cyan-300/10"
          />
          <select
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            aria-label="Environment"
            className="rounded-xl border border-white/10 bg-slate-950 px-3.5 py-2.5 text-sm outline-none transition focus:border-cyan-300/60 focus:ring-4 focus:ring-cyan-300/10"
          >
            <option value="production">Production</option>
            <option value="staging">Staging</option>
            <option value="development">Development</option>
            <option value="other">Other</option>
          </select>
          <button
            type="submit"
            disabled={creating}
            className="rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-wait disabled:opacity-50"
          >
            {creating ? "Creating..." : "Create project"}
          </button>
        </div>
      </form>

      {projects && !hasSampleProject && (
        <section className="mb-7 flex flex-col gap-4 border border-violet-300/15 bg-violet-300/[0.025] p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div>
            <p className="text-sm font-semibold text-violet-100">Explore with a sample project</p>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-400">Optional simulated telemetry for trying rewind and incident workflows. It is labeled as a sample and kept separate from real agent and AWS readings.</p>
          </div>
          <button onClick={createSampleProject} disabled={creatingSample || projects.length >= 10} className="shrink-0 rounded-xl border border-violet-200/20 bg-violet-200/[0.08] px-4 py-2.5 text-sm font-medium text-violet-100 transition hover:bg-violet-200/[0.13] disabled:cursor-not-allowed disabled:opacity-50">
            {creatingSample ? "Creating sample…" : "Create sample project"}
          </button>
        </section>
      )}

      {!projects && !loadError && <p className="py-8 text-center text-sm text-slate-400">Loading projects…</p>}
      {projects && projects.length === 0 && (
        <div className="rounded-2xl border border-dashed border-white/10 px-6 py-10 text-center">
          <p className="text-base font-medium text-slate-200">Your workspace is ready for its first project.</p>
          <p className="mt-2 text-sm text-slate-400">Create an environment above. CloudRewind starts showing real readings when its agent connects.</p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {projects?.map((p) => {
          const isDemo = p.is_demo === 1;
          return (
            <div key={p.id} className="border border-[#34372f] bg-slate-900/60 p-5 transition hover:border-cyan-200/40 hover:bg-slate-900/90">
              <div className="flex items-center justify-between">
                <p className="font-semibold">{p.name}</p>
                <AgentBadge project={p} />
              </div>
              <p className="mt-2 text-sm text-slate-400">
                {isDemo ? "Simulated data, updated every 5 seconds" : `${p.environment || "production"} · Key ${p.api_key_prefix}...`}
              </p>
              <div className="mt-5 flex gap-4 border-t border-white/[0.07] pt-4 text-sm">
                  <Link to={`/projects/${p.id}`} className="font-medium text-cyan-200 underline-offset-4 hover:text-cyan-100 hover:underline">
                  Open
                </Link>
                {!isDemo && (
                  <button onClick={() => rotateKey(p)} className="text-slate-400 underline-offset-4 hover:text-slate-100 hover:underline">
                    Rotate key
                  </button>
                )}
                <button onClick={() => deleteProject(p)} className="text-rose-300 underline-offset-4 hover:text-rose-200 hover:underline">
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
