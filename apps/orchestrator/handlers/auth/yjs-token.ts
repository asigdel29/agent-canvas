/**
 * POST /api/auth/yjs-token — mint a room-scoped token for the
 * collaborative-canvas WebSocket.
 *
 * Body: { room_id: string }
 * Auth: Authorization: Bearer <session-jwt>
 * Returns: { token, expires_at }
 *
 * Same HMAC scheme and room scoping as the SSE token, but with a longer
 * TTL: a WebSocket is long-lived and the y-websocket provider reuses its
 * connect URL across reconnects, so a 60-second single-use token would
 * break the first reconnect. The token is still room-scoped, signed, and
 * time-bounded — and the WS verifier does not burn a nonce — so it is
 * safe to carry in the connect URL for the session window.
 * @author asigdel29
 */

import { extractSession } from '../../dist/auth/session.js'
import { mintSseToken } from '../../dist/auth/sseToken.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'

/** Eight hours: long enough to span a working session and its reconnects. */
const TTL_SECONDS = 8 * 60 * 60

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight
	if (req.method !== 'POST') return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))

	const sessionSecret = process.env['JWT_SECRET']
	const sseSecret = process.env['SSE_TOKEN_SECRET']
	if (!sessionSecret) return withCorsHeaders(req, jsonError(500, 'jwt_secret_not_configured'))
	if (!sseSecret) return withCorsHeaders(req, jsonError(500, 'sse_token_secret_not_configured'))

	const session = extractSession(req, sessionSecret)
	if (!session) return withCorsHeaders(req, jsonError(401, 'unauthorized'))

	let room_id: string | undefined
	try {
		const body = (await req.json()) as { room_id?: string }
		room_id = body.room_id
	} catch {
		return withCorsHeaders(req, jsonError(400, 'malformed_json'))
	}
	if (!room_id || typeof room_id !== 'string') {
		return withCorsHeaders(req, jsonError(400, 'missing_room_id'))
	}

	const token = mintSseToken({ sub: session.sub, room_id, secret: sseSecret, ttlSeconds: TTL_SECONDS })
	const expires_at = new Date(Date.now() + TTL_SECONDS * 1000).toISOString()

	return withCorsHeaders(
		req,
		new Response(JSON.stringify({ token, expires_at }), {
			status: 200,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
		})
	)
}

function jsonError(status: number, code: string): Response {
	return new Response(JSON.stringify({ error: code }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
