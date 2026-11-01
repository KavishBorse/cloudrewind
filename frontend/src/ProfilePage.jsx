import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "./api";
import { useAuth } from "./useAuth";
import { useWorkspace } from "./useWorkspace";

const messageFor = (error) => error.response?.data?.error || "Could not save your profile. Try again.";

export default function ProfilePage() {
  const { user, updateUser } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const [fullName, setFullName] = useState(user?.full_name || "");
  const [organizationName, setOrganizationName] = useState(user?.organization_name || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const initials = useMemo(() =>
    (fullName || user?.email || "CR").trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase(),
  [fullName, user?.email]);

  const changed = fullName.trim() !== (user?.full_name || "") || organizationName.trim() !== (user?.organization_name || "");

  async function saveProfile(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api.patch("/auth/me", {
        full_name: fullName.trim(),
        organization_name: organizationName.trim(),
      });
      updateUser(response.data.user);
      setNotice("Profile saved.");
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="cr-page mx-auto max-w-6xl px-5 pb-16 pt-8 sm:px-7 sm:pt-11">
      <div className="mb-8 border-b border-[#34372f] pb-6 sm:mb-10 sm:pb-8">
        <p className="cr-eyebrow">Account <span aria-hidden="true">/</span> Personal details</p>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="cr-page-title">Profile & account</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">The details your team sees when you work in CloudRewind.</p>
          </div>
          <Link to="/" className="cr-text-link text-sm">Back to projects <span aria-hidden="true">↗</span></Link>
        </div>
      </div>

      {(error || notice) && (
        <div role={error ? "alert" : "status"} className={`mb-6 border px-4 py-3 text-sm ${error ? "border-red-400/30 bg-red-950/30 text-red-200" : "border-lime-300/25 bg-lime-300/[0.06] text-lime-200"}`}>
          <span className="mr-2" aria-hidden="true">{error ? "!" : "✓"}</span>{error || notice}
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-14">
        <form onSubmit={saveProfile} className="space-y-9">
          <section aria-labelledby="identity-heading">
            <div className="mb-5 flex items-center justify-between border-b border-[#34372f] pb-3">
              <div>
                <p className="cr-section-number">01 <span>Identity</span></p>
                <h2 id="identity-heading" className="mt-1 text-base font-semibold text-[#f0eee5]">Personal details</h2>
              </div>
              <span className="hidden text-xs text-slate-500 sm:block">Visible to your workspace</span>
            </div>

            <div className="mb-6 flex items-center gap-4">
              <span className="grid size-14 shrink-0 place-items-center border border-lime-300/50 bg-lime-300 text-lg font-semibold tracking-tight text-[#171a12]">{initials}</span>
              <div className="min-w-0">
                <p className="truncate font-medium text-[#f0eee5]">{fullName || "Your name"}</p>
                <p className="mt-1 truncate text-sm text-slate-500">{user?.email}</p>
              </div>
            </div>

            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
              <label className="cr-field-wrap">
                <span className="cr-field-label">Full name</span>
                <input className="cr-field" type="text" autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} minLength={2} maxLength={100} required />
                <span className="cr-field-hint">Used for invitations and workspace activity.</span>
              </label>
              <label className="cr-field-wrap">
                <span className="cr-field-label">Organization</span>
                <input className="cr-field" type="text" autoComplete="organization" value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} maxLength={120} placeholder="Optional" />
                <span className="cr-field-hint">Account detail; changing it will not rename your workspace.</span>
              </label>
            </div>
          </section>

          <section aria-labelledby="login-heading">
            <div className="mb-5 border-b border-[#34372f] pb-3">
              <p className="cr-section-number">02 <span>Sign-in</span></p>
              <h2 id="login-heading" className="mt-1 text-base font-semibold text-[#f0eee5]">Login email</h2>
            </div>
            <label className="cr-field-wrap block max-w-xl">
              <span className="cr-field-label">Email address</span>
              <input className="cr-field cr-field-locked" type="email" value={user?.email || ""} readOnly aria-describedby="email-note" />
              <span id="email-note" className="cr-field-hint">Email changes are locked until verification is available. Your current address remains your login.</span>
            </label>
          </section>

          <div className="flex flex-wrap items-center gap-4 border-t border-[#34372f] pt-5">
            <button type="submit" disabled={busy || !changed} className="cr-primary-button">
              {busy ? "Saving…" : "Save profile"}
            </button>
            <span className="text-xs text-slate-500">{changed ? "Unsaved changes" : "All changes saved"}</span>
          </div>
        </form>

        <aside className="space-y-5 lg:pt-1">
          <section className="border-l-2 border-lime-300/70 bg-[#191b16] px-5 py-5">
            <p className="cr-eyebrow">Current workspace</p>
            <h2 className="mt-3 break-words text-base font-semibold text-[#f0eee5]">{currentWorkspace?.name || "Loading workspace…"}</h2>
            <div className="mt-4 flex items-center justify-between border-t border-[#34372f] pt-3 text-sm">
              <span className="text-slate-500">Your role</span>
              <span className="capitalize text-lime-200">{currentWorkspace?.role || "—"}</span>
            </div>
            <Link to="/workspace" className="cr-text-link mt-4 inline-flex text-sm">Open team settings <span aria-hidden="true">↗</span></Link>
          </section>

          <section className="border border-[#34372f] px-5 py-5">
            <p className="cr-eyebrow">Account notes</p>
            <p className="mt-3 text-sm leading-6 text-slate-400">Profile edits apply to your account. Workspace names and team access are managed separately.</p>
            <div className="mt-4 border-t border-[#34372f] pt-3 text-xs leading-5 text-slate-500">
              Email verification and verified email changes are not enabled in this build.
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
