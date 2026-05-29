/**
 * POST /api/billing/stripe-webhook
 *
 * Stripe-delivered events arrive here. The handler does three things
 * in order:
 *
 *   1. Read the raw body bytes (NOT the JSON-parsed object — the
 *      signature is over the raw bytes, so JSON parsing must happen
 *      after verification).
 *   2. Verify the Stripe-Signature header against STRIPE_WEBHOOK_SECRET.
 *      A failed verification returns 400; Stripe will keep retrying,
 *      but only when our config is broken, never for a tampered event.
 *   3. Parse JSON, hand off to processStripeEvent, return 200.
 *
 * Stripe expects 2xx on success and treats anything else as a
 * delivery failure (it retries with backoff for up to 3 days). The
 * 'ignored' result from the processor still maps to 200; Stripe
 * doesn't need to retry events we have nothing to do with.
 *
 * We deliberately do NOT verify via the Stripe SDK. Pulling in the
 * SDK adds bundle weight and a code path that auto-captures the
 * payload server-side; the verify primitive we wrote here is the
 * same logic, hand-rolled, and tested in isolation.
 */

import { getRuntime } from '../../dist/index.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'
import {
	STRIPE_SIGNATURE_HEADER,
	verifyStripeSignature,
} from '../../dist/billing/stripeSignature.js'
import { processStripeEvent } from '../../dist/billing/processStripeEvent.js'

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight
	if (req.method !== 'POST') {
		return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))
	}

	const secret = process.env['STRIPE_WEBHOOK_SECRET']
	if (!secret) {
		return withCorsHeaders(req, jsonError(500, 'stripe_webhook_secret_not_configured'))
	}

	const sigHeader = req.headers.get(STRIPE_SIGNATURE_HEADER)
	if (!sigHeader) {
		return withCorsHeaders(req, jsonError(400, 'missing_stripe_signature'))
	}

	// Read raw bytes for signature verification. await req.text()
	// returns the body exactly as Stripe sent it; req.json() would
	// re-serialize and break the signature.
	const rawBody = await req.text()
	const verified = verifyStripeSignature({
		secret,
		header: sigHeader,
		body: rawBody,
	})
	if (!verified.ok) {
		return withCorsHeaders(req, jsonError(400, `signature_${verified.reason}`))
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(rawBody)
	} catch {
		return withCorsHeaders(req, jsonError(400, 'malformed_json'))
	}
	const event = parsed as {
		id?: string
		type?: string
		created?: number
		data?: { object?: Record<string, unknown> }
	}
	if (!event.id || !event.type || !event.created || !event.data?.object) {
		return withCorsHeaders(req, jsonError(400, 'malformed_event'))
	}

	const runtime = getRuntime() as unknown as {
		billingStore?: import('../../dist/billing/billingStore.js').BillingStore
	}
	const store = runtime.billingStore
	if (!store) {
		return withCorsHeaders(req, jsonError(500, 'billing_store_not_initialized'))
	}

	try {
		const result = await processStripeEvent(
			{
				id: event.id,
				type: event.type,
				created: event.created,
				data: { object: event.data.object },
			},
			store
		)
		return withCorsHeaders(
			req,
			new Response(JSON.stringify(result), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		)
	} catch (err) {
		// Surface the error to Stripe as 500 so it retries; better
		// to double-process than to silently drop on a transient DB
		// blip. The store writes are idempotent (upsert on conflict).
		return withCorsHeaders(
			req,
			jsonError(500, 'process_failed', err instanceof Error ? err.message : 'unknown')
		)
	}
}

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
