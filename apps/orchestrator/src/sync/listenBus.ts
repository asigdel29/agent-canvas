/**
 * ListenBus — Postgres LISTEN subscription multiplexer.
 *
 * One ListenBus instance opens ONE session-mode Postgres connection
 * that holds LISTEN on every active room channel. Local subscribers
 * (SSE handlers, in-process consumers) attach via `subscribe(room_id,
 * handler)`. When a NOTIFY arrives, the bus dispatches to all handlers
 * for that room.
 *
 * The single-connection design matters for Neon's session-pool budget:
 * many client SSE connections can multiplex over one upstream LISTEN.
 *
 * Production deployment runs one ListenBus per Vercel function
 * instance (Fluid Compute reuses instances; the bus survives across
 * requests within an instance).
 */

import { createSqlClient, type SqlClient } from '../postgres/client.js'
import { channelForRoom } from './notify.js'

export interface ListenBusOptions {
	readonly sql?: SqlClient
}

export type RoomListener = (payload: NotifyMessage) => void

export interface NotifyMessage {
	readonly room_id: string
	readonly seq_watermark: number
}

export class ListenBus {
	private readonly sql: SqlClient
	private readonly listenersByRoom = new Map<string, Set<RoomListener>>()
	private readonly listeningChannels = new Set<string>()

	constructor(opts: ListenBusOptions = {}) {
		this.sql = opts.sql ?? createSqlClient({ session: true })
	}

	async subscribe(room_id: string, listener: RoomListener): Promise<() => void> {
		const channel = channelForRoom(room_id)
		let set = this.listenersByRoom.get(channel)
		if (!set) {
			set = new Set()
			this.listenersByRoom.set(channel, set)
		}
		set.add(listener)

		if (!this.listeningChannels.has(channel)) {
			this.listeningChannels.add(channel)
			await this.sql.listen(channel, (raw) => this.dispatch(channel, raw))
		}

		return () => {
			set!.delete(listener)
			if (set!.size === 0) {
				// We keep the upstream LISTEN open even with no local
				// subscribers — re-subscription is cheap, and tearing down
				// LISTEN at runtime adds connection-state complexity. The
				// connection releases on close().
			}
		}
	}

	private dispatch(channel: string, raw: string): void {
		const listeners = this.listenersByRoom.get(channel)
		if (!listeners || listeners.size === 0) return
		let parsed: { r?: string; s?: number }
		try {
			parsed = JSON.parse(raw) as { r?: string; s?: number }
		} catch {
			return
		}
		const room_id = parsed.r
		const seq_watermark = parsed.s
		if (typeof room_id !== 'string' || typeof seq_watermark !== 'number') return
		const msg: NotifyMessage = { room_id, seq_watermark }
		for (const fn of listeners) {
			try {
				fn(msg)
			} catch {
				// listener exceptions never abort the dispatch loop
			}
		}
	}

	async close(): Promise<void> {
		this.listenersByRoom.clear()
		this.listeningChannels.clear()
		await this.sql.end({ timeout: 5 })
	}
}
