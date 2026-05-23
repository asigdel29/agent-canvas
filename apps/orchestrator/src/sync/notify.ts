/**
 * Postgres NOTIFY emission for the realtime sync layer.
 *
 * Phase 0 research (docs/phase-0/sync-backend-research.md) settled on
 * Postgres LISTEN/NOTIFY for per-room fanout on Vercel. The outbox
 * drainer calls `notifyRoom` after a successful projection write; SSE
 * connections subscribed via `ListenBus` receive the wake signal and
 * pull the new rows from the projection tables.
 *
 * NOTIFY payloads are limited to 8KB and untyped strings — we send
 * only the room_id + max seq watermark. Subscribers SELECT the actual
 * payload from the projection tables. This keeps fanout cheap and
 * pgbouncer-safe.
 */

import type { SqlClient } from '../postgres/client.js'

export interface NotifyPayload {
	readonly room_id: string
	readonly seq_watermark: number
}

/** Build the channel name for a given room. */
export function channelForRoom(room_id: string): string {
	// Postgres channel names follow identifier rules (no dashes etc).
	// Hash + 'room_' prefix is safe and stable.
	let h = 0
	for (let i = 0; i < room_id.length; i += 1) {
		h = (h * 31 + room_id.charCodeAt(i)) | 0
	}
	return `room_${(h >>> 0).toString(36)}`
}

export async function notifyRoom(sql: SqlClient, payload: NotifyPayload): Promise<void> {
	const channel = channelForRoom(payload.room_id)
	// pg_notify(channel text, payload text). Body is opaque JSON for now.
	const body = JSON.stringify({ r: payload.room_id, s: payload.seq_watermark })
	await sql`SELECT pg_notify(${channel}, ${body})`
}
