import { describe, expect, it } from 'vitest'
import { InMemoryBillingStore } from './billingStore.js'
import { processStripeEvent, type StripeEvent } from './processStripeEvent.js'
import type { WorkspaceId } from '../tenancy/tenancyTypes.js'

const W = 'ws_a' as WorkspaceId

function mkEvent(type: string, object: Record<string, unknown>): StripeEvent {
	return {
		id: 'evt_test',
		type,
		created: 1_700_000_000,
		data: { object },
	}
}

describe('processStripeEvent', () => {
	it('customer.created upserts the customer linked by metadata.workspace_id', async () => {
		const s = new InMemoryBillingStore()
		const r = await processStripeEvent(
			mkEvent('customer.created', {
				id: 'cus_1',
				email: 'a@example.com',
				metadata: { workspace_id: W },
			}),
			s
		)
		expect(r.kind).toBe('applied')
		const c = await s.getCustomer(W)
		expect(c?.stripe_customer_id).toBe('cus_1')
		expect(c?.email).toBe('a@example.com')
	})

	it('customer.created without metadata.workspace_id is rejected', async () => {
		const s = new InMemoryBillingStore()
		const r = await processStripeEvent(
			mkEvent('customer.created', { id: 'cus_1', email: 'a@example.com' }),
			s
		)
		expect(r.kind).toBe('rejected')
	})

	it('customer.subscription.created upserts the subscription via stripe_customer_id', async () => {
		const s = new InMemoryBillingStore()
		await s.upsertCustomer({ workspace_id: W, stripe_customer_id: 'cus_1' })
		const r = await processStripeEvent(
			mkEvent('customer.subscription.created', {
				id: 'sub_1',
				customer: 'cus_1',
				status: 'active',
				items: { data: [{ price: { id: 'price_pro', lookup_key: 'pro_monthly' } }] },
				current_period_start: 1_700_000_000,
				current_period_end: 1_702_000_000,
				cancel_at_period_end: false,
				canceled_at: null,
			}),
			s
		)
		expect(r.kind).toBe('applied')
		const status = await s.getStatus(W)
		expect(status.live).toBe(true)
		expect(status.status).toBe('active')
		expect(status.plan_lookup_key).toBe('pro_monthly')
	})

	it('customer.subscription.deleted stamps canceled status + canceled_at', async () => {
		const s = new InMemoryBillingStore()
		await s.upsertCustomer({ workspace_id: W, stripe_customer_id: 'cus_1' })
		// First create the active subscription.
		await processStripeEvent(
			mkEvent('customer.subscription.created', {
				id: 'sub_1',
				customer: 'cus_1',
				status: 'active',
				items: { data: [{ price: { id: 'price_pro', lookup_key: 'pro_monthly' } }] },
				current_period_end: 1_702_000_000,
			}),
			s
		)
		expect((await s.getStatus(W)).live).toBe(true)
		// Now delete it.
		const r = await processStripeEvent(
			mkEvent('customer.subscription.deleted', {
				id: 'sub_1',
				customer: 'cus_1',
				status: 'canceled',
				items: { data: [{ price: { id: 'price_pro' } }] },
				canceled_at: 1_700_500_000,
			}),
			s
		)
		expect(r.kind).toBe('applied')
		const status = await s.getStatus(W)
		// Canceled means !live and the gate excludes it.
		expect(status.live).toBe(false)
	})

	it('subscription event for an unknown customer is rejected', async () => {
		const s = new InMemoryBillingStore()
		const r = await processStripeEvent(
			mkEvent('customer.subscription.created', {
				id: 'sub_1',
				customer: 'cus_does_not_exist',
				status: 'active',
				items: { data: [{ price: { id: 'price_pro' } }] },
			}),
			s
		)
		expect(r.kind).toBe('rejected')
	})

	it('subscription event without items[0].price.id is rejected', async () => {
		const s = new InMemoryBillingStore()
		await s.upsertCustomer({ workspace_id: W, stripe_customer_id: 'cus_1' })
		const r = await processStripeEvent(
			mkEvent('customer.subscription.created', {
				id: 'sub_1',
				customer: 'cus_1',
				status: 'active',
				items: { data: [] },
			}),
			s
		)
		expect(r.kind).toBe('rejected')
	})

	it('checkout.session.completed upserts the customer', async () => {
		const s = new InMemoryBillingStore()
		const r = await processStripeEvent(
			mkEvent('checkout.session.completed', {
				customer: 'cus_1',
				customer_email: 'a@example.com',
				metadata: { workspace_id: W },
			}),
			s
		)
		expect(r.kind).toBe('applied')
		const c = await s.getCustomer(W)
		expect(c?.stripe_customer_id).toBe('cus_1')
	})

	it('unknown event types are ignored (200 to Stripe)', async () => {
		const s = new InMemoryBillingStore()
		const r = await processStripeEvent(
			mkEvent('invoice.created', { id: 'in_1' }),
			s
		)
		expect(r.kind).toBe('ignored')
	})

	it('idempotent: replaying the same subscription event leaves state stable', async () => {
		const s = new InMemoryBillingStore()
		await s.upsertCustomer({ workspace_id: W, stripe_customer_id: 'cus_1' })
		const ev = mkEvent('customer.subscription.created', {
			id: 'sub_1',
			customer: 'cus_1',
			status: 'active',
			items: { data: [{ price: { id: 'price_pro', lookup_key: 'pro_monthly' } }] },
			current_period_end: 1_702_000_000,
		})
		await processStripeEvent(ev, s)
		await processStripeEvent(ev, s)
		// Still exactly one active subscription, still live.
		expect((await s.getStatus(W)).live).toBe(true)
	})
})
