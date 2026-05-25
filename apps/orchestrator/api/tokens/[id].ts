/**
 * DELETE /api/tokens/:id   revoke a token the session user owns
 *
 * Soft revoke (sets revoked_at). The token's last_used_at and
 * created_at remain so the audit trail stays intact. The token
 * itself can never authenticate again — verify() filters on
 * revoked_at IS NULL.
 *
 * Returns 204 on success. We do NOT surface a 404 vs 403
 * distinction: a request that targets someone else's token id
 * gets the same response as one that targets a non-existent id.
 * This is deliberate — leaking existence ('your guess was an
 * existing token, but not yours') is an oracle attack.
 */

import { getRuntime } from '../../dist/index.js'
import { extractSession } from '../../dist/auth/session.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'
import type { UserId } from '@agent-canvas/orchestrator-types'

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight
	if (req.method !== 'DELETE') {
		return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))
	}

	const secret = process.env['JWT_SECRET']
	if (!secret) return withCorsHeaders(req, jsonError(500, 'jwt_secret_not_configured'))
	const session = extractSession(req, secret)
	if (!session) return withCorsHeaders(req, jsonError(401, 'unauthorized'))

	const runtime = getRuntime() as unknown as {
		apiTokenStore?: import('../../dist/tokens/apiTokenStore.js').ApiTokenStore
		workspaceAuditStore?: import('../../dist/audit/workspaceAuditStore.js').WorkspaceAuditStore
	}
	const store = runtime.apiTokenStore
	const audit = runtime.workspaceAuditStore
	if (!store || !audit) {
		return withCorsHeaders(req, jsonError(500, 'runtime_not_fully_initialized'))
	}

	const url = new URL(req.url)
	const segments = url.pathname.split('/').filter(Boolean)
	const id = segments[segments.length - 1]
	if (!id) return withCorsHeaders(req, jsonError(404, 'missing_id'))

	const revoked = await store.revoke(id, session.sub as UserId)
	if (revoked) {
		// Audit only when an actual revoke happened. Oracle defense
		// already lives at the response layer (204 either way).
		void audit
			.append({
				workspace_id: revoked.workspace_id,
				actor_user_id: session.sub as UserId,
				action: 'token.revoked',
				target_type: 'api_token',
				target_id: revoked.id,
				details: { token_prefix: revoked.token_prefix },
			})
			.catch(() => undefined)
	}
	return withCorsHeaders(req, new Response(null, { status: 204 }))
}

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
