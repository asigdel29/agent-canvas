/**
 * SubscriptionGate — refuses a write-class action when the workspace
 * lacks a live Stripe subscription.
 *
 * Distinct from the existing BillingGate, which enforces per-project
 * dollar ceilings. Two abstractions, both legitimate:
 *
 *   SubscriptionGate   "do you have a subscription at all?"
 *                       Coarse on/off; sources from billingStore.
 *
 *   BillingGate         "are you under your monthly $ ceiling?"
 *                       Per-project meter; sources from spend records.
 *
 * The route layer calls SubscriptionGate first; if it allows, the
 * BillingGate (when configured) checks the spend ceiling. Most
 * operators will run with SubscriptionGate gated and BillingGate
 * off, escalating to both once usage shape stabilizes.
 *
 * Disabled by default. Set BILLING_GATE_ENABLED=true to turn on.
 * When disabled, check() always allows — same shape as the
 * existing BillingGate's off-by-default config.
 */

import type { BillingStore } from './billingStore.js'
import type { WorkspaceId } from '../tenancy/tenancyTypes.js'

export type SubscriptionGateDecision =
	| { allow: true; reason: 'gate_disabled' | 'subscription_live'; status: string }
	| { allow: false; reason: 'no_subscription'; status: 'none' }
	| { allow: false; reason: 'subscription_inactive'; status: string }

export interface SubscriptionGateOptions {
	readonly enabled: boolean
	readonly store: BillingStore
}

export class SubscriptionGate {
	constructor(private readonly opts: SubscriptionGateOptions) {}

	async check(workspace_id: WorkspaceId): Promise<SubscriptionGateDecision> {
		if (!this.opts.enabled) {
			// Configuration-flag off; the gate is transparent. Return
			// allow with the marker reason so the route handler can
			// distinguish 'allowed because configured off' from
			// 'allowed because they paid'.
			return { allow: true, reason: 'gate_disabled', status: 'gate_disabled' }
		}
		const status = await this.opts.store.getStatus(workspace_id)
		if (status.status === 'none') {
			return { allow: false, reason: 'no_subscription', status: 'none' }
		}
		if (!status.live) {
			return { allow: false, reason: 'subscription_inactive', status: status.status }
		}
		return { allow: true, reason: 'subscription_live', status: status.status }
	}
}

/** Build from env. Reads BILLING_GATE_ENABLED. */
export function subscriptionGateFromEnv(store: BillingStore): SubscriptionGate {
	return new SubscriptionGate({
		enabled: process.env['BILLING_GATE_ENABLED'] === 'true',
		store,
	})
}
