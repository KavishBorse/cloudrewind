import { useCallback, useEffect, useState } from "react";
import api from "./api";
import { useWorkspace } from "./useWorkspace";

const errorMessage = (error, fallback) => error.response?.data?.error || fallback;

function RoleBadge({ role }) {
  const styles = role === "owner"
    ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200"
    : role === "admin"
      ? "border-violet-400/30 bg-violet-400/10 text-violet-200"
      : "border-slate-600 bg-slate-800 text-slate-300";
  return <span className={"rounded-full border px-2.5 py-1 text-xs capitalize " + styles}>{role}</span>;
}

function WorkspaceDetails({ workspace, canManage, onSaved }) {
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  async function saveName(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.patch("/workspaces/current", { name });
      await onSaved();
      setNotice("Workspace name updated.");
    } catch (err) {
      setError(errorMessage(err, "Could not update the workspace name."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
      <h2 className="font-semibold">Workspace details</h2>
      {canManage ? (
        <form onSubmit={saveName} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            minLength={2}
            maxLength={120}
            required
            aria-label="Workspace name"
            className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-cyan-400"
          />
          <button disabled={busy || name.trim() === workspace.name} className="rounded-xl bg-cyan-400 px-4 py-2 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40">
            Save name
          </button>
        </form>
      ) : (
        <p className="mt-2 text-sm text-slate-400">Workspace name: {workspace.name}</p>
      )}
      {(error || notice) && (
        <p role={error ? "alert" : "status"} className={"mt-3 text-sm " + (error ? "text-red-300" : "text-emerald-300")}>
          {error || notice}
        </p>
      )}
    </section>
  );
}

export default function WorkspacePage() {
  const { currentWorkspace, refresh } = useWorkspace();
  const canManage = currentWorkspace?.role === "owner" || currentWorkspace?.role === "admin";
  const isOwner = currentWorkspace?.role === "owner";
  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [inviteLink, setInviteLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [loadedWorkspaceId, setLoadedWorkspaceId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const workspaceId = currentWorkspace?.id;
  const load = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const [membersResponse, inviteResponse] = await Promise.all([
        api.get("/workspaces/members"),
        canManage ? api.get("/workspaces/invitations") : Promise.resolve({ data: [] }),
      ]);
      setMembers(membersResponse.data);
      setInvitations(inviteResponse.data);
      setLoadedWorkspaceId(workspaceId);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load this workspace."));
      setLoadedWorkspaceId(workspaceId);
    }
  }, [workspaceId, canManage]);

  useEffect(() => {
    const initialLoad = setTimeout(() => load(), 0);
    return () => clearTimeout(initialLoad);
  }, [load]);

  async function createInvite(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setInviteLink("");
    try {
      const response = await api.post("/workspaces/invitations", { email, role });
      setInviteLink(response.data.invite_url);
      setEmail("");
      await load();
      setNotice("Invitation created. Share this link with the invited email address.");
    } catch (err) {
      setError(errorMessage(err, "Could not create the invitation."));
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
    } catch {
      setError("Copy failed. Select the invitation link and copy it manually.");
    }
  }

  async function changeRole(member, nextRole) {
    setError(null);
    try {
      await api.patch("/workspaces/members/" + member.id, { role: nextRole });
      await load();
    } catch (err) {
      setError(errorMessage(err, "Could not update this member."));
    }
  }

  async function removeMember(member) {
    if (!window.confirm("Remove " + (member.full_name || member.email) + " from this workspace?")) return;
    setError(null);
    try {
      await api.delete("/workspaces/members/" + member.id);
      await load();
      await refresh();
    } catch (err) {
      setError(errorMessage(err, "Could not remove this member."));
    }
  }

  async function revokeInvite(invite) {
    setError(null);
    try {
      await api.delete("/workspaces/invitations/" + invite.id);
      await load();
      setNotice("Invitation revoked.");
    } catch (err) {
      setError(errorMessage(err, "Could not revoke this invitation."));
    }
  }

  if (!currentWorkspace) {
    return <main className="mx-auto max-w-5xl p-6 text-slate-300">Loading your workspace…</main>;
  }
  const loading = loadedWorkspaceId !== workspaceId;

  return (
    <main className="mx-auto max-w-5xl space-y-7 px-5 py-8 sm:px-7 lg:py-10">
      <div className="border-b border-[#34372f] pb-6">
        <p className="cr-eyebrow">Workspace <span aria-hidden="true">/</span> Team</p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="cr-page-title mt-3">{currentWorkspace.name}</h1>
            <p className="mt-1 text-sm text-slate-400">Shared access to projects, telemetry, and incident history.</p>
          </div>
          <RoleBadge role={currentWorkspace.role} />
        </div>
      </div>

      {(error || notice) && (
        <div className={"rounded-xl border px-4 py-3 text-sm " + (error ? "border-red-800 bg-red-950/50 text-red-200" : "border-emerald-800 bg-emerald-950/40 text-emerald-200")}>
          {error || notice}
        </div>
      )}

      <WorkspaceDetails key={currentWorkspace.id + ":" + currentWorkspace.name} workspace={currentWorkspace} canManage={canManage} onSaved={refresh} />

      <section className="border border-slate-800 bg-slate-900/70 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">People</h2>
            <p className="mt-1 text-sm text-slate-400">{members.length} {members.length === 1 ? "person has" : "people have"} access to this workspace.</p>
          </div>
        </div>
        {loading ? <p className="mt-5 text-sm text-slate-400">Loading members…</p> : (
          <div className="mt-5 divide-y divide-slate-800">
            {members.map((member) => (
              <div key={member.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate font-medium">{member.full_name || member.email}</p>
                  <p className="truncate text-sm text-slate-400">{member.email}</p>
                </div>
                <div className="flex items-center gap-3">
                  {isOwner && member.role !== "owner" ? (
                    <select value={member.role} onChange={(event) => changeRole(member, event.target.value)} aria-label={"Role for " + member.email} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-sm">
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                  ) : <RoleBadge role={member.role} />}
                  {canManage && member.role !== "owner" && (isOwner || member.role === "member") && (
                    <button onClick={() => removeMember(member)} className="text-sm text-slate-400 hover:text-red-300">Remove</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {canManage && (
        <>
          <section className="border border-slate-800 bg-slate-900/70 p-5">
            <h2 className="font-semibold">Invite someone</h2>
            <p className="mt-1 text-sm text-slate-400">The invite is for this email and expires in seven days. They need a CloudRewind account with the same entered address; OTP verification is not enabled yet.</p>
            <form onSubmit={createInvite} className="mt-4 grid gap-3 sm:grid-cols-[1fr_160px_auto]">
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} placeholder="teammate@company.com" aria-label="Teammate email" className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-cyan-400" />
              <select value={role} onChange={(event) => setRole(event.target.value)} aria-label="Invite role" className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2">
                <option value="member">Member</option>
                {isOwner && <option value="admin">Admin</option>}
              </select>
              <button disabled={busy} className="rounded-xl bg-cyan-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50">Create invite link</button>
            </form>
            {inviteLink && (
              <div className="mt-4 rounded-xl border border-cyan-900 bg-cyan-950/30 p-4">
                <p className="text-sm text-cyan-100">Copy this link now. CloudRewind stores only its hash, so it will not be shown again.</p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input readOnly value={inviteLink} aria-label="Invitation link" className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200" />
                  <button onClick={copyInvite} className="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950">{copied ? "Copied" : "Copy link"}</button>
                </div>
              </div>
            )}
          </section>

          <section className="border border-slate-800 bg-slate-900/70 p-5">
            <h2 className="font-semibold">Pending invitations</h2>
            {invitations.length === 0 ? <p className="mt-3 text-sm text-slate-400">No pending invitations.</p> : (
              <div className="mt-4 divide-y divide-slate-800">
                {invitations.map((invite) => (
                  <div key={invite.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <div>
                      <p className="font-medium">{invite.email}</p>
                      <p className="text-xs text-slate-400">{invite.role} · expires {new Date(invite.expires_at).toLocaleDateString()}</p>
                    </div>
                    <button onClick={() => revokeInvite(invite)} className="text-sm text-slate-400 hover:text-red-300">Revoke</button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
