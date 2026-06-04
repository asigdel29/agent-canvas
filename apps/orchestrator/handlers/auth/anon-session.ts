/**
 * POST /api/auth/anon-session — mint a session without an external login.
 *
 * Enabled only when AUTH_MODE=open (a trusted internal deployment). The
 * caller supplies a display handle; the orchestrator upserts a stable
 * user keyed on that handle, ensures the user's solo workspace exists,
 * and returns a signed session JWT plus the workspace/room to join. The
 * same handle always maps to the same user, so a returning teammate
 * keeps their workspace and agents.
 *
 * Body:    { "handle": "alice" }
 * Returns: { session, room, workspace_id, handle }
 *
 * Collaboration: open mode disables per-workspace isolation (see
 * openModeMembership in tenancyStore), so teammates who open the same
 * room URL can see and act on each other's agents.
 *
 * @author asigdel29
 */

import type { UserId } from '@agent-canvas/orchestrator-types'

import { getRuntime } from '../../dist/index.js'
import { signSession } from '../../dist/auth/jwt.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'

/** Session lifetime, mirroring the GitHub login flow: seven days. */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

/** Maximum accepted handle length before truncation. */
const MAX_HANDLE_LEN = 40

/**
 * Reduce a free-text handle to a stable, id-safe slug.
 *
 * Lowercases, replaces any run of non-alphanumeric characters with a
 * single underscore, and trims leading/trailing underscores. Falls back
 * to 'guest' when nothing usable remains, so the user id is always
 * well-formed.
 *
 * @param raw the caller-supplied handle (may be empty or undefined).
 * @returns a slug matching /^[a-z0-9_]+$/.
 */
function slugify(raw: string | undefined): string {
	const slug = (raw ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, MAX_HANDLE_LEN)
	return slug.length > 0 ? slug : 'guest'
}

function jsonError(status: number, error: string): Response {
	return new Response(JSON.stringify({ error }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

/**
 * Mint an anonymous session for an open-mode deployment.
 *
 * @param req the incoming request; the JSON body may carry `{ handle }`.
 * @returns 200 with the session payload, 403 when open mode is off, or
 *   400/500 on a malformed body or uninitialized runtime.
 */
export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight

	if (req.method !== 'POST') return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))
	if (process.env['AUTH_MODE'] !== 'open') {
		return withCorsHeaders(req, jsonError(403, 'open_mode_disabled'))
	}

	const sessionSecret = process.env['JWT_SECRET']
	if (!sessionSecret) return withCorsHeaders(req, jsonError(500, 'jwt_secret_not_configured'))

	let body: { handle?: string }
	try {
		body = (await req.json()) as { handle?: string }
	} catch {
		body = {}
	}
	const handle = slugify(body.handle)

	const runtime = getRuntime() as unknown as {
		tenancyStore?: import('../../dist/tenancy/tenancyStore.js').TenancyStore
	}
	const tenancy = runtime.tenancyStore
	if (!tenancy) return withCorsHeaders(req, jsonError(500, 'tenancy_store_not_initialized'))

	const user = await tenancy.upsertGithubUser({
		github_id: `anon_${handle}`,
		github_login: handle,
		email: null,
		name: handle,
	})
	const workspace = await tenancy.ensureSoloWorkspace(user.id, `${handle}'s workspace`)

	const now = Math.floor(Date.now() / 1000)
	const session = signSession(
		{
			sub: user.id as UserId,
			workspace_id: workspace.id,
			exp: now + SESSION_TTL_SECONDS,
			iat: now,
		} as never,
		sessionSecret
	)

	return withCorsHeaders(
		req,
		new Response(
			JSON.stringify({
				session,
				room: workspace.id,
				workspace_id: workspace.id,
				handle,
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } }
		)
	)
}
