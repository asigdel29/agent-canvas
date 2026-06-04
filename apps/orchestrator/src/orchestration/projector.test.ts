import { describe, expect, it } from 'vitest'
import type { RoomId, RunEvent, RunId, Subscription } from '@agent-canvas/orchestrator-types'
import {
	InMemoryProjectionSink,
	InMemorySubscriptionResolver,
	InMemoryTombstoneOracle,
	Projector,
} from './projector.js'

const A: RoomId = 'room_a' as RoomId
const B: RoomId = 'room_b' as RoomId
const RUN: RunId = 'run_x' as RunId

function ev(kind: RunEvent['kind'], seq: number, payload: Record<string, unknown> = {}): RunEvent {
	return {
		seq,
		run_id: RUN,
		kind,
		ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
		schema_version: 1,
		payload,
	}
}

function sub(target: RoomId, revoked: string | null = null): Subscription {
	return {
		id: `sub_${target}`,
		run_id: RUN,
		origin_room_id: A,
		target_room_id: target,
		established_by_user_id: 'u_alice' as Subscription['established_by_user_id'],
		allowed_actions: ['approve', 'reject', 'cancel'],
		subscription_epoch: 1,
		created_at: '2026-01-01T00:00:00Z',
		revoked_at: revoked,
	}
}

describe('Projector', () => {
	it('writes to the origin room when no subscriptions exist', async () => {
		const resolver = new InMemorySubscriptionResolver()
		resolver.setOrigin(RUN, A)
		const sink = new InMemoryProjectionSink()
		const p = new Projector(resolver, new InMemoryTombstoneOracle(), sink)
		await p.project(ev('running', 1), 'demo run')
		expect(sink.writes).toHaveLength(1)
		expect(sink.writes[0]!.target.room_id).toBe(A)
		expect(sink.writes[0]!.target.is_origin).toBe(true)
	})

	it('fans out to origin + active subscriptions', async () => {
		const resolver = new InMemorySubscriptionResolver()
		resolver.setOrigin(RUN, A)
		resolver.addSubscription(sub(B))
		const sink = new InMemoryProjectionSink()
		const p = new Projector(resolver, new InMemoryTombstoneOracle(), sink)
		await p.project(ev('running', 1), 'demo run')
		expect(sink.writes.map((w) => w.target.room_id).sort()).toEqual([A, B].sort())
	})

	it('skips a revoked subscription', async () => {
		const resolver = new InMemorySubscriptionResolver()
		resolver.setOrigin(RUN, A)
		resolver.addSubscription(sub(B, '2026-01-01T00:00:00Z'))
		const sink = new InMemoryProjectionSink()
		const p = new Projector(resolver, new InMemoryTombstoneOracle(), sink)
		await p.project(ev('running', 1), 'demo run')
		expect(sink.writes.map((w) => w.target.room_id)).toEqual([A])
	})

	it('skips a room where the shape has been tombstoned', async () => {
		const resolver = new InMemorySubscriptionResolver()
		resolver.setOrigin(RUN, A)
		resolver.addSubscription(sub(B))
		const tombs = new InMemoryTombstoneOracle()
		tombs.mark(RUN, B)
		const sink = new InMemoryProjectionSink()
		const p = new Projector(resolver, tombs, sink)
		await p.project(ev('running', 1), 'demo run')
		expect(sink.writes.map((w) => w.target.room_id)).toEqual([A])
	})

	it('status-bearing events patch the run record; non-status events do not', async () => {
		const resolver = new InMemorySubscriptionResolver()
		resolver.setOrigin(RUN, A)
		const sink = new InMemoryProjectionSink()
		const p = new Projector(resolver, new InMemoryTombstoneOracle(), sink)
		await p.project(ev('running', 1), 'demo')
		await p.project(ev('progress', 2, { message: 'tool started' }), 'demo')
		expect(sink.writes[0]!.run_record_patch).not.toBeNull()
		expect(sink.writes[0]!.run_record_patch?.status).toBe('running')
		expect(sink.writes[1]!.run_record_patch).toBeNull()
		expect(sink.writes[1]!.event_record?.summary).toBe('tool started')
	})

	it('summarizes tool_call events with the tool name', async () => {
		const resolver = new InMemorySubscriptionResolver()
		resolver.setOrigin(RUN, A)
		const sink = new InMemoryProjectionSink()
		const p = new Projector(resolver, new InMemoryTombstoneOracle(), sink)
		await p.project(ev('tool_call', 1, { tool: 'github.create_pr' }), 'demo')
		expect(sink.writes[0]!.event_record?.summary).toBe('github.create_pr')
	})
})
