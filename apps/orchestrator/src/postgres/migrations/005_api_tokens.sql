-- Schema v5: programmatic API tokens.
--
-- The foundation for CLI / SDK / webhooks-out / public REST API.
-- Until this migration the orchestrator only spoke session JWTs;
-- a developer scripting against /api/agents needed to scrape the
-- session out of a browser. This table gives them a real key.
--
-- Tokens are 32-byte random, base64url-encoded, prefixed `ack_`
-- (agent-canvas key — mirrors stripe's sk_, cursor's csk_, etc.).
-- We store only the SHA-256 hash; the raw token is shown to the
-- user exactly once on creation and never recoverable.
--
-- Scopes mirror the workspace_member roles: `read` accepts viewer-
-- level routes, `write` accepts member+. Future scopes (admin,
-- audit_log:read, billing:write) get added to the CHECK enum.
--
-- last_used_at updates on every successful verify so operators
-- can identify dead keys and revoke them. We do NOT log per-call
-- usage in this table — that lives in audit_log keyed to
-- actor_user_id.

CREATE TABLE IF NOT EXISTS api_tokens (
	id               text          PRIMARY KEY,
	user_id          text          NOT NULL REFERENCES users (id),
	workspace_id     text          NOT NULL REFERENCES workspaces (id),
	name             text          NOT NULL,
	token_hash       text          NOT NULL UNIQUE,
	-- token_prefix is the first 12 chars of the raw token plus an
	-- ellipsis, stored so the UI can show "ack_a4b8…" without ever
	-- holding the secret half.
	token_prefix     text          NOT NULL,
	scope            text          NOT NULL
		CHECK (scope IN ('read', 'write')),
	created_at       timestamptz   NOT NULL DEFAULT now(),
	last_used_at     timestamptz,
	expires_at       timestamptz,
	revoked_at       timestamptz
);

CREATE INDEX IF NOT EXISTS api_tokens_user_idx
	ON api_tokens (user_id)
	WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS api_tokens_workspace_idx
	ON api_tokens (workspace_id)
	WHERE revoked_at IS NULL;

-- token_hash lookups need to be O(1); the unique constraint above
-- already creates the index, but we mention it for symmetry with
-- the other lookups.
