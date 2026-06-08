-- Schema v11: share_links.
--
-- Tokenized public links that grant access to a workspace's canvas
-- without a GitHub login. A link carries a role (viewer or member)
-- and a high-entropy secret token. Only the SHA-256 hash of the token
-- is stored: the raw token is shown to the creator exactly once, at
-- creation time, and is unrecoverable afterward (same posture as
-- api_tokens in migration 005).
--
-- Redemption is handled in the application layer (POST /api/share/redeem):
-- it validates the link, provisions a synthetic share principal
-- (users.id = 'share:<link_id>') joined to the workspace at the link's
-- role, and mints a short-lived session JWT for that principal. Because
-- access flows through an ordinary workspace_members row, every
-- existing workspace-scoped route enforces it with no special-casing,
-- and revoking a link removes that membership so access is cut
-- immediately even while an issued JWT is still unexpired.
--
--   role        viewer (read-only) or member (can edit). admin/owner
--               are deliberately not grantable by link.
--   token_hash  sha256(token), hex. UNIQUE so a redeem is one indexed
--               lookup.
--   expires_at  NULL = no expiry. A redeem past this instant fails.
--   revoked_at  soft delete. A redeem on a revoked link fails.

CREATE TABLE IF NOT EXISTS share_links (
	id                 text          PRIMARY KEY,
	workspace_id       text          NOT NULL REFERENCES workspaces (id),
	created_by_user_id text          NOT NULL REFERENCES users (id),
	role               text          NOT NULL
		CHECK (role IN ('viewer', 'member')),
	token_hash         text          NOT NULL UNIQUE,
	expires_at         timestamptz,
	revoked_at         timestamptz,
	created_at         timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS share_links_workspace_idx
	ON share_links (workspace_id)
	WHERE revoked_at IS NULL;
