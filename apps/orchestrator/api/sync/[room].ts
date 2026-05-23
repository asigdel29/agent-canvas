/**
 * GET /api/sync/:room — Server-Sent Events stream of orchestration
 * events for one room.
 *
 * The canvas client opens an EventSource against this endpoint and
 * receives every run event the orchestrator writes to the room. Auth
 * uses a JWT in the `?token=` query param because EventSource does
 * not let the client set Authorization headers.
 *
 * The stream lives ~270 s before the orchestrator emits a `reconnect`
 * hint and closes; EventSource auto-reconnects from there. This dodges
 * Vercel's 300 s function-execution cap cleanly.
 */

import { getRuntime } from '../../dist/index.js'
import { extractSession } from '../../dist/auth/session.js'
import { verifySession } from '../../dist/auth/jwt.js'
import { openSseEndpoint } from '../../dist/sync/sseEndpoint.js'
import type { RoomId } from '@agent-canvas/orchestrator-types'

export const config = {
	runtime: 'nodejs',
}

export default async function handler(req: Request): Promise<Response> {
	if (req.method !== 'GET') return jsonError(405, 'method_not_allowed')

	const secret = process.env['JWT_SECRET']
	if (!secret) return jsonError(500, 'jwt_secret_not_configured')

	const url = new URL(req.url)
	const segments = url.pathname.split('/').filter(Boolean)
	const room_id = segments[segments.length - 1] as RoomId | undefined
	if (!room_id) return jsonError(404, 'missing_room')

	// EventSource supports either an Authorization header (when the
	// browser permits it via fetch-based polyfills) or a token query
	// param. Accept both.
	let session = extractSession(req, secret)
	if (!session) {
		const token = url.searchParams.get('token')
		if (token) {
			try {
				session = verifySession(token, secret)
			} catch {
				session = null
			}
		}
	}
	if (!session) return jsonError(401, 'unauthorized')

	const runtime = getRuntime() as unknown as { roomEventBus?: import('../../dist/sync/roomEventBus.js').RoomEventBus }
	const bus = runtime.roomEventBus
	if (!bus) return jsonError(503, 'realtime_bus_not_initialized')

	const { response } = openSseEndpoint({
		room_id,
		bus,
		abortSignal: req.signal,
	})
	return response
}

function jsonError(status: number, code: string): Response {
	return new Response(JSON.stringify({ error: code }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
