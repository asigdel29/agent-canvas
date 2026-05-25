-- Schema v4: users, workspaces, workspace_members.
--
-- The foundation for multi-tenancy. Until this migration the
-- orchestrator was effectively single-tenant: every authenticated
-- user could hit any workspace because workspace_id was just a
-- string alias for the room_id (the canvas's per-session room).
-- This migration introduces:
--
--   users               One row per identity. id format `gh:<github_id>`
--                       for now; future SSO/email providers get their
--                       own prefix so the id space stays globally
--                       unique without collision.
--
--   workspaces          One row per workspace. owner_user_id is the
--                       creator at the time of creation; ownership
--                       transfer flips this column under the
--                       workspace_members.role='owner' lock.
--
--   workspace_members   Junction table. Roles are owner / admin /
--                       member / viewer. Composite primary key on
--                       (workspace_id, user_id); a user cannot have
--                       two distinct roles in the same workspace.
--
-- Soft delete: workspaces.archived_at preserves rows for audit,
-- since audit_log + agents both reference workspace_id forever.
-- Users have no soft delete column yet — when GDPR delete arrives
-- (P2) we add one.
--
-- Why not just key everything on auth0/clerk: we already have a
-- working GitHub OAuth flow that mints session JWTs. Bringing in a
-- third-party identity provider is a P2 expansion when SSO is
-- table stakes.

CREATE TABLE IF NOT EXISTS users (
	id               text          PRIMARY KEY,
	github_login     text,
	github_id        text          UNIQUE,
	email            text,
	name             text,
	created_at       timestamptz   NOT NULL DEFAULT now(),
	last_seen_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_github_login_idx ON users (github_login);
CREATE INDEX IF NOT EXISTS users_email_idx        ON users (email)
	WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspaces (
	id               text          PRIMARY KEY,
	name             text          NOT NULL,
	owner_user_id    text          NOT NULL REFERENCES users (id),
	created_at       timestamptz   NOT NULL DEFAULT now(),
	archived_at      timestamptz
);

CREATE INDEX IF NOT EXISTS workspaces_owner_idx
	ON workspaces (owner_user_id)
	WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS workspace_members (
	workspace_id     text          NOT NULL REFERENCES workspaces (id),
	user_id          text          NOT NULL REFERENCES users (id),
	role             text          NOT NULL
		CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
	joined_at        timestamptz   NOT NULL DEFAULT now(),
	PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS workspace_members_user_idx
	ON workspace_members (user_id);
