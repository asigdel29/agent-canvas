/**
 * SubscriptionStore — per-subscription delegated capability records.
 *
 * Eng review decision 38, reframed via outside voice: cross-room run
 * subscriptions carry an explicit action allowlist with a
 * subscription_epoch (TOCTOU guard). New target-room members do NOT
 * inherit write authority on existing subscriptions.
 *
 * Authz check at the command endpoint:
 *
 *   1. Subscription exists for (run_id, target_room) and is not revoked.
 *   2. command.subscription_epoch == current.subscription_epoch.
 *   3. command.action ∈ subscription.allowed_actions.
 *   4. Actor has the base subscriber-actor capability in target_room.
 *
 * All four must pass.
 * @author asigdel29
 */

import {
	StaleSubscriptionEpochError,
	type RoomId,
	type RunId,
	type Subscription,
	type SubscriptionAction,
	type UserId,
} from '@agent-canvas/orchestrator-types'

export interface SubscriptionStore {
	establish(input: EstablishInput): Promise<Subscription>
	get(id: string): Promise<Subscription | null>
	getForRun(run_id: RunId): Promise<readonly Subscription[]>
	getForRunAndTarget(run_id: RunId, target_room_id: RoomId): Promise<Subscription | null>
	edit(id: string, allowed_actions: readonly SubscriptionAction[]): Promise<Subscription>
	revoke(id: string): Promise<Subscription>
	/**
	 * Authorize a command against a subscription. Throws
	 * StaleSubscriptionEpochError if the command's epoch is stale.
	 * Returns the active subscription on success; null if the
	 * subscription does not exist or is revoked.
	 */
	authorize(
		run_id: RunId,
		target_room_id: RoomId,
		action: SubscriptionAction,
		observed_epoch: number
	): Promise<Subscription | null>
}

export interface EstablishInput {
	readonly run_id: RunId
	readonly origin_room_id: RoomId
	readonly target_room_id: RoomId
	readonly established_by_user_id: UserId
	readonly allowed_actions?: readonly SubscriptionAction[]
}

export class InMemorySubscriptionStore implements SubscriptionStore {
	private readonly subs = new Map<string, Subscription>()
	private nextId = 1

	async establish(input: EstablishInput): Promise<Subscription> {
		const id = `sub_${this.nextId++}`
		const sub: Subscription = {
			id,
			run_id: input.run_id,
			origin_room_id: input.origin_room_id,
			target_room_id: input.target_room_id,
			established_by_user_id: input.established_by_user_id,
			allowed_actions: input.allowed_actions ?? ['approve', 'reject', 'cancel'],
			subscription_epoch: 1,
			created_at: new Date().toISOString(),
			revoked_at: null,
		}
		this.subs.set(id, sub)
		return sub
	}

	async get(id: string): Promise<Subscription | null> {
		return this.subs.get(id) ?? null
	}

	async getForRun(run_id: RunId): Promise<readonly Subscription[]> {
		return [...this.subs.values()].filter((s) => s.run_id === run_id && s.revoked_at === null)
	}

	async getForRunAndTarget(
		run_id: RunId,
		target_room_id: RoomId
	): Promise<Subscription | null> {
		for (const s of this.subs.values()) {
			if (s.run_id === run_id && s.target_room_id === target_room_id && s.revoked_at === null) {
				return s
			}
		}
		return null
	}

	async edit(id: string, allowed_actions: readonly SubscriptionAction[]): Promise<Subscription> {
		const sub = this.subs.get(id)
		if (!sub) throw new Error(`subscription not found: ${id}`)
		const next: Subscription = {
			...sub,
			allowed_actions,
			subscription_epoch: sub.subscription_epoch + 1,
		}
		this.subs.set(id, next)
		return next
	}

	async revoke(id: string): Promise<Subscription> {
		const sub = this.subs.get(id)
		if (!sub) throw new Error(`subscription not found: ${id}`)
		const next: Subscription = {
			...sub,
			revoked_at: new Date().toISOString(),
			subscription_epoch: sub.subscription_epoch + 1,
		}
		this.subs.set(id, next)
		return next
	}

	async authorize(
		run_id: RunId,
		target_room_id: RoomId,
		action: SubscriptionAction,
		observed_epoch: number
	): Promise<Subscription | null> {
		const sub = await this.getForRunAndTarget(run_id, target_room_id)
		if (!sub) return null
		if (sub.subscription_epoch !== observed_epoch) {
			throw new StaleSubscriptionEpochError(observed_epoch, sub.subscription_epoch)
		}
		if (!sub.allowed_actions.includes(action)) return null
		return sub
	}
}
