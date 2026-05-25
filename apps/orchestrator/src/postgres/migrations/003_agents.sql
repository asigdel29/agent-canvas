-- Schema v3: persisted agents and per-run pending-approval rows.
--
-- Tables:
--
--   agents               One row per user-defined agent. Carries the
--                        agent's name, prompt, model, capability flags,
--                        and serialized MCP server list. The shape on
--                        the canvas is a projection of this row;
--                        editing the agent updates here first, then
--                        re-renders the shape.
--
--   pending_approvals    One row per paused tool-call awaiting an
--                        operator decision. The run loop blocks here
--                        until /api/approvals/:id/approve|reject
--                        flips the row. The ApprovalInbox in the
--                        canvas reads this table over SSE.
--
-- We deliberately do NOT carry per-run state in this migration; runs
-- already exist as a projection over the event log + run_current_state.
-- Agents own the definition (what to do); the existing event-log
-- machinery owns the per-execution dynamics (what happened).

CREATE TABLE IF NOT EXISTS agents (
	id                  text         PRIMARY KEY,
	workspace_id        text         NOT NULL,
	owner_user_id       text         NOT NULL,
	name                text         NOT NULL,
	purpose             text         NOT NULL DEFAULT '',
	model               text         NOT NULL,
	system_prompt       text         NOT NULL DEFAULT '',
	-- Capability flags. Flat columns rather than a JSON blob so the
	-- billing gate and the conformance tests can query them cheaply
	-- and so a future migration can add CHECK constraints (e.g. the
	-- e2b provider requires --enabled--).
	cap_computer_use         boolean  NOT NULL DEFAULT false,
	cap_computer_use_provider text     NOT NULL DEFAULT 'none',
	cap_browser_use          boolean  NOT NULL DEFAULT false,
	cap_browser_use_persist  boolean  NOT NULL DEFAULT false,
	-- MCP server list as JSONB. Per-server validation runs in the
	-- application layer; storing as JSONB keeps the schema stable
	-- across MCP spec revisions.
	cap_mcp_servers     jsonb        NOT NULL DEFAULT '[]'::jsonb,
	created_at          timestamptz  NOT NULL DEFAULT now(),
	updated_at          timestamptz  NOT NULL DEFAULT now(),
	-- archived_at provides soft-delete; we never hard-delete because
	-- audit_log rows reference the agent id and we want them
	-- forensically readable forever.
	archived_at         timestamptz
);

CREATE INDEX IF NOT EXISTS agents_workspace_idx
	ON agents (workspace_id)
	WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS agents_owner_idx
	ON agents (owner_user_id)
	WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS pending_approvals (
	id                  text         PRIMARY KEY,
	agent_id            text         NOT NULL REFERENCES agents (id),
	run_id              text         NOT NULL,
	tool_name           text         NOT NULL,
	tool_input          jsonb        NOT NULL,
	tool_description    text         NOT NULL,
	-- Safety classification mirrors the existing SafetyClassifier
	-- output: 'destructive' (reversible with effort) or 'irreversible'
	-- (no undo). Keep narrow so the UI's two-tone treatment is
	-- exhaustive.
	safety              text         NOT NULL CHECK (safety IN ('destructive', 'irreversible')),
	requested_at        timestamptz  NOT NULL DEFAULT now(),
	-- Result columns. Both null while pending; one is set on resolve.
	resolved_at         timestamptz,
	resolved_by_user_id text,
	resolution          text         CHECK (resolution IS NULL OR resolution IN ('approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS pending_approvals_pending_idx
	ON pending_approvals (run_id, requested_at)
	WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS pending_approvals_agent_idx
	ON pending_approvals (agent_id);
