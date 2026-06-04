/**
 * sseEndpoint — composable SSE handler that subscribes a client to a
 * RoomEventBus.
 *
 * Separated from the api/sync/[room].ts route so the bulk of the logic
 * is testable as a plain function. The route file is a thin shim that
 * parses request params + calls into here.
 *
 * Lifecycle:
 *
 *   open SSE stream  → send hello → subscribe to room
 *   on bus event     → send to client
 *   client aborts    → unsubscribe + close
 *   max-age timeout  → send `data: { reconnect: true }` + close
 *                     (Vercel function timeout is 300 s; we cut at 270 s
 *                     so the client reconnects before the platform tears
 *                     us down)
 * @author asigdel29
 */

import type { RoomId } from '@agent-canvas/orchestrator-types'
import type { RoomEventBus } from './roomEventBus.js'
import { openSseStream, type SseSender } from './sseStream.js'

export interface OpenSseEndpointOptions {
	readonly room_id: RoomId
	readonly bus: RoomEventBus
	readonly abortSignal?: AbortSignal
	/** Max stream lifetime; defaults to 270 s. */
	readonly maxAgeMs?: number
	/** Override the sender (tests inject a deterministic one). */
	readonly sender?: SseSender
}

export interface OpenSseEndpointResult {
	readonly response: Response
	/** Disposal hook; call to drop the subscription early. */
	readonly close: () => void
}

export function openSseEndpoint(opts: OpenSseEndpointOptions): OpenSseEndpointResult {
	const sender = opts.sender ?? openSseStream()
	const unsubscribe = opts.bus.subscribe(opts.room_id, (event) => {
		sender.send({ type: 'event', room_id: opts.room_id, event })
	})

	sender.send({ type: 'hello', room_id: opts.room_id, ts: new Date().toISOString() })

	let timer: ReturnType<typeof setTimeout> | null = null
	const close = (sendReconnect: boolean): void => {
		unsubscribe()
		if (timer) clearTimeout(timer)
		if (sendReconnect && !sender.closed) {
			sender.send({ type: 'reconnect' })
		}
		sender.close()
	}

	const maxAge = opts.maxAgeMs ?? 270_000
	timer = setTimeout(() => close(true), maxAge)

	if (opts.abortSignal) {
		opts.abortSignal.addEventListener(
			'abort',
			() => close(false),
			{ once: true }
		)
	}

	return { response: sender.response, close: () => close(false) }
}
