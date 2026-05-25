/**
 * GET  /api/webhooks            list endpoints in the session workspace
 * POST /api/webhooks            register a new endpoint
 *
 * Session-only. API tokens cannot register webhooks — the secret is
 * returned exactly once on create, and we don't want a leaked
 * machine token to mint webhook destinations.
 *
 * Body for POST:
 *   {
 *     url: string,           // required; must be https + non-private
 *     events?: string[],     // default ['*']
 *     description?: string,  // free-text label
 *     workspace_id?: string  // defaults to session workspace
 *   }
 *
 * Response on POST is 201 with { record, signing_secret }. The
 * signing_secret never appears in a subsequent GET — copy it now or
 * lose it and re-create the endpoint.
 */

import { getRuntime } from '../../dist/index.js'
import { extractSession } from '../../dist/auth/session.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'
import { withRateLimit } from '../../dist/rateLimit/withRateLimit.js'
import { validateWebhookUrl } from '../../dist/webhooks/validateWebhookUrl.js'
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
		webhookEndpointStore?: import('../../dist/webhooks/webhookEndpointStore.js').WebhookEndpointStore
		tenancyStore?: import('../../dist/tenancy/tenancyStore.js').TenancyStore
		rateLimitStore?: import('../../dist/rateLimit/rateLimitStore.js').RateLimitStore
		workspaceAuditStore?: import('../../dist/audit/workspaceAuditStore.js').WorkspaceAuditStore
	}
	const store = runtime.webhookEndpointStore
	const tenancy = runtime.tenancyStore
	const rateLimit = runtime.rateLimitStore
	const audit = runtime.workspaceAuditStore
	if (!store || !tenancy || !rateLimit || !audit) {
		return withCorsHeaders(req, jsonError(500, 'runtime_not_fully_initialized'))
	}

	const user_id = session.sub as UserId
	const sessionWorkspace = session.workspace_id as WorkspaceId | undefined

	if (req.method === 'GET') {
		if (!sessionWorkspace) {
			return withCorsHeaders(req, jsonError(400, 'missing_workspace_in_session'))
		}
		try {
			await tenancy.requireMembership(user_id, sessionWorkspace, 'viewer')
		} catch (err) {
			if (err instanceof Error && err.name === 'TenancyForbiddenError') {
				return withCorsHeaders(req, jsonError(403, 'workspace_forbidden'))
			}
			throw err
		}
		const items = await store.listForWorkspace(sessionWorkspace)
		return withCorsHeaders(
			req,
			new Response(JSON.stringify({ items }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		)
	}

	const createEndpoint = async (): Promise<Response> => {
		let body: {
			url?: string
			events?: string[]
			description?: string
			workspace_id?: string
		}
		try {
			body = (await req.json()) as typeof body
		} catch {
			return withCorsHeaders(req, jsonError(400, 'malformed_json'))
		}
		const url = (body.url ?? '').trim()
		if (!url) return withCorsHeaders(req, jsonError(400, 'missing_url'))
		const validation = validateWebhookUrl(url)
		if (!validation.ok) {
			return withCorsHeaders(
				req,
				jsonError(400, `invalid_url:${validation.reason}`, 'see the validation rules in WebhookUrl docs')
			)
		}
		const workspace_id = (body.workspace_id ?? sessionWorkspace) as WorkspaceId | undefined
		if (!workspace_id) {
			return withCorsHeaders(req, jsonError(400, 'missing_workspace_id'))
		}
		try {
			// Registering a webhook is a write-class action (it costs
			// us delivery work and exposes our IP to the URL on every
			// matching event). member+ required.
			await tenancy.requireMembership(user_id, workspace_id, 'member')
		} catch (err) {
			if (err instanceof Error && err.name === 'TenancyForbiddenError') {
				return withCorsHeaders(req, jsonError(403, 'workspace_forbidden'))
			}
			throw err
		}
		// Cap events array at 32 to bound the matchSubscribers cost.
		const events = Array.isArray(body.events) ? body.events.slice(0, 32) : undefined
		const created = await store.create({
			workspace_id,
			user_id,
			url,
			...(events !== undefined ? { events } : {}),
			...(body.description !== undefined ? { description: body.description } : {}),
		})
		// Audit. The full URL is sensitive (it may carry a path-baked
		// secret), so we record host only. Subscribed event list is
		// safe and useful in the trail.
		const urlHost = (() => {
			try {
				return new URL(created.record.url).host
			} catch {
				return 'unknown'
			}
		})()
		void audit
			.append({
				workspace_id,
				actor_user_id: user_id,
				action: 'webhook.created',
				target_type: 'webhook_endpoint',
				target_id: created.record.id,
				details: { url_host: urlHost, events: created.record.events },
			})
			.catch(() => undefined)
		return withCorsHeaders(
			req,
			new Response(
				JSON.stringify({ record: created.record, signing_secret: created.signing_secret }),
				{ status: 201, headers: { 'content-type': 'application/json' } }
			)
		)
	}

	if (req.method === 'POST') {
		return withRateLimit(
			{
				store: rateLimit,
				key: `create-webhook:${user_id}`,
				limit: 10,
				windowSec: 60,
				blockedBody: () => ({
					error: 'rate_limited',
					detail: 'too many webhook endpoints registered in the last minute',
				}),
			},
			createEndpoint
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
