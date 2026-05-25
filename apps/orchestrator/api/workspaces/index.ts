/**
 * GET  /api/workspaces       list workspaces the session user belongs to
 * POST /api/workspaces       create a new workspace; caller becomes owner
 *
 * Session-only (not API-token-callable). The OAuth callback already
 * provisions a workspace; this lets a user create additional ones
 * (separate billing, separate access, etc.) and lets the canvas
 * render a workspace switcher dropdown.
 */

import { getRuntime } from '../../dist/index.js'
import { extractSession } from '../../dist/auth/session.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'
import { withRateLimit } from '../../dist/rateLimit/withRateLimit.js'
import type { UserId } from '@agent-canvas/orchestrator-types'

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight

	const secret = process.env['JWT_SECRET']
	if (!secret) return withCorsHeaders(req, jsonError(500, 'jwt_secret_not_configured'))
	const session = extractSession(req, secret)
	if (!session) return withCorsHeaders(req, jsonError(401, 'unauthorized'))

	const runtime = getRuntime() as unknown as {
		tenancyStore?: import('../../dist/tenancy/tenancyStore.js').TenancyStore
		rateLimitStore?: import('../../dist/rateLimit/rateLimitStore.js').RateLimitStore
		workspaceAuditStore?: import('../../dist/audit/workspaceAuditStore.js').WorkspaceAuditStore
	}
	const tenancy = runtime.tenancyStore
	const rateLimit = runtime.rateLimitStore
	const audit = runtime.workspaceAuditStore
	if (!tenancy || !rateLimit || !audit) {
		return withCorsHeaders(req, jsonError(500, 'runtime_not_fully_initialized'))
	}

	const user_id = session.sub as UserId

	if (req.method === 'GET') {
		const items = await tenancy.listWorkspacesForUser(user_id)
		return withCorsHeaders(
			req,
			new Response(JSON.stringify({ items }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		)
	}

	const createWorkspaceImpl = async (): Promise<Response> => {
		let body: { name?: string }
		try {
			body = (await req.json()) as typeof body
		} catch {
			return withCorsHeaders(req, jsonError(400, 'malformed_json'))
		}
		const name = (body.name ?? '').trim()
		if (!name) return withCorsHeaders(req, jsonError(400, 'missing_name'))
		if (name.length > 80) {
			return withCorsHeaders(req, jsonError(400, 'name_too_long', 'max 80 chars'))
		}
		const ws = await tenancy.createWorkspace(name, user_id)
		void audit
			.append({
				workspace_id: ws.id,
				actor_user_id: user_id,
				action: 'workspace.created',
				target_type: 'workspace',
				target_id: ws.id,
				details: { name: ws.name },
			})
			.catch(() => undefined)
		return withCorsHeaders(
			req,
			new Response(JSON.stringify({ workspace: ws }), {
				status: 201,
				headers: { 'content-type': 'application/json' },
			})
		)
	}

	if (req.method === 'POST') {
		// 3/min/user. Creating workspaces is rare; a script doing it
		// faster is almost certainly buggy.
		return withRateLimit(
			{
				store: rateLimit,
				key: `create-workspace:${user_id}`,
				limit: 3,
				windowSec: 60,
			},
			createWorkspaceImpl
		)
	}

	return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))
}

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
