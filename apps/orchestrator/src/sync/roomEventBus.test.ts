/**
 * Tests for roomEventBus.
 *
 * @author asigdel29
 */

import { describe, expect, it, vi } from 'vitest'
import type { RoomId, RunEvent } from '@agent-canvas/orchestrator-types'
import { InMemoryRoomEventBus } from './roomEventBus.js'

const A: RoomId = 'room_a' as RoomId
const B: RoomId = 'room_b' as RoomId

function ev(seq: number, run_id = 'run_x'): RunEvent {
	return {
		seq,
		run_id: run_id as RunEvent['run_id'],
		kind: 'progress',
		ts: new Date().toISOString(),
		schema_version: 1,
		payload: {},
	}
}

describe('InMemoryRoomEventBus', () => {
	it('delivers published events to active subscribers', () => {
		const bus = new InMemoryRoomEventBus()
		const seen: number[] = []
		bus.subscribe(A, (e) => seen.push(e.seq))
		bus.publish(A, ev(1))
		bus.publish(A, ev(2))
		expect(seen).toEqual([1, 2])
	})

	it('does not deliver across rooms', () => {
		const bus = new InMemoryRoomEventBus()
		const inA: number[] = []
		const inB: number[] = []
		bus.subscribe(A, (e) => inA.push(e.seq))
		bus.subscribe(B, (e) => inB.push(e.seq))
		bus.publish(A, ev(1))
		bus.publish(B, ev(2))
		expect(inA).toEqual([1])
		expect(inB).toEqual([2])
	})

	it('returns a disposal hook that detaches the subscriber', () => {
		const bus = new InMemoryRoomEventBus()
		const seen: number[] = []
		const off = bus.subscribe(A, (e) => seen.push(e.seq))
		bus.publish(A, ev(1))
		off()
		bus.publish(A, ev(2))
		expect(seen).toEqual([1])
		expect(bus.subscriberCount(A)).toBe(0)
	})

	it('a throwing subscriber does not block the rest of the fan-out', () => {
		const bus = new InMemoryRoomEventBus()
		const seen: number[] = []
		bus.subscribe(A, () => {
			throw new Error('boom')
		})
		bus.subscribe(A, (e) => seen.push(e.seq))
		bus.publish(A, ev(1))
		expect(seen).toEqual([1])
	})

	it('publishing into a room with no subscribers is a no-op', () => {
		const bus = new InMemoryRoomEventBus()
		expect(() => bus.publish(A, ev(1))).not.toThrow()
		expect(bus.subscriberCount(A)).toBe(0)
	})

	it('subscriberCount reflects current attached listeners', () => {
		const bus = new InMemoryRoomEventBus()
		const off1 = bus.subscribe(A, vi.fn())
		const off2 = bus.subscribe(A, vi.fn())
		expect(bus.subscriberCount(A)).toBe(2)
		off1()
		expect(bus.subscriberCount(A)).toBe(1)
		off2()
		expect(bus.subscriberCount(A)).toBe(0)
	})
})
