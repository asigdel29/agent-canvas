-- Schema v9: webhook delivery queue.
--
-- P6 shipped the endpoint registration; this table is the worklist
-- the dispatcher drains. Each row represents one (endpoint, event)
-- attempt; on transient failure (5xx, network timeout) the row is
-- not deleted, just rescheduled via next_attempt_at and bumped
-- attempt_num. After MAX_ATTEMPTS we set failed_at and stop.
--
-- The event payload is captured at enqueue time, NOT looked up at
-- delivery time. Once an event is queued it must deliver the same
-- bytes; a later state change must produce a separate event.
--
-- Idempotency for the receiver: every delivery carries the same
-- event id (the wae_* from workspace_audit_events, or a synthetic
-- id for events that don't have an audit row). The dispatcher sets
-- X-AC-Event-Id on every POST so receivers can deduplicate retries.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
	id                      text          PRIMARY KEY,
	endpoint_id             text          NOT NULL REFERENCES webhook_endpoints (id),
	event_id                text          NOT NULL,
	event_type              text          NOT NULL,
	-- The HTTP body we will POST. JSON-stringified by the dispatcher
	-- at enqueue time. Stored as text (not jsonb) because we must
	-- sign the exact bytes we send; jsonb's canonical re-encoding
	-- would break the HMAC.
	body                    text          NOT NULL,
	status                  text          NOT NULL
		CHECK (status IN ('pending', 'in_flight', 'succeeded', 'failed')),
	attempt_num             integer       NOT NULL DEFAULT 0,
	-- When the dispatcher should next try this row. NULL only for
	-- terminal states (succeeded / failed).
	next_attempt_at         timestamptz,
	-- Last response observed; populated on every attempt, kept for
	-- the operator's debug surface.
	last_status_code        integer,
	last_error              text,
	created_at              timestamptz   NOT NULL DEFAULT now(),
	succeeded_at            timestamptz,
	failed_at               timestamptz
);

-- The dispatcher reads from this index every tick: pick pending
-- rows whose next_attempt_at has passed, ordered oldest-first to
-- avoid head-of-line starvation between endpoints.
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending_idx
	ON webhook_deliveries (next_attempt_at)
	WHERE status = 'pending';

-- The operator's debug view: 'show me all failed deliveries for
-- endpoint X in the last day' is a per-endpoint scan.
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx
	ON webhook_deliveries (endpoint_id, created_at DESC);
