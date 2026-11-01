CREATE TABLE IF NOT EXISTS workspace_invites (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
  token_hash TEXT UNIQUE NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL,
  accepted_at BIGINT,
  accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoked_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace ON workspace_invites(workspace_id, created_at DESC);
