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
import { withRateLimit } from '../../dist/rateLimit/withRateLimit.js'
import { dispatchWebhook } from '../../dist/webhooks/dispatchWebhook.js'
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
		rateLimitStore?: import('../../dist/rateLimit/rateLimitStore.js').RateLimitStore
		workspaceAuditStore?: import('../../dist/audit/workspaceAuditStore.js').WorkspaceAuditStore
		webhookEndpointStore?: import('../../dist/webhooks/webhookEndpointStore.js').WebhookEndpointStore
		webhookDeliveryStore?: import('../../dist/webhooks/webhookDeliveryStore.js').WebhookDeliveryStore
	}
	const store = runtime.apiTokenStore
	const tenancy = runtime.tenancyStore
	const rateLimit = runtime.rateLimitStore
	const audit = runtime.workspaceAuditStore
	const webhookEndpointStore = runtime.webhookEndpointStore
	const webhookDeliveryStore = runtime.webhookDeliveryStore
	if (
		!store ||
		!tenancy ||
		!rateLimit ||
		!audit ||
		!webhookEndpointStore ||
		!webhookDeliveryStore
	) {
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

	// Arrow form (not declaration) so the narrowing of store / tenancy
	// / rateLimit survives into the closure.
	const mintToken = async (): Promise<Response> => {
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
			const errName = err instanceof Error ? err.name : ''
			if (errName === 'TenancyForbiddenError') {
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
		// Append to the workspace audit trail. Best-effort: an audit
		// write failure must not block the user's mint. Errors are
		// swallowed; logging happens at the store level.
		// We need the audit row id for the webhook event_id; await
		// the append and use the returned record. If the audit write
		// throws, fall back to a synthetic id so dispatch still fires.
		let auditEventId: string
		try {
			const auditRow = await audit.append({
				workspace_id,
				actor_user_id: user_id,
				action: 'token.minted',
				target_type: 'api_token',
				target_id: issued.record.id,
				details: {
					name: issued.record.name,
					scope: issued.record.scope,
					token_prefix: issued.record.token_prefix,
				},
			})
			auditEventId = auditRow.id
		} catch {
			auditEventId = `evt_local_${Date.now()}`
		}
		// Fire-and-forget webhook dispatch. Enqueue rows for every
		// subscriber to 'token.minted' or '*'; the drain worker
		// delivers them later. We deliberately do NOT await here —
		// the response should not wait on the queue write.
		void dispatchWebhook(
			{ endpointStore: webhookEndpointStore, deliveryStore: webhookDeliveryStore },
			{
				workspace_id,
				event_type: 'token.minted',
				event_id: auditEventId,
				payload: {
					token_id: issued.record.id,
					token_prefix: issued.record.token_prefix,
					scope: issued.record.scope,
					name: issued.record.name,
				},
			}
		).catch(() => undefined)
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

	if (req.method === 'POST') {
		// Rate limit token minting tightly. Five mints per minute is
		// generous for human flows (operator rotates a leaked key,
		// CI cuts a new build token) and tight enough to stop a
		// runaway script. The bucket key is the session user_id so a
		// single account cannot exceed the ceiling even with multiple
		// browsers open.
		return withRateLimit(
			{
				store: rateLimit,
				key: `mint-token:${user_id}`,
				limit: 5,
				windowSec: 60,
				blockedBody: () => ({
					error: 'rate_limited',
					detail: 'too many tokens minted in the last minute',
				}),
			},
			mintToken
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
