import axios from "axios";

export const TOKEN_KEY = "cr_token";
export const API_BASE_URL = (import.meta.env.VITE_API_URL || "http://localhost:5000").replace(/\/+$/, "");

const api = axios.create({ baseURL: API_BASE_URL });

// Attach the saved login token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  const workspaceId = localStorage.getItem("cr_workspace_id");
  if (workspaceId) config.headers["X-Workspace-Id"] = workspaceId;
  return config;
});

// If the backend says "not logged in" (for example the token expired), go to the login page
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const url = error.config?.url || "";
    const isLoginAttempt = url.startsWith("/auth/login") || url.startsWith("/auth/signup");
    if (error.response?.status === 401 && !isLoginAttempt) {
      localStorage.removeItem(TOKEN_KEY);
      if (window.location.pathname !== "/login") window.location.assign("/login");
    }
    return Promise.reject(error);
  }
);

export default api;
