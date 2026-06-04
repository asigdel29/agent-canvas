/**
 * GET /api/auth/config — public auth configuration.
 *
 * The canvas reads this on first load to decide how to sign a user in:
 *
 *   auth_mode = 'github'  require the GitHub OAuth login (default).
 *   auth_mode = 'open'    trusted internal deploy — let a user join with
 *                         just a display name via /api/auth/anon-session,
 *                         no external login.
 *
 * The response carries no secrets, so it is unauthenticated.
 *
 * @author asigdel29
 */

import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'

/**
 * Resolve and return the deployment's auth mode.
 *
 * @param req the incoming request (used only for CORS handling).
 * @returns 200 with `{ auth_mode }`.
 */
export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight

	const mode = process.env['AUTH_MODE'] === 'open' ? 'open' : 'github'
	return withCorsHeaders(
		req,
		new Response(JSON.stringify({ auth_mode: mode }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	)
}
