import { useEffect, useState } from "react";
import api, { TOKEN_KEY } from "./api";
import { AuthContext } from "./authContextStore";

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(() => Boolean(localStorage.getItem(TOKEN_KEY)));

  // When the page loads: if a token is saved, ask the backend who it belongs to
  useEffect(() => {
    if (!localStorage.getItem(TOKEN_KEY)) {
      return;
    }
    api
      .get("/auth/me")
      .then((res) => setUser(res.data.user))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function authenticate(path, details) {
    const res = await api.post(path, details);
    localStorage.setItem(TOKEN_KEY, res.data.token);
    setUser(res.data.user);
  }

  const value = {
    user,
    loading,
    updateUser: (nextUser) => setUser(nextUser),
    login: (email, password) => authenticate("/auth/login", { email, password }),
    signup: (details) => authenticate("/auth/signup", details),
    logout: () => {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem("cr_workspace_id");
      setUser(null);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
