-- Schema v8: Stripe billing foundation.
--
-- Two tables, one for the Customer side (1:1 with workspace) and
-- one for the active Subscription. The Subscription row holds a
-- snapshot of the plan ID + current_period_end so a billing gate
-- can answer 'is this workspace active?' from one row, no Stripe
-- API call required on every request.
--
-- Why a snapshot rather than fetching from Stripe live:
--   1. Outbound calls to Stripe in the request hot path add 50-200ms
--      and risk a Stripe outage cascading into our outage.
--   2. Stripe rate-limits aggressively.
--   3. The snapshot is updated atomically when the webhook arrives;
--      there's no realistic drift window during normal operation.
--
-- We do NOT store payment method details, invoice line items, or
-- usage records here. Those live in Stripe; if we ever need them
-- they fetch through the Stripe API on demand. The local schema
-- holds only what the gate needs to decide allow/deny.
--
-- Soft delete via canceled_at. A subscription that ends keeps the
-- row so 'previous plan' lookups for grace periods stay possible.

CREATE TABLE IF NOT EXISTS stripe_customers (
	workspace_id          text          PRIMARY KEY REFERENCES workspaces (id),
	stripe_customer_id    text          NOT NULL UNIQUE,
	-- Email that the customer registered with Stripe. Stripe's
	-- source of truth, mirrored here so we don't round-trip to the
	-- Stripe API to show 'Billing email' in settings.
	email                 text,
	created_at            timestamptz   NOT NULL DEFAULT now(),
	updated_at            timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_subscriptions (
	stripe_subscription_id   text         PRIMARY KEY,
	workspace_id             text         NOT NULL REFERENCES workspaces (id),
	stripe_customer_id       text         NOT NULL,
	-- Stripe values: active, trialing, past_due, canceled, unpaid,
	-- incomplete, incomplete_expired, paused. The gate treats
	-- {active, trialing, past_due} as live; everything else is
	-- inactive. past_due gives the customer a few days to fix
	-- payment before we cut them off.
	status                   text         NOT NULL,
	stripe_price_id          text         NOT NULL,
	-- Plan tier name as Stripe set it (Lookup key on the Price
	-- object). Mirrored here so we can branch on plan without
	-- another Stripe API call.
	plan_lookup_key          text,
	current_period_start     timestamptz,
	current_period_end       timestamptz,
	cancel_at_period_end     boolean      NOT NULL DEFAULT false,
	canceled_at              timestamptz,
	created_at               timestamptz  NOT NULL DEFAULT now(),
	updated_at               timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_subscriptions_workspace_idx
	ON billing_subscriptions (workspace_id);

-- A workspace can in principle have multiple subscription rows over
-- time (each one ends, the next one starts), so this is not a
-- unique constraint. The "current" subscription is the one with
-- status IN ('active','trialing','past_due') ordered by created_at
-- DESC; the read path enforces that selection.
