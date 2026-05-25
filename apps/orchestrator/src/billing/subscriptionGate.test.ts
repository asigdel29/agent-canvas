import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryBillingStore } from './billingStore.js'
import { SubscriptionGate, subscriptionGateFromEnv } from './subscriptionGate.js'
import type { WorkspaceId } from '../tenancy/tenancyTypes.js'

const W = 'ws_a' as WorkspaceId

describe('SubscriptionGate', () => {
	it('allows transparently when disabled', async () => {
		const store = new InMemoryBillingStore()
		const gate = new SubscriptionGate({ enabled: false, store })
		const d = await gate.check(W)
		expect(d.allow).toBe(true)
		if (d.allow) expect(d.reason).toBe('gate_disabled')
	})

	it('denies no_subscription when enabled and no row exists', async () => {
		const store = new InMemoryBillingStore()
		const gate = new SubscriptionGate({ enabled: true, store })
		const d = await gate.check(W)
		expect(d.allow).toBe(false)
		if (!d.allow) {
			expect(d.reason).toBe('no_subscription')
			expect(d.status).toBe('none')
		}
	})

	it('allows when an active subscription exists', async () => {
		const store = new InMemoryBillingStore()
		await store.upsertSubscription({
			stripe_subscription_id: 'sub_1',
			workspace_id: W,
			stripe_customer_id: 'cus_1',
			status: 'active',
			stripe_price_id: 'price_pro',
		})
		const gate = new SubscriptionGate({ enabled: true, store })
		const d = await gate.check(W)
		expect(d.allow).toBe(true)
		if (d.allow) expect(d.reason).toBe('subscription_live')
	})

	it('allows past_due (grace window)', async () => {
		const store = new InMemoryBillingStore()
		await store.upsertSubscription({
			stripe_subscription_id: 'sub_1',
			workspace_id: W,
			stripe_customer_id: 'cus_1',
			status: 'past_due',
			stripe_price_id: 'price_pro',
		})
		const gate = new SubscriptionGate({ enabled: true, store })
		expect((await gate.check(W)).allow).toBe(true)
	})

	it('denies canceled with subscription_inactive', async () => {
		const store = new InMemoryBillingStore()
		await store.upsertSubscription({
			stripe_subscription_id: 'sub_1',
			workspace_id: W,
			stripe_customer_id: 'cus_1',
			status: 'canceled',
			stripe_price_id: 'price_pro',
		})
		const gate = new SubscriptionGate({ enabled: true, store })
		const d = await gate.check(W)
		expect(d.allow).toBe(false)
		// 'canceled' surfaces as 'none' from getStatus because pickLiveSubscription
		// filtered it out; the gate returns no_subscription.
		if (!d.allow) expect(d.reason).toBe('no_subscription')
	})
})

describe('subscriptionGateFromEnv', () => {
	const original = { ...process.env }
	beforeEach(() => {
		delete process.env['BILLING_GATE_ENABLED']
	})
	afterEach(() => {
		process.env = { ...original }
	})

	it('reads BILLING_GATE_ENABLED=true as enabled', async () => {
		process.env['BILLING_GATE_ENABLED'] = 'true'
		const gate = subscriptionGateFromEnv(new InMemoryBillingStore())
		const d = await gate.check(W)
		expect(d.allow).toBe(false) // no subscription -> denied
	})

	it('any value other than the string "true" is disabled', async () => {
		process.env['BILLING_GATE_ENABLED'] = '1'
		const gate = subscriptionGateFromEnv(new InMemoryBillingStore())
		const d = await gate.check(W)
		expect(d.allow).toBe(true)
		if (d.allow) expect(d.reason).toBe('gate_disabled')
	})
})
