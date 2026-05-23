-- Schema v1 for the agent-canvas orchestrator.
--
-- Tables (in dependency order, no circular FKs):
--
--   event_log           append-only authoritative log
--   run_current_state   O(1) denormalized cache, updated in-TX with event_log
--   idempotency_keys    command idempotency
--   audit_log           durable forensic record
--   subscriptions       per-subscription delegated capability
--   project_budgets     spend ceiling per project
--   project_spend       accrued spend per project window
--   outbox              transactional outbox bridging event_log → projection
--
-- All tables use IDs and timestamps as text (ISO 8601 strings) so the
-- TypeScript types map cleanly without coercion. Postgres timestamptz
-- is used additionally for ranges/sorts where useful.

CREATE TABLE IF NOT EXISTS event_log (
	run_id              text     NOT NULL,
	seq                 integer  NOT NULL,
	kind                text     NOT NULL,
	ts                  text     NOT NULL,
	schema_version      integer  NOT NULL DEFAULT 1,
	payload             jsonb    NOT NULL DEFAULT '{}'::jsonb,
	provider_event_id   text,
	vendor              text,
	created_at          timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (run_id, seq)
);

-- Idempotency: at most one event per (run_id, provider_event_id).
CREATE UNIQUE INDEX IF NOT EXISTS event_log_provider_event_idx
	ON event_log (run_id, provider_event_id)
	WHERE provider_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS event_log_run_seq_idx
	ON event_log (run_id, seq);

-- run_current_state — one row per run; updated in same TX as event_log
-- via the monotonicity predicate (last_seq < new_seq).
CREATE TABLE IF NOT EXISTS run_current_state (
	run_id          text     PRIMARY KEY,
	status          text     NOT NULL,
	vendor          text,
	last_seq        integer  NOT NULL,
	last_event_at   text     NOT NULL,
	schema_version  integer  NOT NULL DEFAULT 1,
	updated_at      text     NOT NULL
);

-- Idempotency store — INSERT ... ON CONFLICT DO NOTHING for dedup.
CREATE TABLE IF NOT EXISTS idempotency_keys (
	key             text     PRIMARY KEY,
	result_run_id   text     NOT NULL,
	created_at      timestamptz NOT NULL DEFAULT now()
);

-- Audit log — durable, queryable by run / user / room / time.
CREATE TABLE IF NOT EXISTS audit_log (
	id                          text     PRIMARY KEY,
	ts                          text     NOT NULL,
	actor_user_id               text     NOT NULL,
	room_id                     text     NOT NULL,
	run_id                      text,
	action                      text     NOT NULL,
	result                      text     NOT NULL,
	subscription_id             text,
	established_by_user_id      text,
	trace_id                    text     NOT NULL,
	details                     jsonb    NOT NULL DEFAULT '{}'::jsonb,
	created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_run_idx     ON audit_log (run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_user_idx    ON audit_log (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_room_idx    ON audit_log (room_id, created_at DESC);

-- Per-subscription delegated capability (Eng review decision 38).
CREATE TABLE IF NOT EXISTS subscriptions (
	id                          text     PRIMARY KEY,
	run_id                      text     NOT NULL,
	origin_room_id              text     NOT NULL,
	target_room_id              text     NOT NULL,
	established_by_user_id      text     NOT NULL,
	allowed_actions             text[]   NOT NULL DEFAULT ARRAY['approve','reject','cancel'],
	subscription_epoch          integer  NOT NULL DEFAULT 1,
	created_at                  text     NOT NULL,
	revoked_at                  text
);

CREATE INDEX IF NOT EXISTS subscriptions_run_idx ON subscriptions (run_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS subscriptions_target_idx
	ON subscriptions (run_id, target_room_id) WHERE revoked_at IS NULL;

-- Project budgets and spend (billing gate).
CREATE TABLE IF NOT EXISTS project_budgets (
	project_id      text     PRIMARY KEY,
	window_seconds  integer  NOT NULL,
	ceiling_micros  bigint   NOT NULL
);

CREATE TABLE IF NOT EXISTS project_spend (
	project_id           text     PRIMARY KEY,
	window_started_at    text     NOT NULL,
	accrued_micros       bigint   NOT NULL DEFAULT 0
);

-- Transactional outbox. Enqueue MUST happen in the same TX as the
-- event_log append. A drainer picks up undelivered rows.
CREATE TABLE IF NOT EXISTS outbox (
	id              text     PRIMARY KEY,
	run_id          text     NOT NULL,
	seq             integer  NOT NULL,
	event           jsonb    NOT NULL,
	enqueued_at     timestamptz NOT NULL DEFAULT now(),
	attempts        integer  NOT NULL DEFAULT 0,
	delivered_at    timestamptz
);

CREATE INDEX IF NOT EXISTS outbox_pending_idx
	ON outbox (enqueued_at) WHERE delivered_at IS NULL;
