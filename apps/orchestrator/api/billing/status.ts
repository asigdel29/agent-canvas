/**
 * GET /api/billing/status
 *
 * Returns the session workspace's billing status — what the canvas
 * needs to show the right CTA ('Subscribe', 'Manage billing',
 * 'Trial ends in N days'). Read-only, viewer+ tenancy.
 *
 * Shape:
 *   {
 *     live: boolean,
 *     status: 'none' | 'active' | 'trialing' | 'past_due' | ...
 *     plan_lookup_key: string | null,
 *     current_period_end: ISO string | null,
 *     cancel_at_period_end: boolean,
 *     gate_enabled: boolean   // mirrors BILLING_GATE_ENABLED
 *   }
 *
 * gate_enabled tells the canvas whether the orchestrator will
 * actually refuse run-starts for non-paying workspaces; it lets
 * the UI degrade gracefully when billing is configured-off.
 */

import { getRuntime } from '../../dist/index.js'
import { extractSession } from '../../dist/auth/session.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'
import type { UserId } from '@agent-canvas/orchestrator-types'
import type { WorkspaceId } from '../../dist/tenancy/tenancyTypes.js'

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight
	if (req.method !== 'GET') {
		return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))
	}

	const jwtSecret = process.env['JWT_SECRET']
	if (!jwtSecret) return withCorsHeaders(req, jsonError(500, 'jwt_secret_not_configured'))
	const session = extractSession(req, jwtSecret)
	if (!session) return withCorsHeaders(req, jsonError(401, 'unauthorized'))

	const runtime = getRuntime() as unknown as {
		billingStore?: import('../../dist/billing/billingStore.js').BillingStore
		tenancyStore?: import('../../dist/tenancy/tenancyStore.js').TenancyStore
	}
	const billing = runtime.billingStore
	const tenancy = runtime.tenancyStore
	if (!billing || !tenancy) {
		return withCorsHeaders(req, jsonError(500, 'runtime_not_fully_initialized'))
	}

	const user_id = session.sub as UserId
	const workspace_id = session.workspace_id as WorkspaceId | undefined
	if (!workspace_id) {
		return withCorsHeaders(req, jsonError(400, 'missing_workspace_in_session'))
	}
	try {
		await tenancy.requireMembership(user_id, workspace_id, 'viewer')
	} catch (err) {
		if (err instanceof Error && err.name === 'TenancyForbiddenError') {
			return withCorsHeaders(req, jsonError(403, 'workspace_forbidden'))
		}
		throw err
	}

	const status = await billing.getStatus(workspace_id)
	const gateEnabled = process.env['BILLING_GATE_ENABLED'] === 'true'
	return withCorsHeaders(
		req,
		new Response(JSON.stringify({ ...status, gate_enabled: gateEnabled }), {
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
