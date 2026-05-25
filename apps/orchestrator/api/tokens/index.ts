/**
 * GET  /api/tokens       list the session user's unrevoked tokens
 * POST /api/tokens       issue a new one; body { name, scope, expires_at? }
 *
 * Session-only. We deliberately reject API tokens from
 * authenticating this endpoint — a token cannot be used to mint
 * another token, mirroring how GitHub PATs cannot create PATs.
 */

import { getRuntime } from '../../dist/index.js'
import { extractSession } from '../../dist/auth/session.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'
import type { ApiTokenScope } from '../../dist/tokens/apiTokenStore.js'
import type { UserId } from '@agent-canvas/orchestrator-types'
import type { WorkspaceId } from '../../dist/tenancy/tenancyTypes.js'

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight

	const secret = process.env['JWT_SECRET']
	if (!secret) return withCorsHeaders(req, jsonError(500, 'jwt_secret_not_configured'))
	const session = extractSession(req, secret)
	if (!session) return withCorsHeaders(req, jsonError(401, 'unauthorized'))

	const runtime = getRuntime() as unknown as {
		apiTokenStore?: import('../../dist/tokens/apiTokenStore.js').ApiTokenStore
		tenancyStore?: import('../../dist/tenancy/tenancyStore.js').TenancyStore
	}
	const store = runtime.apiTokenStore
	const tenancy = runtime.tenancyStore
	if (!store || !tenancy) {
		return withCorsHeaders(req, jsonError(500, 'runtime_not_fully_initialized'))
	}

	const user_id = session.sub as UserId

	if (req.method === 'GET') {
		const items = await store.listForUser(user_id)
		return withCorsHeaders(
			req,
			new Response(JSON.stringify({ items }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		)
	}

	if (req.method === 'POST') {
		let body: { name?: string; scope?: ApiTokenScope; expires_at?: string | null; workspace_id?: string }
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
		const scope = body.scope
		if (scope !== 'read' && scope !== 'write') {
			return withCorsHeaders(req, jsonError(400, 'invalid_scope', 'must be read or write'))
		}
		const workspace_id = (body.workspace_id ??
			(session.workspace_id as WorkspaceId | undefined)) as WorkspaceId | undefined
		if (!workspace_id) {
			return withCorsHeaders(
				req,
				jsonError(400, 'missing_workspace_id', 'body must include workspace_id or session must carry it')
			)
		}
		// Tokens can only be issued by a member of the workspace at
		// the role matching the requested scope. read → viewer+,
		// write → member+. This blocks a viewer from minting a
		// write-scope token to escalate.
		try {
			const minRole = scope === 'write' ? 'member' : 'viewer'
			await tenancy.requireMembership(user_id, workspace_id, minRole)
		} catch (err) {
			const name = err instanceof Error ? err.name : ''
			if (name === 'TenancyForbiddenError') {
				return withCorsHeaders(req, jsonError(403, 'workspace_forbidden'))
			}
			throw err
		}

		const issued = await store.issue({
			user_id,
			workspace_id,
			name,
			scope,
			...(body.expires_at !== undefined ? { expires_at: body.expires_at } : {}),
		})
		// Return the raw token EXACTLY ONCE. Future GETs only show
		// the hash-derived prefix.
		return withCorsHeaders(
			req,
			new Response(JSON.stringify({ record: issued.record, raw_token: issued.raw_token }), {
				status: 201,
				headers: { 'content-type': 'application/json' },
			})
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
