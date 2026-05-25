/**
 * Pure mapping from Stripe webhook events to BillingStore writes.
 *
 * Separated from the API handler so we can test it in isolation
 * without standing up Express / Vercel functions / a real Stripe.
 * The handler does: parse JSON, verify signature, hand off here.
 *
 * Supported event types:
 *
 *   customer.created
 *   customer.updated
 *     -> upsertCustomer; workspace_id sourced from
 *        event.data.object.metadata.workspace_id which the Checkout
 *        session is required to set.
 *
 *   checkout.session.completed
 *     -> upsertCustomer + upsertSubscription. The Subscription
 *        object isn't expanded by default; the handler fetches it
 *        if needed, or relies on the customer.subscription.created
 *        event that arrives moments later. For foundation we
 *        upsert just the customer here.
 *
 *   customer.subscription.created
 *   customer.subscription.updated
 *     -> upsertSubscription. The workspace_id is resolved by
 *        looking up the customer via stripe_customer_id.
 *
 *   customer.subscription.deleted
 *     -> upsertSubscription with status='canceled' and
 *        canceled_at=event.created.
 *
 * Unknown event types are returned as 'ignored' so the API replies
 * 200 (Stripe will retry indefinitely on any other status). Stripe's
 * delivery semantics demand we always 200 unless the signature
 * failed; the processor is the right layer to decide what counts
 * as 'we have nothing to do with this'.
 */

import type { BillingStore, SubscriptionStatus } from './billingStore.js'
import type { WorkspaceId } from '../tenancy/tenancyTypes.js'

export type ProcessResult =
	| { kind: 'applied'; event_type: string }
	| { kind: 'ignored'; event_type: string; reason: string }
	| { kind: 'rejected'; event_type: string; reason: string }

/** Subset of the Stripe event envelope we care about. */
export interface StripeEvent {
	readonly id: string
	readonly type: string
	readonly created: number
	readonly data: {
		readonly object: Record<string, unknown>
	}
}

export async function processStripeEvent(
	event: StripeEvent,
	store: BillingStore
): Promise<ProcessResult> {
	switch (event.type) {
		case 'customer.created':
		case 'customer.updated': {
			const obj = event.data.object as {
				id?: string
				email?: string
				metadata?: { workspace_id?: string }
			}
			if (!obj.id || !obj.metadata?.workspace_id) {
				return {
					kind: 'rejected',
					event_type: event.type,
					reason: 'customer payload missing id or metadata.workspace_id',
				}
			}
			await store.upsertCustomer({
				workspace_id: obj.metadata.workspace_id as WorkspaceId,
				stripe_customer_id: obj.id,
				email: obj.email ?? null,
			})
			return { kind: 'applied', event_type: event.type }
		}

		case 'checkout.session.completed': {
			const obj = event.data.object as {
				customer?: string
				customer_email?: string
				metadata?: { workspace_id?: string }
			}
			if (!obj.customer || !obj.metadata?.workspace_id) {
				return {
					kind: 'rejected',
					event_type: event.type,
					reason: 'checkout session missing customer or metadata.workspace_id',
				}
			}
			await store.upsertCustomer({
				workspace_id: obj.metadata.workspace_id as WorkspaceId,
				stripe_customer_id: obj.customer,
				email: obj.customer_email ?? null,
			})
			return { kind: 'applied', event_type: event.type }
		}

		case 'customer.subscription.created':
		case 'customer.subscription.updated':
		case 'customer.subscription.deleted': {
			const obj = event.data.object as {
				id?: string
				customer?: string
				status?: string
				items?: {
					data?: Array<{
						price?: { id?: string; lookup_key?: string | null }
					}>
				}
				current_period_start?: number
				current_period_end?: number
				cancel_at_period_end?: boolean
				canceled_at?: number | null
			}
			if (!obj.id || !obj.customer || !obj.status) {
				return {
					kind: 'rejected',
					event_type: event.type,
					reason: 'subscription payload missing id, customer, or status',
				}
			}
			const customer = await store.getCustomerByStripeId(obj.customer)
			if (!customer) {
				return {
					kind: 'rejected',
					event_type: event.type,
					reason: `no local customer for stripe_customer_id ${obj.customer}`,
				}
			}
			const priceObj = obj.items?.data?.[0]?.price
			if (!priceObj?.id) {
				return {
					kind: 'rejected',
					event_type: event.type,
					reason: 'subscription payload missing items[0].price.id',
				}
			}
			// 'deleted' events arrive with status='canceled' from Stripe;
			// we honor it and stamp canceled_at to event.created when
			// the payload didn't include it.
			const status =
				event.type === 'customer.subscription.deleted'
					? ('canceled' as SubscriptionStatus)
					: (obj.status as SubscriptionStatus)
			await store.upsertSubscription({
				stripe_subscription_id: obj.id,
				workspace_id: customer.workspace_id,
				stripe_customer_id: obj.customer,
				status,
				stripe_price_id: priceObj.id,
				plan_lookup_key: priceObj.lookup_key ?? null,
				current_period_start: obj.current_period_start
					? new Date(obj.current_period_start * 1000).toISOString()
					: null,
				current_period_end: obj.current_period_end
					? new Date(obj.current_period_end * 1000).toISOString()
					: null,
				cancel_at_period_end: obj.cancel_at_period_end ?? false,
				canceled_at:
					event.type === 'customer.subscription.deleted'
						? new Date(((obj.canceled_at ?? event.created) as number) * 1000).toISOString()
						: obj.canceled_at !== null && obj.canceled_at !== undefined
							? new Date(obj.canceled_at * 1000).toISOString()
							: null,
			})
			return { kind: 'applied', event_type: event.type }
		}

		default:
			return {
				kind: 'ignored',
				event_type: event.type,
				reason: 'event type not handled',
			}
	}
}
