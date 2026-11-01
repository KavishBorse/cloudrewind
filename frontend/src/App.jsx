import { BrowserRouter, Routes, Route, Navigate, Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { AuthProvider } from "./AuthContext";
import { useAuth } from "./useAuth";
import AuthPage from "./AuthPage";
import Projects from "./Projects";
import Dashboard from "./Dashboard";
import Docs from "./Docs";
import WorkspacePage from "./WorkspacePage";
import InvitePage from "./InvitePage";
import ProfilePage from "./ProfilePage";
import { WorkspaceProvider } from "./WorkspaceContext";
import { useWorkspace } from "./useWorkspace";

// Only lets logged-in users through; everyone else goes to /login
function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="p-6 text-slate-400">Loading...</p>;
  return user ? children : <Navigate to="/login" replace state={{ from: location }} />;
}

function Header() {
  const { user, logout } = useAuth();
  const { workspaces, currentWorkspace, selectWorkspace } = useWorkspace();
  const navigate = useNavigate();
  const navClass = ({ isActive }) =>
      "relative rounded-md px-3 py-2 text-sm font-medium transition after:absolute after:inset-x-3 after:bottom-0 after:h-px after:content-[''] " +
    (isActive
      ? "text-lime-200 after:bg-lime-300"
      : "text-slate-400 after:bg-transparent hover:text-slate-100");

  const initials = (user?.full_name || user?.email || "CR")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <header className="sticky top-0 z-40 border-b border-[#30332c] bg-[#11130f]/95 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link to="/" className="group flex shrink-0 items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
          <span className="grid size-8 place-items-center border border-lime-300/40 text-lime-200 transition group-hover:bg-lime-300/10" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" className="size-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3.5 11a8.5 8.5 0 1 1 2.2 5.7" />
              <path d="M3.5 4.5V11H10" />
              <path d="M12 7v5l3 2" />
            </svg>
          </span>
          <span className="font-semibold tracking-tight text-[#f0eee5]">CloudRewind<span className="ml-1 text-lime-300">/</span></span>
        </Link>
        <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2">
          {user && (
            <>
              <nav aria-label="Main navigation" className="flex items-center gap-0.5">
                <NavLink to="/" end className={navClass}>Projects</NavLink>
                <NavLink to="/workspace" className={navClass}>Team</NavLink>
              </nav>
              {workspaces.length > 1 ? (
                <select
                  aria-label="Active workspace"
                  value={currentWorkspace?.id || ""}
                  onChange={(event) => {
                    selectWorkspace(event.target.value);
                    navigate("/");
                  }}
                  className="max-w-40 rounded-lg border border-white/10 bg-slate-900 px-2.5 py-2 text-xs text-slate-200 outline-none transition focus:border-cyan-300 sm:max-w-52 sm:text-sm"
                >
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                  ))}
                </select>
              ) : currentWorkspace ? (
                <span className="hidden max-w-40 truncate rounded-lg border border-white/10 bg-slate-900/70 px-2.5 py-2 text-xs text-slate-300 sm:block" title={currentWorkspace.name}>
                  {currentWorkspace.name}
                </span>
              ) : null}
              <NavLink to="/docs" className={navClass}>Docs</NavLink>
              <span className="mx-1 hidden h-6 w-px bg-[#34372f] sm:block" aria-hidden="true" />
              <details className="relative">
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 pl-1 pr-2 text-left outline-none transition hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-lime-300 [&::-webkit-details-marker]:hidden">
                  <span className="grid size-8 shrink-0 place-items-center bg-lime-300 text-xs font-bold text-[#171a12]">{initials}</span>
                  <span className="hidden max-w-32 sm:block">
                    <span className="block truncate text-xs font-medium text-slate-200">{user.full_name || "Account"}</span>
                    <span className="block text-[10px] text-slate-500">Account menu</span>
                  </span>
                  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className="size-3 text-slate-500"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </summary>
                <div className="absolute right-0 top-[calc(100%+10px)] z-50 w-60 border border-[#41443a] bg-[#1a1c17] p-2 shadow-2xl shadow-black/40">
                  <div className="border-b border-[#34372f] px-3 pb-3 pt-2">
                    <p className="truncate text-sm font-medium text-[#f0eee5]">{user.full_name || "Account"}</p>
                    <p className="mt-0.5 truncate text-xs text-slate-500">{user.email}</p>
                  </div>
                  <Link to="/profile" className="mt-2 flex items-center justify-between px-3 py-2 text-sm text-slate-200 transition hover:bg-white/[0.05] hover:text-lime-200">
                    Profile & account <span aria-hidden="true" className="text-slate-500">↗</span>
                  </Link>
                  <button onClick={logout} className="mt-1 w-full px-3 py-2 text-left text-sm text-slate-400 transition hover:bg-white/[0.05] hover:text-white">Log out</button>
                </div>
              </details>
            </>
          )}
          {!user && <NavLink to="/docs" className={navClass}>Docs</NavLink>}
        </div>
      </div>
    </header>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <WorkspaceProvider>
          <div className="min-h-screen text-slate-100">
            <Header />
            <Routes>
              <Route path="/login" element={<AuthPage mode="login" />} />
              <Route path="/signup" element={<AuthPage mode="signup" />} />
              <Route path="/invite/:token" element={<InvitePage />} />
              <Route path="/docs" element={<Docs />} />
              <Route path="/" element={<ProtectedRoute><Projects /></ProtectedRoute>} />
              <Route path="/workspace" element={<ProtectedRoute><WorkspacePage /></ProtectedRoute>} />
              <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
              <Route path="/projects/:projectId" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </WorkspaceProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
