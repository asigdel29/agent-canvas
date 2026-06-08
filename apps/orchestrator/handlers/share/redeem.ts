/**
 * POST /api/share/redeem — exchange a share token for a session.
 *
 * Unauthenticated by design: this is how a visitor with only a share
 * link gets into a workspace. The token is validated and, on success,
 * the store provisions a synthetic principal joined to the workspace
 * at the link's role; we then mint a short-lived session JWT for that
 * principal and hand back the room to join.
 *
 * Body:    { "token": "<raw share token>" }
 * Returns: { session, workspace_id, room, role }
 *
 * Security:
 *   - Tokens are 256-bit, so guessing is infeasible; we additionally
 *     rate-limit by client IP as defense in depth.
 *   - The minted session is short-lived (24h). Revoking the link
 *     removes the principal's membership, so access is cut immediately
 *     even before the JWT expires.
 *   - Failures return a single generic code; we never reveal whether a
 *     token was unknown, expired, or revoked, and never leak internals.
 * @author asigdel29
 */

import type { UserId } from '@agent-canvas/orchestrator-types'

import { getRuntime } from '../../dist/index.js'
import { signSession } from '../../dist/auth/jwt.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'
import { withRateLimit } from '../../dist/rateLimit/withRateLimit.js'

/** Share sessions are short-lived; the link itself is the durable grant. */
const SHARE_SESSION_TTL_SECONDS = 24 * 60 * 60

function jsonError(status: number, error: string): Response {
	return new Response(JSON.stringify({ error }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

/** Best-effort client IP for rate limiting; opaque and never echoed back. */
function clientIp(req: Request): string {
	const fwd = req.headers.get('x-forwarded-for')
	if (fwd) return fwd.split(',')[0]!.trim()
	return req.headers.get('x-real-ip') ?? 'unknown'
}

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight
	if (req.method !== 'POST') return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))

	const sessionSecret = process.env['JWT_SECRET']
	if (!sessionSecret) return withCorsHeaders(req, jsonError(500, 'jwt_secret_not_configured'))

	const runtime = getRuntime() as unknown as {
		tenancyStore?: import('../../dist/tenancy/tenancyStore.js').TenancyStore
		rateLimitStore?: import('../../dist/rateLimit/rateLimitStore.js').RateLimitStore
	}
	const tenancy = runtime.tenancyStore
	const rateLimit = runtime.rateLimitStore
	if (!tenancy || !rateLimit) {
		return withCorsHeaders(req, jsonError(500, 'runtime_not_fully_initialized'))
	}

	return withRateLimit(
		{ store: rateLimit, key: `share-redeem:${clientIp(req)}`, limit: 30, windowSec: 60 },
		async () => {
			let body: { token?: string }
			try {
				body = (await req.json()) as { token?: string }
			} catch {
				return withCorsHeaders(req, jsonError(400, 'malformed_json'))
			}
			const token = (body.token ?? '').trim()
			if (!token) return withCorsHeaders(req, jsonError(400, 'missing_token'))

			const redemption = await tenancy.redeemShareToken(token)
			if (!redemption) return withCorsHeaders(req, jsonError(404, 'invalid_share_link'))

			const now = Math.floor(Date.now() / 1000)
			const session = signSession(
				{
					sub: redemption.share_user_id as UserId,
					workspace_id: redemption.workspace_id,
					share_link_id: redemption.link_id,
					share_role: redemption.role,
					exp: now + SHARE_SESSION_TTL_SECONDS,
					iat: now,
				} as never,
				sessionSecret
			)

			return withCorsHeaders(
				req,
				new Response(
					JSON.stringify({
						session,
						workspace_id: redemption.workspace_id,
						room: redemption.workspace_id,
						role: redemption.role,
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				)
			)
		}
	)
}
