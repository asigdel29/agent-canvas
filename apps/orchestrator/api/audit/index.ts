/**
 * GET /api/audit                  workspace-admin audit query
 *
 * Required query params:
 *   workspace_id  (defaults to session.workspace_id when absent)
 *
 * Optional query params:
 *   since         ISO 8601 timestamp; created_at >= since
 *   until         ISO 8601 timestamp; created_at <= until
 *   actor         filter by actor_user_id
 *   action        filter to a specific action enum value
 *   limit         1..500, default 100
 *
 * Tenancy: admin+ required. Regular members and viewers see 403.
 * Why admin: an audit log can carry sensitive operator detail
 * (which token was minted, which webhook host registered) that
 * a contributor doesn't need access to. The threshold can drop
 * to member+ if a workspace ever asks for it; the gate is one
 * line.
 */

import { getRuntime } from '../../dist/index.js'
import { extractSession } from '../../dist/auth/session.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'
import { isWorkspaceAuditAction } from '../../dist/audit/auditActions.js'
import type { UserId } from '@agent-canvas/orchestrator-types'
import type { WorkspaceId } from '../../dist/tenancy/tenancyTypes.js'

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight
	if (req.method !== 'GET') {
		return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))
	}

	const secret = process.env['JWT_SECRET']
	if (!secret) return withCorsHeaders(req, jsonError(500, 'jwt_secret_not_configured'))
	const session = extractSession(req, secret)
	if (!session) return withCorsHeaders(req, jsonError(401, 'unauthorized'))

	const runtime = getRuntime() as unknown as {
		workspaceAuditStore?: import('../../dist/audit/workspaceAuditStore.js').WorkspaceAuditStore
		tenancyStore?: import('../../dist/tenancy/tenancyStore.js').TenancyStore
	}
	const store = runtime.workspaceAuditStore
	const tenancy = runtime.tenancyStore
	if (!store || !tenancy) {
		return withCorsHeaders(req, jsonError(500, 'runtime_not_fully_initialized'))
	}

	const url = new URL(req.url)
	const workspace_id =
		(url.searchParams.get('workspace_id') ??
			(session.workspace_id as string | undefined)) as WorkspaceId | undefined
	if (!workspace_id) {
		return withCorsHeaders(req, jsonError(400, 'missing_workspace_id'))
	}

	try {
		await tenancy.requireMembership(session.sub as UserId, workspace_id, 'admin')
	} catch (err) {
		if (err instanceof Error && err.name === 'TenancyForbiddenError') {
			return withCorsHeaders(req, jsonError(403, 'workspace_forbidden'))
		}
		throw err
	}

	const since = url.searchParams.get('since')
	const until = url.searchParams.get('until')
	const actorParam = url.searchParams.get('actor')
	const actionParam = url.searchParams.get('action')
	const limitParam = url.searchParams.get('limit')

	// Validate the action filter against the closed enum so a typo
	// returns 400 rather than silently producing zero results.
	if (actionParam !== null && !isWorkspaceAuditAction(actionParam)) {
		return withCorsHeaders(
			req,
			jsonError(400, 'invalid_action', 'unknown audit action name')
		)
	}
	// Light validation of ISO timestamps. Date.parse returns NaN on
	// malformed input; reject early so a downstream filter doesn't
	// silently include everything.
	for (const [name, val] of [
		['since', since],
		['until', until],
	] as const) {
		if (val !== null && Number.isNaN(Date.parse(val))) {
			return withCorsHeaders(req, jsonError(400, `invalid_${name}`, 'expected ISO 8601'))
		}
	}

	const items = await store.query({
		workspace_id,
		...(since !== null ? { since } : {}),
		...(until !== null ? { until } : {}),
		...(actorParam !== null ? { actor_user_id: actorParam as UserId } : {}),
		...(actionParam !== null && isWorkspaceAuditAction(actionParam)
			? { action: actionParam }
			: {}),
		...(limitParam !== null ? { limit: Number(limitParam) } : {}),
	})

	return withCorsHeaders(
		req,
		new Response(JSON.stringify({ items }), {
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
