import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import api from "./api";
import { useAuth } from "./useAuth";
import { useWorkspace } from "./useWorkspace";

export default function InvitePage() {
  const { token } = useParams();
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id;
  const { selectWorkspace, refresh } = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const [inviteState, setInviteState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const stateMatches = inviteState?.token === token && inviteState?.userId === userId;
  const invite = stateMatches ? inviteState.invite : null;
  const loadError = stateMatches ? inviteState.error : null;
  const loading = authLoading || (Boolean(userId) && !stateMatches);

  useEffect(() => {
    let active = true;
    if (!userId) return () => { active = false; };
    api.get("/workspaces/invitations/" + token)
      .then((response) => { if (active) setInviteState({ token, userId, invite: response.data, error: null }); })
      .catch((err) => {
        if (active) setInviteState({ token, userId, invite: null, error: err.response?.data?.error || "Could not validate this invitation." });
      });
    return () => { active = false; };
  }, [token, userId]);

  async function acceptInvite() {
    setBusy(true);
    setActionError(null);
    try {
      const response = await api.post("/workspaces/invitations/" + token + "/accept");
      selectWorkspace(response.data.workspace.id);
      await refresh();
      navigate("/workspace", { replace: true });
    } catch (err) {
      setActionError(err.response?.data?.error || "Could not accept this invitation.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-xl p-6 sm:pt-16">
      <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-black/20">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">Team invitation</p>
        <h1 className="mt-2 text-2xl font-semibold">Join a CloudRewind workspace</h1>
        {authLoading ? (
          <p className="mt-4 text-sm text-slate-400">Checking your session…</p>
        ) : !user ? (
          <>
            <p className="mt-3 text-sm leading-6 text-slate-400">Sign in or create an account with the invited email address. Email ownership is not verified in this build.</p>
            <div className="mt-5 flex gap-3">
              <Link to="/login" state={{ from: location }} className="rounded-xl border border-slate-700 px-4 py-2 text-sm hover:border-cyan-400">Log in</Link>
              <Link to="/signup" state={{ from: location }} className="rounded-xl bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950">Create account</Link>
            </div>
          </>
        ) : loading ? (
          <p className="mt-4 text-sm text-slate-400">Checking invitation…</p>
        ) : invite ? (
          <>
            <p className="mt-3 text-sm leading-6 text-slate-300"><span className="font-medium text-white">{invite.email}</span> is invited to <span className="font-medium text-white">{invite.workspace_name}</span> as a {invite.role}.</p>
            <p className="mt-2 text-xs text-slate-500">Expires {new Date(invite.expires_at).toLocaleString()}.</p>
            <button onClick={acceptInvite} disabled={busy} className="mt-5 rounded-xl bg-cyan-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50">{busy ? "Joining…" : "Accept invitation"}</button>
          </>
        ) : null}
        {(loadError || actionError) && <div role="alert" className="mt-4 rounded-xl border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-200">{loadError || actionError}</div>}
      </section>
    </main>
  );
}
