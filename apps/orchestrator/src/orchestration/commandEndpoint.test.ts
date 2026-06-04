import { describe, expect, it } from 'vitest'
import type { Command, RoomId, RunId, UserId } from '@agent-canvas/orchestrator-types'
import { InMemoryAuditLog } from './auditLog.js'
import {
	BillingGate,
	InMemoryBillingGateStore,
} from './billingGate.js'
import {
	CommandEndpoint,
	CommandRejected,
	StaticCapabilityResolver,
} from './commandEndpoint.js'
import { InMemoryEventLog } from './eventLog.js'
import { InMemoryIdempotencyStore } from './idempotency.js'
import { InMemoryRunCurrentStateCache } from './runCurrentState.js'
import { InMemorySubscriptionStore } from './subscriptionStore.js'
import { InMemoryOutbox } from './transactionalOutbox.js'

const ALICE: UserId = 'u_alice' as UserId
const MIRA: UserId = 'u_mira' as UserId
const ROOM_A: RoomId = 'room_a' as RoomId
const ROOM_B: RoomId = 'room_b' as RoomId
const RUN: RunId = 'run_z' as RunId

function buildHarness(opts: { withBudget?: boolean } = {}) {
	const capabilities = new StaticCapabilityResolver()
	capabilities.grant(ALICE, ROOM_A, ['view', 'edit', 'run-agents'])
	capabilities.grant(MIRA, ROOM_A, ['view'])
	capabilities.grant(MIRA, ROOM_B, ['view', 'subscriber-actor'])

	const subscriptions = new InMemorySubscriptionStore()

	const billingStore = new InMemoryBillingGateStore()
	if (opts.withBudget) {
		billingStore.setBudget({
			project_id: 'proj_a',
			window_seconds: 86400,
			ceiling_micros: 1_000_000_000,
		})
	}
	const billingGate = opts.withBudget ? new BillingGate(billingStore) : null

	const endpoint = new CommandEndpoint({
		capabilities,
		subscriptions,
		billingGate,
		idempotency: new InMemoryIdempotencyStore(),
		eventLog: new InMemoryEventLog(),
		runCurrentState: new InMemoryRunCurrentStateCache(),
		outbox: new InMemoryOutbox(),
		auditLog: new InMemoryAuditLog(),
		projectIdForRoom: (room_id) => (room_id === ROOM_A ? 'proj_a' : 'proj_b'),
		originRoomForRun: async () => ROOM_A,
	})
	return { endpoint, capabilities, subscriptions, billingStore }
}

function cmd(overrides: Partial<Command> = {}): Command {
	return {
		kind: 'start_request',
		run_id: RUN,
		room_id: ROOM_A,
		actor_user_id: ALICE,
		idempotency_key: `idk_${Math.random().toString(16).slice(2)}`,
		payload: { taskSpec: { goal: 'demo' } },
		ts: new Date().toISOString(),
		...overrides,
	}
}

describe('CommandEndpoint', () => {
	it('accepts a start_request from a user with run-agents capability', async () => {
		const h = buildHarness({ withBudget: true })
		const result = await h.endpoint.accept(cmd())
		expect(result.seq).toBeGreaterThan(0)
		expect(result.deduped).toBe(false)
		expect(result.trace_id).toBeTruthy()
	})

	it('rejects start_request from a user without run-agents', async () => {
		const h = buildHarness({ withBudget: true })
		await expect(h.endpoint.accept(cmd({ actor_user_id: MIRA }))).rejects.toMatchObject({
			name: 'CommandRejected',
			reason: 'unauthorized',
		})
	})

	it('rejects start_request when billing budget is exhausted', async () => {
		const h = buildHarness({ withBudget: true })
		h.billingStore.setBudget({
			project_id: 'proj_a',
			window_seconds: 86400,
			ceiling_micros: 1_000,
		})
		// Force accrual past the ceiling.
		await h.billingStore.recordSpend('proj_a', 5_000)
		await expect(h.endpoint.accept(cmd())).rejects.toMatchObject({
			name: 'CommandRejected',
			reason: 'budget_exhausted',
		})
	})

	it('dedupes on a repeated idempotency_key', async () => {
		const h = buildHarness({ withBudget: true })
		const key = 'key_dup'
		const r1 = await h.endpoint.accept(cmd({ idempotency_key: key }))
		const r2 = await h.endpoint.accept(cmd({ idempotency_key: key }))
		expect(r1.deduped).toBe(false)
		expect(r2.deduped).toBe(true)
	})

	it('cross-room approve REQUIRES subscription_epoch', async () => {
		const h = buildHarness({ withBudget: true })
		await h.subscriptions.establish({
			run_id: RUN,
			origin_room_id: ROOM_A,
			target_room_id: ROOM_B,
			established_by_user_id: ALICE,
		})
		await expect(
			h.endpoint.accept(
				cmd({
					kind: 'approve',
					room_id: ROOM_B,
					actor_user_id: MIRA,
					payload: {},
				})
			)
		).rejects.toMatchObject({ reason: 'stale_subscription_epoch' })
	})

	it('cross-room approve succeeds with matching epoch + subscriber-actor capability', async () => {
		const h = buildHarness({ withBudget: true })
		const sub = await h.subscriptions.establish({
			run_id: RUN,
			origin_room_id: ROOM_A,
			target_room_id: ROOM_B,
			established_by_user_id: ALICE,
		})
		const result = await h.endpoint.accept(
			cmd({
				kind: 'approve',
				room_id: ROOM_B,
				actor_user_id: MIRA,
				subscription_epoch: sub.subscription_epoch,
				payload: { decision: 'approved' },
			})
		)
		expect(result.seq).toBeGreaterThan(0)
	})

	it('cross-room approve fails with stale epoch after subscription edit', async () => {
		const h = buildHarness({ withBudget: true })
		const sub = await h.subscriptions.establish({
			run_id: RUN,
			origin_room_id: ROOM_A,
			target_room_id: ROOM_B,
			established_by_user_id: ALICE,
		})
		await h.subscriptions.edit(sub.id, ['reject']) // bump epoch
		await expect(
			h.endpoint.accept(
				cmd({
					kind: 'approve',
					room_id: ROOM_B,
					actor_user_id: MIRA,
					subscription_epoch: sub.subscription_epoch, // now stale
					payload: {},
				})
			)
		).rejects.toBeInstanceOf(CommandRejected)
	})
})
