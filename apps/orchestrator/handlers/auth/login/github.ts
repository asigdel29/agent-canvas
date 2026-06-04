/**
 * GET /api/auth/login/github — start the GitHub sign-in flow.
 *
 * Distinct from /api/oauth/github/start which onboards GitHub as a
 * connector (storing the user's tokens to call the GitHub API on
 * their behalf). The login flow uses GitHub purely as an identity
 * provider: we exchange the code, read the GitHub user's login, and
 * mint our own session JWT scoped to that identity. No GitHub
 * tokens are persisted by this path.
 *
 * Flow:
 *
 *   1. The browser hits /api/auth/login/github?redirect_to=<canvas-url>
 *   2. We mint a short-lived (5min) state JWT carrying the redirect_to
 *      and a random nonce. This stops a third party from forging the
 *      callback. State JWT lives in the query string (not a cookie)
 *      so the flow works across origins without cookie-domain games.
 *   3. We 302 to GitHub's authorize URL with our state in `state=`.
 *   4. GitHub redirects back to /api/auth/github/callback?code=&state=
 *
 * Required env vars:
 *
 *   GITHUB_OAUTH_CLIENT_ID       GitHub OAuth app client id
 *   AUTH_STATE_SECRET            HMAC secret for the state JWT
 *                                (separate from JWT_SECRET so a leak
 *                                of one never compromises the other)
 *   CANVAS_ORIGIN                Origin the canvas is served from;
 *                                used to validate redirect_to against
 *                                open-redirect abuse
 *
 * Optional:
 *
 *   PUBLIC_ORCHESTRATOR_ORIGIN   Origin GitHub redirects back to.
 *                                Defaults to the request's own origin,
 *                                which works locally but not behind a
 *                                proxy where the public URL differs.
 * @author asigdel29
 */

import { signSession } from '../../../dist/auth/jwt.js'
import { preflightResponse, withCorsHeaders } from '../../../dist/http/cors.js'

const STATE_TTL_SECONDS = 5 * 60
const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const GITHUB_SCOPES = 'read:user user:email'

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight
	if (req.method !== 'GET') {
		return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))
	}

	const clientId = process.env['GITHUB_OAUTH_CLIENT_ID']
	const stateSecret = process.env['AUTH_STATE_SECRET']
	const canvasOrigin = process.env['CANVAS_ORIGIN']
	if (!clientId) return withCorsHeaders(req, jsonError(500, 'github_oauth_client_id_not_configured'))
	if (!stateSecret) return withCorsHeaders(req, jsonError(500, 'auth_state_secret_not_configured'))
	if (!canvasOrigin) return withCorsHeaders(req, jsonError(500, 'canvas_origin_not_configured'))

	const url = new URL(req.url)
	const requestedRedirect = url.searchParams.get('redirect_to') ?? canvasOrigin
	const redirectTo = validateRedirect(requestedRedirect, canvasOrigin)
	if (!redirectTo) {
		return withCorsHeaders(req, jsonError(400, 'invalid_redirect_to'))
	}

	const orchestratorOrigin =
		process.env['PUBLIC_ORCHESTRATOR_ORIGIN'] ?? `${url.protocol}//${url.host}`
	const callbackUrl = `${orchestratorOrigin}/api/auth/github/callback`

	const now = Math.floor(Date.now() / 1000)
	const state = signSession(
		{
			// The state JWT reuses the session signer for convenience;
			// the sub field is repurposed as a CSRF nonce + a packed
			// redirect_to (encoded so an attacker who forges a state
			// JWT cannot also redirect us anywhere).
			sub: encodeStatePayload(redirectTo, randomNonce()) as never,
			exp: now + STATE_TTL_SECONDS,
			iat: now,
		},
		stateSecret
	)

	const authorize = new URL(GITHUB_AUTHORIZE_URL)
	authorize.searchParams.set('client_id', clientId)
	authorize.searchParams.set('redirect_uri', callbackUrl)
	authorize.searchParams.set('scope', GITHUB_SCOPES)
	authorize.searchParams.set('state', state)
	authorize.searchParams.set('allow_signup', 'true')

	return Response.redirect(authorize.toString(), 302)
}

/**
 * Pack redirect_to into the state sub field so the callback can
 * recover it without trusting the URL query string.
 *
 * Format: <base64url(redirect_to)>:<nonce>
 */
function encodeStatePayload(redirectTo: string, nonce: string): string {
	const encoded = Buffer.from(redirectTo, 'utf8').toString('base64url')
	return `${encoded}:${nonce}`
}

function randomNonce(): string {
	// 96-bit nonce, hex. Sufficient against birthday collision in any
	// realistic OAuth-callback flood; matches the SSE-token nonce size.
	const buf = new Uint8Array(12)
	crypto.getRandomValues(buf)
	return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Open-redirect protection: redirect_to must be on the configured
 * canvas origin (same protocol + host). A wildcard or a foreign
 * origin returns null.
 */
function validateRedirect(redirectTo: string, canvasOrigin: string): string | null {
	let target: URL
	try {
		target = new URL(redirectTo)
	} catch {
		return null
	}
	let allowed: URL
	try {
		allowed = new URL(canvasOrigin)
	} catch {
		return null
	}
	if (target.protocol !== allowed.protocol) return null
	if (target.host !== allowed.host) return null
	return target.toString()
}

function jsonError(status: number, code: string): Response {
	return new Response(JSON.stringify({ error: code }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
