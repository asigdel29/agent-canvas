import { describe, expect, it } from 'vitest'
import {
	StaleSubscriptionEpochError,
	type RoomId,
	type RunId,
	type UserId,
} from '@agent-canvas/orchestrator-types'
import { InMemorySubscriptionStore } from './subscriptionStore.js'

const RUN: RunId = 'run_x' as RunId
const A: RoomId = 'room_a' as RoomId
const B: RoomId = 'room_b' as RoomId
const U: UserId = 'u_alice' as UserId

describe('InMemorySubscriptionStore', () => {
	it('establishes a subscription with default full action set', async () => {
		const store = new InMemorySubscriptionStore()
		const s = await store.establish({
			run_id: RUN,
			origin_room_id: A,
			target_room_id: B,
			established_by_user_id: U,
		})
		expect(s.allowed_actions).toEqual(['approve', 'reject', 'cancel'])
		expect(s.subscription_epoch).toBe(1)
		expect(s.revoked_at).toBeNull()
	})

	it('authorize succeeds when epoch and action match', async () => {
		const store = new InMemorySubscriptionStore()
		const s = await store.establish({
			run_id: RUN,
			origin_room_id: A,
			target_room_id: B,
			established_by_user_id: U,
		})
		expect(await store.authorize(RUN, B, 'approve', s.subscription_epoch)).not.toBeNull()
	})

	it('authorize rejects with StaleSubscriptionEpochError on epoch mismatch', async () => {
		const store = new InMemorySubscriptionStore()
		const s = await store.establish({
			run_id: RUN,
			origin_room_id: A,
			target_room_id: B,
			established_by_user_id: U,
		})
		await expect(store.authorize(RUN, B, 'approve', s.subscription_epoch + 1)).rejects.toThrow(
			StaleSubscriptionEpochError
		)
	})

	it('authorize returns null when action not in allowlist', async () => {
		const store = new InMemorySubscriptionStore()
		const s = await store.establish({
			run_id: RUN,
			origin_room_id: A,
			target_room_id: B,
			established_by_user_id: U,
			allowed_actions: ['approve'],
		})
		expect(await store.authorize(RUN, B, 'cancel', s.subscription_epoch)).toBeNull()
	})

	it('edit bumps the epoch (TOCTOU guard)', async () => {
		const store = new InMemorySubscriptionStore()
		const s1 = await store.establish({
			run_id: RUN,
			origin_room_id: A,
			target_room_id: B,
			established_by_user_id: U,
		})
		const s2 = await store.edit(s1.id, ['approve'])
		expect(s2.subscription_epoch).toBe(s1.subscription_epoch + 1)
	})

	it('revoke bumps the epoch and sets revoked_at', async () => {
		const store = new InMemorySubscriptionStore()
		const s1 = await store.establish({
			run_id: RUN,
			origin_room_id: A,
			target_room_id: B,
			established_by_user_id: U,
		})
		const s2 = await store.revoke(s1.id)
		expect(s2.revoked_at).not.toBeNull()
		expect(s2.subscription_epoch).toBe(s1.subscription_epoch + 1)
	})

	it('authorize returns null for a revoked subscription regardless of epoch', async () => {
		const store = new InMemorySubscriptionStore()
		const s1 = await store.establish({
			run_id: RUN,
			origin_room_id: A,
			target_room_id: B,
			established_by_user_id: U,
		})
		await store.revoke(s1.id)
		expect(await store.authorize(RUN, B, 'approve', s1.subscription_epoch)).toBeNull()
	})

	it('getForRun returns only active subscriptions', async () => {
		const store = new InMemorySubscriptionStore()
		const C: RoomId = 'room_c' as RoomId
		const s1 = await store.establish({
			run_id: RUN,
			origin_room_id: A,
			target_room_id: B,
			established_by_user_id: U,
		})
		await store.establish({
			run_id: RUN,
			origin_room_id: A,
			target_room_id: C,
			established_by_user_id: U,
		})
		await store.revoke(s1.id)
		const active = await store.getForRun(RUN)
		expect(active.map((s) => s.target_room_id)).toEqual([C])
	})
})
