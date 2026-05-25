-- Schema v6: outbound webhook endpoints.
--
-- Lets a workspace owner register a URL that the orchestrator POSTs
-- to when an event matches their subscription. The foundation here
-- is the endpoint table itself + the signing secret. The delivery
-- queue (next migration) and the dispatch worker (cron-driven) ship
-- after this; this PR is the surface area only.
--
-- Why webhooks at all: a long-running Claude agent may take minutes
-- to hours. The canvas observes events via SSE, but customer
-- backends (a Discord notifier, a CRM update, a CI trigger) need a
-- push-mode channel. Webhooks are the lowest-friction option:
-- nothing to install, signed payloads, idempotent retries.
--
-- Signing model: HMAC-SHA256 over `<unix_ts>.<json_body>` keyed by
-- the signing_secret. The receiver verifies the timestamp is within
-- a clock-skew window (rejecting replay) and that the HMAC matches.
-- Header format: `t=<unix_ts>,v1=<hex>` (Stripe-style).
--
-- Soft delete via revoked_at so audit-log references to a revoked
-- endpoint id survive. Live lookups filter on revoked_at IS NULL.

CREATE TABLE IF NOT EXISTS webhook_endpoints (
	id               text          PRIMARY KEY,
	workspace_id     text          NOT NULL REFERENCES workspaces (id),
	user_id          text          NOT NULL REFERENCES users (id),
	url              text          NOT NULL,
	-- 32-byte random signing secret, hex-encoded. Returned to the
	-- caller exactly once on creation; subsequent GETs do not include
	-- it. Stored plaintext because we need it to sign every outgoing
	-- delivery; encrypting at rest behind a KMS key is a follow-up
	-- aligned with the vault layer in src/orchestration/vault.ts.
	signing_secret   text          NOT NULL,
	-- Subscribed event types as a Postgres array. The string '*'
	-- matches every event; otherwise the array carries explicit
	-- types like 'agent.created', 'run.completed', etc.
	events           text[]        NOT NULL DEFAULT ARRAY['*'],
	description      text,
	created_at       timestamptz   NOT NULL DEFAULT now(),
	revoked_at       timestamptz
);

CREATE INDEX IF NOT EXISTS webhook_endpoints_workspace_idx
	ON webhook_endpoints (workspace_id)
	WHERE revoked_at IS NULL;
