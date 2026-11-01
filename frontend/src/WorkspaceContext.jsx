import { useCallback, useEffect, useMemo, useState } from "react";
import api from "./api";
import { useAuth } from "./useAuth";
import { WORKSPACE_KEY, WorkspaceContext } from "./workspaceContextStore";

export function WorkspaceProvider({ children }) {
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id;
  const [workspaces, setWorkspaces] = useState([]);
  const [loadedFor, setLoadedFor] = useState(null);
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem(WORKSPACE_KEY) || "");
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!userId) {
      return [];
    }
    try {
      const response = await api.get("/workspaces");
      const next = response.data;
      const storedId = localStorage.getItem(WORKSPACE_KEY);
      const selected = next.some((workspace) => String(workspace.id) === storedId)
        ? storedId
        : String(next[0]?.id || "");
      setWorkspaces(next);
      setLoadedFor(userId);
      setSelectedId(selected);
      if (selected) localStorage.setItem(WORKSPACE_KEY, selected);
      else localStorage.removeItem(WORKSPACE_KEY);
      setError(null);
      return next;
    } catch (err) {
      setError(err.response?.data?.error || "Could not load workspaces.");
      throw err;
    }
  }, [userId]);

  useEffect(() => {
    if (authLoading) return;
    if (userId) {
      const initialLoad = setTimeout(() => refresh().catch(() => {}), 0);
      const timer = setInterval(() => refresh().catch(() => {}), 30_000);
      return () => { clearTimeout(initialLoad); clearInterval(timer); };
    } else {
      localStorage.removeItem(WORKSPACE_KEY);
    }
  }, [userId, authLoading, refresh]);

  const selectWorkspace = useCallback((id) => {
    const value = String(id || "");
    setSelectedId(value);
    if (value) localStorage.setItem(WORKSPACE_KEY, value);
    else localStorage.removeItem(WORKSPACE_KEY);
  }, []);

  const visibleWorkspaces = useMemo(() => loadedFor === userId ? workspaces : [], [loadedFor, userId, workspaces]);
  const currentWorkspace = visibleWorkspaces.find((workspace) => String(workspace.id) === selectedId) || null;
  const value = useMemo(() => ({
    workspaces: visibleWorkspaces,
    currentWorkspace,
    error,
    selectWorkspace,
    refresh,
  }), [visibleWorkspaces, currentWorkspace, error, selectWorkspace, refresh]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

