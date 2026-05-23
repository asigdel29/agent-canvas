/**
 * RoomEventBus — in-process pub/sub keyed by room_id.
 *
 * Drives the SSE realtime layer for a single Vercel function instance.
 * For multi-instance fanout, the listenBus.ts module wraps this and
 * publishes/subscribes via Postgres LISTEN/NOTIFY.
 *
 * Each event published to a room is delivered to every active
 * subscriber for that room exactly once. Listener exceptions never
 * abort dispatch to other listeners.
 */

import type { RoomId, RunEvent } from '@agent-canvas/orchestrator-types'

export type RoomEventListener = (event: RunEvent) => void

export interface RoomEventBus {
	publish(room_id: RoomId, event: RunEvent): void
	subscribe(room_id: RoomId, listener: RoomEventListener): () => void
	subscriberCount(room_id: RoomId): number
}

export class InMemoryRoomEventBus implements RoomEventBus {
	private readonly byRoom = new Map<RoomId, Set<RoomEventListener>>()

	publish(room_id: RoomId, event: RunEvent): void {
		const listeners = this.byRoom.get(room_id)
		if (!listeners || listeners.size === 0) return
		for (const fn of listeners) {
			try {
				fn(event)
			} catch {
				// listener exceptions never abort the dispatch loop
			}
		}
	}

	subscribe(room_id: RoomId, listener: RoomEventListener): () => void {
		let set = this.byRoom.get(room_id)
		if (!set) {
			set = new Set()
			this.byRoom.set(room_id, set)
		}
		set.add(listener)
		return () => {
			set!.delete(listener)
			if (set!.size === 0) this.byRoom.delete(room_id)
		}
	}

	subscriberCount(room_id: RoomId): number {
		return this.byRoom.get(room_id)?.size ?? 0
	}
}
