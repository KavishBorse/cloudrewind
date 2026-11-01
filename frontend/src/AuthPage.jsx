import { useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./useAuth";

// One page for both Login and Signup: <AuthPage mode="login" /> or <AuthPage mode="signup" />
export default function AuthPage({ mode }) {
  const isSignup = mode === "signup";
  const { user, login, signup } = useAuth();
  const location = useLocation();
  const [fullName, setFullName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Already logged in: go to the projects page
  if (user) return <Navigate to={location.state?.from || "/"} replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (isSignup && password !== confirmPassword) {
      setError("Your passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      if (isSignup) {
        await signup({
          full_name: fullName.trim(),
          organization_name: organizationName.trim(),
          email: email.trim(),
          password,
        });
      } else {
        await login(email.trim(), password);
      }
    } catch (err) {
      setError(err.response?.data?.error || "Cannot reach the backend. Is it running?");
    } finally {
      setBusy(false);
    }
  }

  const inputClass = "w-full rounded-none border border-white/10 bg-slate-950/80 px-3.5 py-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/10";
  const labelClass = "mb-1.5 block text-sm font-medium text-slate-300";

  return (
    <main className="mx-auto grid w-full max-w-6xl items-center gap-10 px-5 py-10 sm:px-8 lg:min-h-[calc(100vh-65px)] lg:grid-cols-[minmax(0,1.1fr)_minmax(380px,0.9fr)] lg:gap-16 lg:py-12">
      <section className="max-w-xl">
        <p className="inline-flex items-center gap-2 border-l-2 border-cyan-300 pl-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-200">
          Cloud observability for incident response
        </p>
        <h1 className="mt-6 max-w-lg font-serif text-4xl font-normal leading-[1.08] tracking-tight text-white sm:text-6xl">
          When something breaks, <span className="text-cyan-200">rewind the evidence.</span>
        </h1>
        <p className="mt-5 max-w-lg text-base leading-7 text-slate-400">
          CloudRewind lines up host health, AWS signals, and deploy events so your team can go back to the moment an incident began.
        </p>

        <div className="mt-8 hidden gap-3 lg:grid">
          {[
            ["01", "Rewind the timeline", "Inspect the readings around a failure, not just the current state."],
            ["02", "Keep evidence together", "Compare host metrics, CloudWatch, and deploy markers in one incident view."],
            ["03", "Bring your team in", "Share project context through a workspace with clear member roles."],
          ].map(([number, title, description]) => (
            <div key={number} className="border-l border-white/[0.16] bg-white/[0.02] p-4">
              <div className="flex items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center border border-cyan-300/30 text-xs font-semibold text-cyan-200">{number}</span>
                <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
              </div>
              <p className="mt-2 pl-11 text-xs leading-relaxed text-slate-500">{description}</p>
            </div>
          ))}
        </div>
        <p className="mt-6 hidden text-xs text-slate-500 lg:block">The host agent sends metrics only. It does not upload your application source code.</p>
      </section>

      <section className="w-full border border-[#34372f] bg-slate-900/75 p-6 sm:p-8">
        <div className="mb-7">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">{isSignup ? "Create your workspace" : "Your CloudRewind account"}</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">{isSignup ? "Start investigating" : "Welcome back"}</h2>
          <p className="mt-1 text-sm text-slate-400">
            {isSignup ? "Create an account, then connect a project and its monitoring agent." : "Log in to view your projects and incident history."}
          </p>
        </div>

        {error && (
          <div role="alert" className="mb-5 rounded-xl border border-red-400/20 bg-red-400/[0.08] p-3 text-sm text-red-200">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {isSignup && (
            <>
              <div>
                <label htmlFor="full-name" className={labelClass}>Full name</label>
                <input id="full-name" name="name" type="text" autoComplete="name" required minLength={2} maxLength={100} value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputClass} placeholder="Your name" />
              </div>
              <div>
                <label htmlFor="organization-name" className={labelClass}>Organization or team <span className="font-normal text-slate-500">(optional)</span></label>
                <input id="organization-name" name="organization" type="text" autoComplete="organization" maxLength={120} value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} placeholder="Company, lab, or project team" className={inputClass} />
              </div>
            </>
          )}
          <div>
            <label htmlFor="email" className={labelClass}>Email address</label>
            <input id="email" name="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="you@company.com" />
          </div>
          <div>
            <label htmlFor="password" className={labelClass}>Password</label>
            <input id="password" name="password" type="password" autoComplete={isSignup ? "new-password" : "current-password"} required minLength={isSignup ? 8 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} placeholder={isSignup ? "At least 8 characters" : "Enter your password"} />
          </div>
          {isSignup && (
            <div>
              <label htmlFor="confirm-password" className={labelClass}>Confirm password</label>
              <input id="confirm-password" name="confirm-password" type="password" autoComplete="new-password" required minLength={8} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className={inputClass} placeholder="Re-enter your password" />
            </div>
          )}
          <button type="submit" disabled={busy} className="w-full rounded-none bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/30 disabled:cursor-wait disabled:opacity-60">
            {busy ? "Please wait…" : isSignup ? "Create account" : "Log in"}
          </button>
        </form>

        {isSignup && <p className="mt-4 text-xs leading-relaxed text-slate-500">Email verification is not enabled yet. You can use the account immediately; use an email address you control.</p>}
        <p className="mt-6 border-t border-white/[0.08] pt-5 text-sm text-slate-400">
          {isSignup ? "Already have an account? " : "New to CloudRewind? "}
          <Link to={isSignup ? "/login" : "/signup"} state={location.state} className="font-medium text-cyan-200 hover:text-cyan-100 hover:underline">
            {isSignup ? "Log in" : "Create an account"}
          </Link>
        </p>
      </section>
    </main>
  );
}
