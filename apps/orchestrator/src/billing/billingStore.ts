/**
 * billingStore — read/write Stripe customer + subscription state.
 *
 * Two abstractions in one store because the Stripe webhook flow
 * touches both together: a checkout.session.completed event
 * creates the customer (if new) AND attaches the subscription in
 * the same transaction. Splitting the abstractions would make the
 * webhook handler do a two-phase commit by hand.
 *
 * The read shape that callers actually use is `getStatus(workspace_id)`
 * which collapses the customer+subscription rows into a single
 * BillingStatus value (active / trialing / past_due / inactive /
 * none). The BillingGate (src/orchestration/billingGate.ts) calls
 * this on every protected route; it MUST be fast (one row read).
 */

import type { SqlClient } from '../postgres/client.js'
import type { WorkspaceId } from '../tenancy/tenancyTypes.js'

/** Stripe subscription statuses we care about, plus our local 'none'. */
export type SubscriptionStatus =
	| 'active'
	| 'trialing'
	| 'past_due'
	| 'canceled'
	| 'unpaid'
	| 'incomplete'
	| 'incomplete_expired'
	| 'paused'

/**
 * Statuses that should pass the gate. `past_due` is included so a
 * customer with a recent failed payment gets a few days to fix it
 * before they lose access; Stripe's dunning emails handle the
 * grace-period messaging.
 */
const LIVE_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
	'active',
	'trialing',
	'past_due',
])

export interface StripeCustomerRecord {
	readonly workspace_id: WorkspaceId
	readonly stripe_customer_id: string
	readonly email: string | null
	readonly created_at: string
	readonly updated_at: string
}

export interface SubscriptionRecord {
	readonly stripe_subscription_id: string
	readonly workspace_id: WorkspaceId
	readonly stripe_customer_id: string
	readonly status: SubscriptionStatus
	readonly stripe_price_id: string
	readonly plan_lookup_key: string | null
	readonly current_period_start: string | null
	readonly current_period_end: string | null
	readonly cancel_at_period_end: boolean
	readonly canceled_at: string | null
	readonly created_at: string
	readonly updated_at: string
}

export interface BillingStatus {
	readonly live: boolean
	readonly status: SubscriptionStatus | 'none'
	readonly plan_lookup_key: string | null
	readonly current_period_end: string | null
	readonly cancel_at_period_end: boolean
}

export const BILLING_STATUS_NONE: BillingStatus = {
	live: false,
	status: 'none',
	plan_lookup_key: null,
	current_period_end: null,
	cancel_at_period_end: false,
}

export interface UpsertCustomerInput {
	readonly workspace_id: WorkspaceId
	readonly stripe_customer_id: string
	readonly email?: string | null
}

export interface UpsertSubscriptionInput {
	readonly stripe_subscription_id: string
	readonly workspace_id: WorkspaceId
	readonly stripe_customer_id: string
	readonly status: SubscriptionStatus
	readonly stripe_price_id: string
	readonly plan_lookup_key?: string | null
	readonly current_period_start?: string | null
	readonly current_period_end?: string | null
	readonly cancel_at_period_end?: boolean
	readonly canceled_at?: string | null
}

export interface BillingStore {
	upsertCustomer(input: UpsertCustomerInput): Promise<StripeCustomerRecord>
	upsertSubscription(input: UpsertSubscriptionInput): Promise<SubscriptionRecord>
	getCustomer(workspace_id: WorkspaceId): Promise<StripeCustomerRecord | null>
	getCustomerByStripeId(stripe_customer_id: string): Promise<StripeCustomerRecord | null>
	getStatus(workspace_id: WorkspaceId): Promise<BillingStatus>
}

function pickLiveSubscription(rows: readonly SubscriptionRecord[]): SubscriptionRecord | null {
	const live = rows.filter((r) => LIVE_STATUSES.has(r.status))
	if (live.length === 0) return null
	// If somehow multiple live subscriptions exist (manual override
	// in Stripe, migration mid-flight), pick the most recent.
	return live.reduce((a, b) => (a.created_at > b.created_at ? a : b))
}

function statusFromSubscription(sub: SubscriptionRecord | null): BillingStatus {
	if (!sub) return BILLING_STATUS_NONE
	return {
		live: LIVE_STATUSES.has(sub.status),
		status: sub.status,
		plan_lookup_key: sub.plan_lookup_key,
		current_period_end: sub.current_period_end,
		cancel_at_period_end: sub.cancel_at_period_end,
	}
}

/* -------------------------------------------------------------- *
 * In-memory                                                       *
 * -------------------------------------------------------------- */

export class InMemoryBillingStore implements BillingStore {
	private readonly customers = new Map<WorkspaceId, StripeCustomerRecord>()
	private readonly customerByStripe = new Map<string, WorkspaceId>()
	private readonly subscriptions = new Map<string, SubscriptionRecord>()

	async upsertCustomer(input: UpsertCustomerInput): Promise<StripeCustomerRecord> {
		const now = new Date().toISOString()
		const existing = this.customers.get(input.workspace_id)
		const rec: StripeCustomerRecord = {
			workspace_id: input.workspace_id,
			stripe_customer_id: input.stripe_customer_id,
			email: input.email ?? existing?.email ?? null,
			created_at: existing?.created_at ?? now,
			updated_at: now,
		}
		this.customers.set(input.workspace_id, rec)
		this.customerByStripe.set(input.stripe_customer_id, input.workspace_id)
		return rec
	}

	async upsertSubscription(input: UpsertSubscriptionInput): Promise<SubscriptionRecord> {
		const now = new Date().toISOString()
		const existing = this.subscriptions.get(input.stripe_subscription_id)
		const rec: SubscriptionRecord = {
			stripe_subscription_id: input.stripe_subscription_id,
			workspace_id: input.workspace_id,
			stripe_customer_id: input.stripe_customer_id,
			status: input.status,
			stripe_price_id: input.stripe_price_id,
			plan_lookup_key: input.plan_lookup_key ?? existing?.plan_lookup_key ?? null,
			current_period_start:
				input.current_period_start ?? existing?.current_period_start ?? null,
			current_period_end: input.current_period_end ?? existing?.current_period_end ?? null,
			cancel_at_period_end:
				input.cancel_at_period_end ?? existing?.cancel_at_period_end ?? false,
			canceled_at: input.canceled_at ?? existing?.canceled_at ?? null,
			created_at: existing?.created_at ?? now,
			updated_at: now,
		}
		this.subscriptions.set(input.stripe_subscription_id, rec)
		return rec
	}

	async getCustomer(workspace_id: WorkspaceId): Promise<StripeCustomerRecord | null> {
		return this.customers.get(workspace_id) ?? null
	}

	async getCustomerByStripeId(
		stripe_customer_id: string
	): Promise<StripeCustomerRecord | null> {
		const ws = this.customerByStripe.get(stripe_customer_id)
		return ws ? this.customers.get(ws) ?? null : null
	}

	async getStatus(workspace_id: WorkspaceId): Promise<BillingStatus> {
		const rows: SubscriptionRecord[] = []
		for (const s of this.subscriptions.values()) {
			if (s.workspace_id === workspace_id) rows.push(s)
		}
		return statusFromSubscription(pickLiveSubscription(rows))
	}
}

/* -------------------------------------------------------------- *
 * Postgres                                                        *
 * -------------------------------------------------------------- */

interface CustomerRow {
	workspace_id: string
	stripe_customer_id: string
	email: string | null
	created_at: Date
	updated_at: Date
}

interface SubscriptionRow {
	stripe_subscription_id: string
	workspace_id: string
	stripe_customer_id: string
	status: string
	stripe_price_id: string
	plan_lookup_key: string | null
	current_period_start: Date | null
	current_period_end: Date | null
	cancel_at_period_end: boolean
	canceled_at: Date | null
	created_at: Date
	updated_at: Date
}

function customerRowTo(row: CustomerRow): StripeCustomerRecord {
	return {
		workspace_id: row.workspace_id as WorkspaceId,
		stripe_customer_id: row.stripe_customer_id,
		email: row.email,
		created_at: row.created_at.toISOString(),
		updated_at: row.updated_at.toISOString(),
	}
}

function subscriptionRowTo(row: SubscriptionRow): SubscriptionRecord {
	return {
		stripe_subscription_id: row.stripe_subscription_id,
		workspace_id: row.workspace_id as WorkspaceId,
		stripe_customer_id: row.stripe_customer_id,
		status: row.status as SubscriptionStatus,
		stripe_price_id: row.stripe_price_id,
		plan_lookup_key: row.plan_lookup_key,
		current_period_start: row.current_period_start
			? row.current_period_start.toISOString()
			: null,
		current_period_end: row.current_period_end
			? row.current_period_end.toISOString()
			: null,
		cancel_at_period_end: row.cancel_at_period_end,
		canceled_at: row.canceled_at ? row.canceled_at.toISOString() : null,
		created_at: row.created_at.toISOString(),
		updated_at: row.updated_at.toISOString(),
	}
}

export class PostgresBillingStore implements BillingStore {
	constructor(private readonly sql: SqlClient) {}

	async upsertCustomer(input: UpsertCustomerInput): Promise<StripeCustomerRecord> {
		const rows = await this.sql<CustomerRow[]>`
			INSERT INTO stripe_customers (workspace_id, stripe_customer_id, email)
			VALUES (${input.workspace_id}, ${input.stripe_customer_id}, ${input.email ?? null})
			ON CONFLICT (workspace_id) DO UPDATE
				SET stripe_customer_id = EXCLUDED.stripe_customer_id,
				    email = COALESCE(EXCLUDED.email, stripe_customers.email),
				    updated_at = now()
			RETURNING *
		`
		return customerRowTo(rows[0]!)
	}

	async upsertSubscription(input: UpsertSubscriptionInput): Promise<SubscriptionRecord> {
		const rows = await this.sql<SubscriptionRow[]>`
			INSERT INTO billing_subscriptions (
				stripe_subscription_id, workspace_id, stripe_customer_id, status,
				stripe_price_id, plan_lookup_key,
				current_period_start, current_period_end,
				cancel_at_period_end, canceled_at
			) VALUES (
				${input.stripe_subscription_id},
				${input.workspace_id},
				${input.stripe_customer_id},
				${input.status},
				${input.stripe_price_id},
				${input.plan_lookup_key ?? null},
				${input.current_period_start ?? null},
				${input.current_period_end ?? null},
				${input.cancel_at_period_end ?? false},
				${input.canceled_at ?? null}
			)
			ON CONFLICT (stripe_subscription_id) DO UPDATE
				SET status = EXCLUDED.status,
				    stripe_price_id = EXCLUDED.stripe_price_id,
				    plan_lookup_key = COALESCE(EXCLUDED.plan_lookup_key, billing_subscriptions.plan_lookup_key),
				    current_period_start = COALESCE(EXCLUDED.current_period_start, billing_subscriptions.current_period_start),
				    current_period_end = COALESCE(EXCLUDED.current_period_end, billing_subscriptions.current_period_end),
				    cancel_at_period_end = EXCLUDED.cancel_at_period_end,
				    canceled_at = COALESCE(EXCLUDED.canceled_at, billing_subscriptions.canceled_at),
				    updated_at = now()
			RETURNING *
		`
		return subscriptionRowTo(rows[0]!)
	}

	async getCustomer(workspace_id: WorkspaceId): Promise<StripeCustomerRecord | null> {
		const rows = await this.sql<CustomerRow[]>`
			SELECT * FROM stripe_customers WHERE workspace_id = ${workspace_id} LIMIT 1
		`
		return rows[0] ? customerRowTo(rows[0]) : null
	}

	async getCustomerByStripeId(
		stripe_customer_id: string
	): Promise<StripeCustomerRecord | null> {
		const rows = await this.sql<CustomerRow[]>`
			SELECT * FROM stripe_customers
			WHERE stripe_customer_id = ${stripe_customer_id}
			LIMIT 1
		`
		return rows[0] ? customerRowTo(rows[0]) : null
	}

	async getStatus(workspace_id: WorkspaceId): Promise<BillingStatus> {
		// Pick the live row directly via SQL ordering; LIMIT 1 keeps it
		// to one round-trip.
		const rows = await this.sql<SubscriptionRow[]>`
			SELECT * FROM billing_subscriptions
			WHERE workspace_id = ${workspace_id}
			  AND status IN ('active', 'trialing', 'past_due')
			ORDER BY created_at DESC
			LIMIT 1
		`
		if (rows.length === 0) return BILLING_STATUS_NONE
		return statusFromSubscription(subscriptionRowTo(rows[0]!))
	}
}
