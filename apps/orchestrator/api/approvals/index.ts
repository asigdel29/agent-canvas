/**
 * GET /api/approvals?run_id=...   list pending; if run_id is
 *                                  omitted, every pending row.
 *
 * Used by the canvas ApprovalInbox on first paint. Live updates
 * after that arrive through the existing SSE room bus
 * (approval_required events).
 */

import { getRuntime } from '../../dist/index.js'
import { extractSession } from '../../dist/auth/session.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight
	if (req.method !== 'GET') return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))

	const secret = process.env['JWT_SECRET']
	if (!secret) return withCorsHeaders(req, jsonError(500, 'jwt_secret_not_configured'))
	if (!extractSession(req, secret)) return withCorsHeaders(req, jsonError(401, 'unauthorized'))

	const runtime = getRuntime() as unknown as {
		approvalStore?: import('../../dist/agents/approvalStore.js').ApprovalStore
	}
	const store = runtime.approvalStore
	if (!store) return withCorsHeaders(req, jsonError(500, 'approval_store_not_initialized'))

	const url = new URL(req.url)
	const runId = url.searchParams.get('run_id')
	const items = runId
		? await store.listPendingForRun(runId)
		: await store.listPending()
	return withCorsHeaders(
		req,
		new Response(JSON.stringify({ items }), {
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
