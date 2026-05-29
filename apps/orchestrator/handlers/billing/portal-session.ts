/**
 * POST /api/billing/portal-session
 *
 * Creates a Stripe Customer Portal session so the workspace member
 * can manage their subscription (update card, cancel, view invoices).
 * Returns { url } — the canvas redirects to it.
 *
 * Body:
 *   { return_url: string }
 *
 * Tenancy: member+. Requires that the workspace ALREADY has a Stripe
 * customer record (i.e. they've completed Checkout at least once);
 * otherwise returns 409 'no_customer'.
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

	let body: { return_url?: string }
	try {
		body = (await req.json()) as typeof body
	} catch {
		return withCorsHeaders(req, jsonError(400, 'malformed_json'))
	}
	if (!body.return_url) return withCorsHeaders(req, jsonError(400, 'missing_return_url'))

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

	const customer = await billing.getCustomer(workspace_id)
	if (!customer) {
		return withCorsHeaders(
			req,
			jsonError(409, 'no_customer', 'workspace has no Stripe customer yet; complete checkout first')
		)
	}

	const stripe = new StripeClient({ secretKey: stripeKey })
	try {
		const sess = await stripe.createPortalSession({
			customer_id: customer.stripe_customer_id,
			return_url: body.return_url,
		})
		return withCorsHeaders(
			req,
			new Response(JSON.stringify({ url: sess.url }), {
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

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
