/**
 * DELETE /api/webhooks/:id     soft revoke an endpoint the caller owns
 *
 * Returns 204. Same oracle defense as DELETE /api/tokens/:id — a
 * request that targets an endpoint id that does not exist, or that
 * belongs to a different user, returns 204. The store filters on
 * id AND user_id, so the SQL update affects zero rows; the caller
 * cannot distinguish.
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
		webhookEndpointStore?: import('../../dist/webhooks/webhookEndpointStore.js').WebhookEndpointStore
		workspaceAuditStore?: import('../../dist/audit/workspaceAuditStore.js').WorkspaceAuditStore
	}
	const store = runtime.webhookEndpointStore
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
		const urlHost = (() => {
			try {
				return new URL(revoked.url).host
			} catch {
				return 'unknown'
			}
		})()
		void audit
			.append({
				workspace_id: revoked.workspace_id,
				actor_user_id: session.sub as UserId,
				action: 'webhook.revoked',
				target_type: 'webhook_endpoint',
				target_id: revoked.id,
				details: { url_host: urlHost },
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
