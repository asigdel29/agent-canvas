-- Schema v7: workspace-scoped admin audit trail.
--
-- The existing audit_log table (001_init.sql) records per-run
-- forensic detail. Workspace admins want a different shape: "who
-- minted tokens last week", "who registered the webhook to
-- prod.example.com", "when did Anna lose admin?". These events
-- aren't tied to a run; they're administrative state changes on
-- the workspace itself. Keeping them in a separate table avoids
-- retrofitting workspace_id onto every row of the existing log
-- and lets the two abstractions evolve independently.
--
-- Append-only. Soft delete is irrelevant — an audit entry must
-- never disappear because someone wants to hide their tracks.
-- Retention is enforced out-of-band (e.g. GDPR purges after the
-- user is deleted); the application never deletes from this table.
--
-- Actions are a free-text enum, namespaced with a dot: token.minted,
-- token.revoked, webhook.created, webhook.revoked, member.added,
-- member.role_changed, member.removed, workspace.created. The
-- application validates against the auditActions.ts source of truth.

CREATE TABLE IF NOT EXISTS workspace_audit_events (
	id               text          PRIMARY KEY,
	workspace_id     text          NOT NULL REFERENCES workspaces (id),
	actor_user_id    text          NOT NULL REFERENCES users (id),
	action           text          NOT NULL,
	target_type      text          NOT NULL,
	target_id        text,
	-- Free-form context. Per-action shape lives in code; here it
	-- carries whatever the writer thought was useful: the revoked
	-- token's prefix, the new role for a member, the URL host of a
	-- new webhook, etc.
	details          jsonb         NOT NULL DEFAULT '{}'::jsonb,
	created_at       timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_audit_events_ws_ts_idx
	ON workspace_audit_events (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workspace_audit_events_actor_idx
	ON workspace_audit_events (workspace_id, actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workspace_audit_events_action_idx
	ON workspace_audit_events (workspace_id, action, created_at DESC);
