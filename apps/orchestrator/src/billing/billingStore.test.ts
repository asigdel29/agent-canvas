import { describe, expect, it } from 'vitest'
import { InMemoryBillingStore } from './billingStore.js'
import type { WorkspaceId } from '../tenancy/tenancyTypes.js'

const W = 'ws_a' as WorkspaceId
const W_OTHER = 'ws_b' as WorkspaceId

describe('InMemoryBillingStore', () => {
	it('upsertCustomer creates then updates on the same workspace_id', async () => {
		const s = new InMemoryBillingStore()
		const a = await s.upsertCustomer({
			workspace_id: W,
			stripe_customer_id: 'cus_1',
			email: 'a@example.com',
		})
		const b = await s.upsertCustomer({
			workspace_id: W,
			stripe_customer_id: 'cus_1',
			email: 'b@example.com',
		})
		// Same workspace = same row; email is the latest write.
		expect(a.created_at).toBe(b.created_at)
		expect(b.email).toBe('b@example.com')
	})

	it('getCustomerByStripeId resolves cross-direction', async () => {
		const s = new InMemoryBillingStore()
		await s.upsertCustomer({ workspace_id: W, stripe_customer_id: 'cus_1' })
		const r = await s.getCustomerByStripeId('cus_1')
		expect(r?.workspace_id).toBe(W)
	})

	it('getStatus returns "none" for a workspace with no subscription', async () => {
		const s = new InMemoryBillingStore()
		const status = await s.getStatus(W)
		expect(status.live).toBe(false)
		expect(status.status).toBe('none')
	})

	it('upsertSubscription + getStatus reports live for active', async () => {
		const s = new InMemoryBillingStore()
		await s.upsertCustomer({ workspace_id: W, stripe_customer_id: 'cus_1' })
		await s.upsertSubscription({
			stripe_subscription_id: 'sub_1',
			workspace_id: W,
			stripe_customer_id: 'cus_1',
			status: 'active',
			stripe_price_id: 'price_pro',
			plan_lookup_key: 'pro_monthly',
			current_period_end: '2026-12-31T00:00:00Z',
		})
		const status = await s.getStatus(W)
		expect(status.live).toBe(true)
		expect(status.status).toBe('active')
		expect(status.plan_lookup_key).toBe('pro_monthly')
		expect(status.current_period_end).toBe('2026-12-31T00:00:00Z')
	})

	it('getStatus reports past_due as live (grace window)', async () => {
		const s = new InMemoryBillingStore()
		await s.upsertSubscription({
			stripe_subscription_id: 'sub_1',
			workspace_id: W,
			stripe_customer_id: 'cus_1',
			status: 'past_due',
			stripe_price_id: 'price_pro',
		})
		const status = await s.getStatus(W)
		expect(status.live).toBe(true)
		expect(status.status).toBe('past_due')
	})

	it('getStatus reports trialing as live', async () => {
		const s = new InMemoryBillingStore()
		await s.upsertSubscription({
			stripe_subscription_id: 'sub_1',
			workspace_id: W,
			stripe_customer_id: 'cus_1',
			status: 'trialing',
			stripe_price_id: 'price_pro',
		})
		expect((await s.getStatus(W)).live).toBe(true)
	})

	it('getStatus does NOT report canceled as live', async () => {
		const s = new InMemoryBillingStore()
		await s.upsertSubscription({
			stripe_subscription_id: 'sub_1',
			workspace_id: W,
			stripe_customer_id: 'cus_1',
			status: 'canceled',
			stripe_price_id: 'price_pro',
		})
		const status = await s.getStatus(W)
		// pickLiveSubscription returned null, so "none".
		expect(status.status).toBe('none')
		expect(status.live).toBe(false)
	})

	it('updating a subscription status flips live state', async () => {
		const s = new InMemoryBillingStore()
		await s.upsertSubscription({
			stripe_subscription_id: 'sub_1',
			workspace_id: W,
			stripe_customer_id: 'cus_1',
			status: 'active',
			stripe_price_id: 'price_pro',
		})
		expect((await s.getStatus(W)).live).toBe(true)
		await s.upsertSubscription({
			stripe_subscription_id: 'sub_1',
			workspace_id: W,
			stripe_customer_id: 'cus_1',
			status: 'canceled',
			stripe_price_id: 'price_pro',
		})
		expect((await s.getStatus(W)).live).toBe(false)
	})

	it('cross-workspace subscriptions do not leak', async () => {
		const s = new InMemoryBillingStore()
		await s.upsertSubscription({
			stripe_subscription_id: 'sub_other',
			workspace_id: W_OTHER,
			stripe_customer_id: 'cus_other',
			status: 'active',
			stripe_price_id: 'price_pro',
		})
		expect((await s.getStatus(W)).live).toBe(false)
	})

	it('cancel_at_period_end surfaces on the BillingStatus', async () => {
		const s = new InMemoryBillingStore()
		await s.upsertSubscription({
			stripe_subscription_id: 'sub_1',
			workspace_id: W,
			stripe_customer_id: 'cus_1',
			status: 'active',
			stripe_price_id: 'price_pro',
			cancel_at_period_end: true,
		})
		const status = await s.getStatus(W)
		expect(status.live).toBe(true)
		expect(status.cancel_at_period_end).toBe(true)
	})
})
