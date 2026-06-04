/**
 * GET /api/cron/drain-webhooks
 *
 * Vercel-cron-compatible drain tick. Vercel cron jobs hit a path on
 * schedule with `Authorization: Bearer ${CRON_SECRET}` automatically
 * (the secret is injected at deploy time when the cron is registered
 * in vercel.json). This endpoint authenticates via that header and
 * delegates to drainOnce.
 *
 * Why a separate endpoint from /api/admin/webhooks/drain:
 *   - Vercel cron expects GET; the admin path is POST so curl-driven
 *     ops can't accidentally fire it from a refresh.
 *   - CRON_SECRET is Vercel-controlled; ADMIN_DRAIN_SECRET is operator-
 *     controlled. Separate secrets let either rotate independently.
 *   - The cron path is exposed via the vercel.json `crons` array.
 *
 * Schedule: every minute (vercel.json). The drain batch size of 16
 * means we process ~960 deliveries/hour worst case before exhausting
 * the 60s function budget; in practice the queue clears in a few
 * batches and the rest of the minute is idle.
 * @author asigdel29
 */

import { getRuntime } from '../../dist/index.js'
import { drainOnce } from '../../dist/webhooks/drainOnce.js'

export default async function handler(req: Request): Promise<Response> {
	// Vercel cron is GET-only. Block other methods so a misroute
	// can't accidentally trigger this.
	if (req.method !== 'GET') {
		return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
			status: 405,
			headers: { 'content-type': 'application/json' },
		})
	}

	const secret = process.env['CRON_SECRET']
	if (!secret) {
		return new Response(
			JSON.stringify({ error: 'cron_secret_not_configured' }),
			{ status: 500, headers: { 'content-type': 'application/json' } }
		)
	}
	const auth = req.headers.get('authorization') ?? ''
	if (auth !== `Bearer ${secret}`) {
		return new Response(JSON.stringify({ error: 'unauthorized' }), {
			status: 401,
			headers: { 'content-type': 'application/json' },
		})
	}

	const runtime = getRuntime() as unknown as {
		webhookEndpointStore?: import('../../dist/webhooks/webhookEndpointStore.js').WebhookEndpointStore
		webhookDeliveryStore?: import('../../dist/webhooks/webhookDeliveryStore.js').WebhookDeliveryStore
	}
	const endpointStore = runtime.webhookEndpointStore
	const deliveryStore = runtime.webhookDeliveryStore
	if (!endpointStore || !deliveryStore) {
		return new Response(
			JSON.stringify({ error: 'runtime_not_fully_initialized' }),
			{ status: 500, headers: { 'content-type': 'application/json' } }
		)
	}

	const summary = await drainOnce({ endpointStore, deliveryStore }, { batchSize: 16 })
	return new Response(JSON.stringify(summary), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	})
}
