/**
 * GET    /api/workspaces/:id/share-links            list active links (admin+)
 * POST   /api/workspaces/:id/share-links            mint a link (admin+)
 * DELETE /api/workspaces/:id/share-links/:linkId    revoke a link (admin+)
 *
 * Session-only (not API-token-callable): minting a public link is a
 * membership-management action, so a leaked machine token must not be
 * able to widen a workspace's access surface.
 *
 * POST body { role: 'viewer' | 'member', ttl_seconds?: number }.
 * The response carries the raw token exactly once — only its hash is
 * stored — so the client must surface it immediately. Listing a link
 * afterward returns metadata only; the token is unrecoverable.
 *
 * Redemption lives in handlers/share/redeem.ts; this module only
 * manages the link lifecycle.
 * @author asigdel29
 */

import { getRuntime } from '../../dist/index.js'
import { extractSession } from '../../dist/auth/session.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'
import { withRateLimit } from '../../dist/rateLimit/withRateLimit.js'
import { auditAndDispatch } from '../../dist/audit/auditAndDispatch.js'
import type { UserId } from '@agent-canvas/orchestrator-types'
import type { ShareRole, WorkspaceId } from '../../dist/tenancy/tenancyTypes.js'

const VALID_SHARE_ROLES = ['viewer', 'member'] as const

function parsePath(pathname: string): { workspace_id: string; link_id?: string } | null {
	// /api/workspaces/<wid>/share-links            list/create
	// /api/workspaces/<wid>/share-links/<linkId>   revoke
	const m = pathname.match(/^\/api\/workspaces\/([^/]+)\/share-links(?:\/([^/]+))?\/?$/)
	if (!m) return null
	const result: { workspace_id: string; link_id?: string } = { workspace_id: m[1]! }
	if (m[2] !== undefined) result.link_id = m[2]
	return result
}

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
		webhookEndpointStore?: import('../../dist/webhooks/webhookEndpointStore.js').WebhookEndpointStore
		webhookDeliveryStore?: import('../../dist/webhooks/webhookDeliveryStore.js').WebhookDeliveryStore
	}
	const tenancy = runtime.tenancyStore
	const rateLimit = runtime.rateLimitStore
	const audit = runtime.workspaceAuditStore
	const endpointStore = runtime.webhookEndpointStore
	const deliveryStore = runtime.webhookDeliveryStore
	if (!tenancy || !rateLimit || !audit || !endpointStore || !deliveryStore) {
		return withCorsHeaders(req, jsonError(500, 'runtime_not_fully_initialized'))
	}

	const url = new URL(req.url)
	const parsed = parsePath(url.pathname)
	if (!parsed) return withCorsHeaders(req, jsonError(404, 'unknown_route'))
	const workspace_id = parsed.workspace_id as WorkspaceId
	const actor = session.sub as UserId

	// Managing share links is an admin+ action on the workspace.
	try {
		await tenancy.requireMembership(actor, workspace_id, 'admin')
	} catch (err) {
		if (err instanceof Error && err.name === 'TenancyForbiddenError') {
			return withCorsHeaders(req, jsonError(403, 'workspace_forbidden'))
		}
		throw err
	}

	if (req.method === 'GET' && !parsed.link_id) {
		const items = await tenancy.listShareLinks(workspace_id)
		return withCorsHeaders(req, json(200, { items }))
	}

	if (req.method === 'POST' && !parsed.link_id) {
		return withRateLimit(
			{ store: rateLimit, key: `create-share-link:${actor}`, limit: 10, windowSec: 60 },
			async () => {
				let body: { role?: string; ttl_seconds?: number }
				try {
					body = (await req.json()) as typeof body
				} catch {
					return withCorsHeaders(req, jsonError(400, 'malformed_json'))
				}
				const role = body.role as ShareRole | undefined
				if (!role || !(VALID_SHARE_ROLES as readonly string[]).includes(role)) {
					return withCorsHeaders(req, jsonError(400, 'invalid_role', 'viewer or member'))
				}
				const ttl = typeof body.ttl_seconds === 'number' && body.ttl_seconds > 0
					? Math.min(body.ttl_seconds, 31_536_000) // cap at one year
					: null
				const { record, token } = await tenancy.createShareLink(workspace_id, actor, role, ttl)
				void auditAndDispatch(
					{ audit, endpointStore, deliveryStore },
					{
						workspace_id,
						actor_user_id: actor,
						action: 'share_link.created',
						target_type: 'share_link',
						target_id: record.id,
						details: { role: record.role },
					}
				)
				return withCorsHeaders(req, json(201, { link: record, token }))
			}
		)
	}

	if (req.method === 'DELETE' && parsed.link_id) {
		const ok = await tenancy.revokeShareLink(workspace_id, parsed.link_id)
		if (!ok) return withCorsHeaders(req, jsonError(404, 'share_link_not_found'))
		void auditAndDispatch(
			{ audit, endpointStore, deliveryStore },
			{
				workspace_id,
				actor_user_id: actor,
				action: 'share_link.revoked',
				target_type: 'share_link',
				target_id: parsed.link_id,
				details: {},
			}
		)
		return withCorsHeaders(req, new Response(null, { status: 204 }))
	}

	return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))
}

function json(status: number, payload: unknown): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
