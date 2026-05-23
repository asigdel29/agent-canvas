/**
 * GET /api/sync/:room — Server-Sent Events stream of orchestration
 * events for one room.
 *
 * Auth: ephemeral SSE token in `?token=` (mint via POST /api/auth/sse-token).
 * Tokens are 60-second, single-use, room-scoped, HMAC'd with
 * SSE_TOKEN_SECRET. Long-lived session JWTs are NEVER accepted here —
 * URL-borne tokens leak through CDN logs and Referer headers, so the
 * exposure window is bounded by the TTL.
 *
 * The stream lives ~270 s before the orchestrator emits a `reconnect`
 * hint and closes; the canvas mints a fresh SSE token and reconnects.
 */

import { getRuntime } from '../../dist/index.js'
import { SseTokenError, verifySseToken } from '../../dist/auth/sseToken.js'
import { openSseEndpoint } from '../../dist/sync/sseEndpoint.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'
import type { RoomId } from '@agent-canvas/orchestrator-types'

export const config = {
	runtime: 'nodejs',
}

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight
	if (req.method !== 'GET') return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))

	const sseSecret = process.env['SSE_TOKEN_SECRET']
	if (!sseSecret) return withCorsHeaders(req, jsonError(500, 'sse_token_secret_not_configured'))

	const url = new URL(req.url)
	const segments = url.pathname.split('/').filter(Boolean)
	const room_id = segments[segments.length - 1] as RoomId | undefined
	if (!room_id) return withCorsHeaders(req, jsonError(404, 'missing_room'))

	const token = url.searchParams.get('token')
	if (!token) return withCorsHeaders(req, jsonError(401, 'missing_sse_token'))

	const runtime = getRuntime() as unknown as {
		roomEventBus?: import('../../dist/sync/roomEventBus.js').RoomEventBus
		sseNonces?: import('../../dist/auth/sseToken.js').NonceCache
	}
	const bus = runtime.roomEventBus
	if (!bus) return withCorsHeaders(req, jsonError(503, 'realtime_bus_not_initialized'))
	const nonceCache = runtime.sseNonces
	if (!nonceCache) return withCorsHeaders(req, jsonError(500, 'sse_nonce_cache_not_initialized'))

	try {
		verifySseToken({ token, room_id, secret: sseSecret, nonceCache })
	} catch (err) {
		const reason = err instanceof SseTokenError ? err.reason : 'sse_token_invalid'
		return withCorsHeaders(req, jsonError(401, reason))
	}

	const { response } = openSseEndpoint({
		room_id,
		bus,
		abortSignal: req.signal,
	})
	return withCorsHeaders(req, response)
}

function jsonError(status: number, code: string): Response {
	return new Response(JSON.stringify({ error: code }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
