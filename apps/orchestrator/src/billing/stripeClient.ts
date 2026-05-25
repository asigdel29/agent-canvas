/**
 * Minimal Stripe API client.
 *
 * We deliberately avoid the official Stripe Node SDK for the same
 * reasons as the rest of the codebase: it bundles auto-capture
 * patterns, adds 5 MB of cold-start, and we only need two calls.
 *
 * The two calls we make:
 *
 *   POST /v1/checkout/sessions       create a Checkout link
 *   POST /v1/billing_portal/sessions create a portal link
 *
 * Stripe's API is form-encoded with bracket notation for nested
 * fields:
 *
 *   line_items[0][price]=price_abc
 *   line_items[0][quantity]=1
 *   metadata[workspace_id]=ws_xyz
 *
 * The flatten() helper handles that encoding without bringing in
 * a form-data library.
 *
 * On Stripe API error we throw a StripeApiError carrying the HTTP
 * status and the parsed error body so the route layer can return
 * a useful 502/4xx upstream.
 */

const STRIPE_API_BASE = 'https://api.stripe.com'

export class StripeApiError extends Error {
	override readonly name = 'StripeApiError' as const
	constructor(
		readonly status: number,
		readonly stripeCode: string | null,
		message: string
	) {
		super(message)
	}
}

export interface StripeClientOptions {
	readonly secretKey: string
	/** Test seam — defaults to globalThis.fetch. */
	readonly fetchImpl?: typeof fetch
	/** Override base URL for tests. */
	readonly baseUrl?: string
}

export class StripeClient {
	private readonly secretKey: string
	private readonly fetchImpl: typeof fetch
	private readonly baseUrl: string

	constructor(opts: StripeClientOptions) {
		this.secretKey = opts.secretKey
		this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
		this.baseUrl = opts.baseUrl ?? STRIPE_API_BASE
	}

	async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<{
		readonly id: string
		readonly url: string
	}> {
		const body: Record<string, unknown> = {
			mode: 'subscription',
			success_url: input.success_url,
			cancel_url: input.cancel_url,
			'line_items[0][price]': input.price_id,
			'line_items[0][quantity]': 1,
			'metadata[workspace_id]': input.workspace_id,
			'subscription_data[metadata][workspace_id]': input.workspace_id,
		}
		if (input.customer_id) body['customer'] = input.customer_id
		if (input.customer_email) body['customer_email'] = input.customer_email
		if (input.client_reference_id) body['client_reference_id'] = input.client_reference_id
		const res = await this.post<{ id: string; url: string }>('/v1/checkout/sessions', body)
		return { id: res.id, url: res.url }
	}

	async createPortalSession(input: CreatePortalSessionInput): Promise<{
		readonly id: string
		readonly url: string
	}> {
		const res = await this.post<{ id: string; url: string }>(
			'/v1/billing_portal/sessions',
			{
				customer: input.customer_id,
				return_url: input.return_url,
			}
		)
		return { id: res.id, url: res.url }
	}

	private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
		const formBody = encodeForm(flatten(body))
		const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${this.secretKey}`,
				'content-type': 'application/x-www-form-urlencoded',
				// Stripe respects this for idempotency on POST creates;
				// we don't supply one for foundation but the header
				// position is here for the future.
			},
			body: formBody,
		})
		if (!res.ok) {
			type ErrorBody = { error?: { code?: string; message?: string } }
			let parsed: ErrorBody | null = null
			try {
				parsed = (await res.json()) as ErrorBody
			} catch {
				/* swallow */
			}
			throw new StripeApiError(
				res.status,
				parsed?.error?.code ?? null,
				parsed?.error?.message ?? `Stripe API returned HTTP ${res.status}`
			)
		}
		return (await res.json()) as T
	}
}

export interface CreateCheckoutSessionInput {
	readonly workspace_id: string
	readonly price_id: string
	readonly success_url: string
	readonly cancel_url: string
	readonly customer_id?: string
	readonly customer_email?: string
	readonly client_reference_id?: string
}

export interface CreatePortalSessionInput {
	readonly customer_id: string
	readonly return_url: string
}

/**
 * Stripe's form encoding is mostly url-encoded key=value pairs with
 * bracket notation already pre-baked into the keys by the caller.
 * We accept the bracket-bearing keys as-is.
 */
function flatten(input: Record<string, unknown>): Array<[string, string]> {
	const out: Array<[string, string]> = []
	for (const [k, v] of Object.entries(input)) {
		if (v === undefined || v === null) continue
		out.push([k, String(v)])
	}
	return out
}

function encodeForm(pairs: ReadonlyArray<[string, string]>): string {
	return pairs
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join('&')
}
