/**
 * POST /api/billing/checkout-session
 *
 * Creates a Stripe Checkout Session for the session workspace and
 * returns the URL the canvas should redirect to.
 *
 * Body:
 *   {
 *     return_url: string,   // where to land after success
 *     cancel_url: string,   // where to land on cancel
 *     price_lookup_key?: string  // overrides BILLING_DEFAULT_PRICE_LOOKUP_KEY
 *   }
 *
 * Tenancy: member+ (a viewer should not be able to charge the
 * workspace; whoever initiates billing should be able to start
 * runs anyway).
 *
 * Resolves the Stripe price_id from the price_lookup_key. We never
 * accept a raw price_id from the client — that would let any logged-
 * in user reuse a different workspace's pricing.
 *
 * If the workspace already has a Stripe customer record locally,
 * we pass customer_id; otherwise customer_email so Stripe creates
 * a new Customer at Checkout time.
 */

import { getRuntime } from '../../dist/index.js'
import { extractSession } from '../../dist/auth/session.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'
import { StripeApiError, StripeClient } from '../../dist/billing/stripeClient.js'
import type { UserId } from '@agent-canvas/orchestrator-types'
import type { WorkspaceId } from '../../dist/tenancy/tenancyTypes.js'

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight
	if (req.method !== 'POST') {
		return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))
	}

	const jwtSecret = process.env['JWT_SECRET']
	if (!jwtSecret) return withCorsHeaders(req, jsonError(500, 'jwt_secret_not_configured'))
	const session = extractSession(req, jwtSecret)
	if (!session) return withCorsHeaders(req, jsonError(401, 'unauthorized'))

	const stripeKey = process.env['STRIPE_SECRET_KEY']
	if (!stripeKey) {
		return withCorsHeaders(req, jsonError(500, 'stripe_secret_key_not_configured'))
	}

	const runtime = getRuntime() as unknown as {
		billingStore?: import('../../dist/billing/billingStore.js').BillingStore
		tenancyStore?: import('../../dist/tenancy/tenancyStore.js').TenancyStore
	}
	const billing = runtime.billingStore
	const tenancy = runtime.tenancyStore
	if (!billing || !tenancy) {
		return withCorsHeaders(req, jsonError(500, 'runtime_not_fully_initialized'))
	}

	let body: { return_url?: string; cancel_url?: string; price_lookup_key?: string }
	try {
		body = (await req.json()) as typeof body
	} catch {
		return withCorsHeaders(req, jsonError(400, 'malformed_json'))
	}
	if (!body.return_url || !body.cancel_url) {
		return withCorsHeaders(req, jsonError(400, 'missing_return_or_cancel_url'))
	}

	const user_id = session.sub as UserId
	const workspace_id = session.workspace_id as WorkspaceId | undefined
	if (!workspace_id) {
		return withCorsHeaders(req, jsonError(400, 'missing_workspace_in_session'))
	}

	try {
		await tenancy.requireMembership(user_id, workspace_id, 'member')
	} catch (err) {
		if (err instanceof Error && err.name === 'TenancyForbiddenError') {
			return withCorsHeaders(req, jsonError(403, 'workspace_forbidden'))
		}
		throw err
	}

	const priceId = await resolvePriceId(body.price_lookup_key)
	if (!priceId) {
		return withCorsHeaders(
			req,
			jsonError(
				400,
				'no_price_configured',
				'Set BILLING_DEFAULT_PRICE_ID or pass price_lookup_key mapped via env.'
			)
		)
	}

	const existing = await billing.getCustomer(workspace_id)
	const stripe = new StripeClient({ secretKey: stripeKey })
	try {
		const sess = await stripe.createCheckoutSession({
			workspace_id,
			price_id: priceId,
			success_url: body.return_url,
			cancel_url: body.cancel_url,
			client_reference_id: workspace_id,
			...(existing?.stripe_customer_id
				? { customer_id: existing.stripe_customer_id }
				: existing?.email
					? { customer_email: existing.email }
					: {}),
		})
		return withCorsHeaders(
			req,
			new Response(JSON.stringify({ url: sess.url, session_id: sess.id }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		)
	} catch (err) {
		if (err instanceof StripeApiError) {
			return withCorsHeaders(
				req,
				jsonError(502, 'stripe_api_error', `${err.status}: ${err.message}`)
			)
		}
		throw err
	}
}

/**
 * Resolve a price_lookup_key to the Stripe price_id. Foundation
 * supports two shapes:
 *
 *   - If price_lookup_key is omitted, use BILLING_DEFAULT_PRICE_ID
 *     directly.
 *   - If price_lookup_key is supplied, look up
 *     BILLING_PRICE_<UPPERCASE_KEY> in env.
 *
 * A real implementation would call Stripe's /v1/prices?lookup_keys=
 * but that adds a round-trip per Checkout creation. Env-mapped
 * keeps the foundation flat; the lookup endpoint plugs in later.
 */
async function resolvePriceId(lookupKey: string | undefined): Promise<string | null> {
	if (!lookupKey) {
		return process.env['BILLING_DEFAULT_PRICE_ID'] ?? null
	}
	const envKey = `BILLING_PRICE_${lookupKey.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
	return process.env[envKey] ?? null
}

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
