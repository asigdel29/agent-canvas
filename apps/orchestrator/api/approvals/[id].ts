/**
 * POST /api/approvals/:id        body: { resolution: 'approved' | 'rejected' }
 *
 * Same route handles both decisions. The session's sub is recorded
 * as `resolved_by_user_id`. The gate's same-instance Map fires
 * synchronously if the run is here; cross-instance, the polling
 * fallback in the gate picks it up within `pollIntervalMs`.
 *
 * Idempotent: a second POST on an already-resolved id returns the
 * existing decision rather than erroring. Operators may double-tap.
 */

import { getRuntime } from '../../dist/index.js'
import { extractSession } from '../../dist/auth/session.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'
import type { ApprovalId } from '../../dist/agents/agentRecord.js'

export const config = { runtime: 'nodejs' }

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight
	if (req.method !== 'POST') {
		return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))
	}

	const secret = process.env['JWT_SECRET']
	if (!secret) return withCorsHeaders(req, jsonError(500, 'jwt_secret_not_configured'))
	const session = extractSession(req, secret)
	if (!session) return withCorsHeaders(req, jsonError(401, 'unauthorized'))

	const runtime = getRuntime() as unknown as {
		approvalGate?: import('../../dist/agents/storeBackedApprovalGate.js').StoreBackedApprovalGate
		approvalStore?: import('../../dist/agents/approvalStore.js').ApprovalStore
	}
	const gate = runtime.approvalGate
	const store = runtime.approvalStore
	if (!gate || !store) return withCorsHeaders(req, jsonError(500, 'approvals_not_initialized'))

	const url = new URL(req.url)
	const segments = url.pathname.split('/').filter(Boolean)
	const id = segments[segments.length - 1] as ApprovalId | undefined
	if (!id) return withCorsHeaders(req, jsonError(404, 'missing_id'))

	let body: { resolution?: string }
	try {
		body = (await req.json()) as { resolution?: string }
	} catch {
		return withCorsHeaders(req, jsonError(400, 'malformed_json'))
	}
	if (body.resolution !== 'approved' && body.resolution !== 'rejected') {
		return withCorsHeaders(
			req,
			jsonError(400, 'invalid_resolution', 'must be approved or rejected')
		)
	}

	const row = await store.get(id)
	if (!row) return withCorsHeaders(req, jsonError(404, 'not_found'))

	await gate.resolve(id, {
		resolution: body.resolution,
		resolved_by_user_id: session.sub,
	})

	const updated = await store.get(id)
	return withCorsHeaders(
		req,
		new Response(JSON.stringify(updated), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	)
}

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
