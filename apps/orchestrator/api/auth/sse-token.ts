/**
 * POST /api/auth/sse-token — mint an ephemeral SSE token.
 *
 * Body: { room_id: string }   (or ?room_id=... in the URL)
 * Auth: Authorization: Bearer <session-jwt>  (the normal session)
 * Returns: { token, expires_at }
 *
 * The returned token is single-use and 60-second. The client passes it
 * to /api/sync/:room via `?token=`. URL-borne credentials leak through
 * logs; the short TTL plus single-use property collapses the exposure
 * window to seconds.
 */

import { extractSession } from '../../dist/auth/session.js'
import { mintSseToken } from '../../dist/auth/sseToken.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'

export const config = {
	runtime: 'nodejs',
}

const TTL_SECONDS = 60

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
		const url = new URL(req.url)
		room_id = url.searchParams.get('room_id') ?? undefined
	}
	if (!room_id) return withCorsHeaders(req, jsonError(400, 'missing_room_id'))

	const token = mintSseToken({
		sub: session.sub,
		room_id,
		secret: sseSecret,
		ttlSeconds: TTL_SECONDS,
	})
	const expires_at = new Date(Date.now() + TTL_SECONDS * 1000).toISOString()

	return withCorsHeaders(
		req,
		new Response(JSON.stringify({ token, expires_at }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	)
}

function jsonError(status: number, code: string): Response {
	return new Response(JSON.stringify({ error: code }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
