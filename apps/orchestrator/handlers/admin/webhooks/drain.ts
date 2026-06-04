/**
 * POST /api/admin/webhooks/drain
 *
 * Bearer-token-gated tick endpoint. A cron (Vercel cron, GitHub
 * Actions, or external) hits this every N seconds. Each call drains
 * one batch of pending deliveries. Returning the summary lets the
 * cron operator alert on persistently high retry / fail counts.
 *
 * Authorization:
 *   Authorization: Bearer <ADMIN_DRAIN_SECRET>
 *
 * The secret is shared between the cron caller and this handler. It
 * is NOT a session, not an API token — those are workspace-scoped
 * identities. The drain endpoint is workspace-agnostic; the entire
 * pending queue is one shared resource. A dedicated env var keeps
 * the auth model simple.
 * @author asigdel29
 */

import { getRuntime } from '../../../dist/index.js'
import { preflightResponse, withCorsHeaders } from '../../../dist/http/cors.js'
import { drainOnce } from '../../../dist/webhooks/drainOnce.js'

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight
	if (req.method !== 'POST') {
		return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))
	}

	const secret = process.env['ADMIN_DRAIN_SECRET']
	if (!secret) {
		return withCorsHeaders(req, jsonError(500, 'admin_drain_secret_not_configured'))
	}
	const auth = req.headers.get('authorization') ?? ''
	if (!auth.startsWith('Bearer ')) {
		return withCorsHeaders(req, jsonError(401, 'unauthorized'))
	}
	const presented = auth.slice('Bearer '.length).trim()
	// Constant-time compare. Lengths may differ; reject early if so.
	if (
		presented.length !== secret.length ||
		!constantTimeEqual(presented, secret)
	) {
		return withCorsHeaders(req, jsonError(401, 'unauthorized'))
	}

	const runtime = getRuntime() as unknown as {
		webhookEndpointStore?: import('../../../dist/webhooks/webhookEndpointStore.js').WebhookEndpointStore
		webhookDeliveryStore?: import('../../../dist/webhooks/webhookDeliveryStore.js').WebhookDeliveryStore
	}
	const endpointStore = runtime.webhookEndpointStore
	const deliveryStore = runtime.webhookDeliveryStore
	if (!endpointStore || !deliveryStore) {
		return withCorsHeaders(req, jsonError(500, 'runtime_not_fully_initialized'))
	}

	const url = new URL(req.url)
	const batchParam = url.searchParams.get('batch')
	const batchSize = batchParam ? Math.min(64, Math.max(1, Number(batchParam))) : 16

	const summary = await drainOnce({ endpointStore, deliveryStore }, { batchSize })
	return withCorsHeaders(
		req,
		new Response(JSON.stringify(summary), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	)
}

function constantTimeEqual(a: string, b: string): boolean {
	let r = 0
	for (let i = 0; i < a.length; i++) {
		r |= a.charCodeAt(i) ^ b.charCodeAt(i)
	}
	return r === 0
}

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
