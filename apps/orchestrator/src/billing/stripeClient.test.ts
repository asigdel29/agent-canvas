import { describe, expect, it, vi } from 'vitest'
import { StripeApiError, StripeClient } from './stripeClient.js'

function captureFetch(
	response: { status: number; body: unknown }
): {
	fetch: typeof fetch
	calls: Array<{ url: string; method: string; body: string; auth: string | null }>
} {
	const calls: Array<{ url: string; method: string; body: string; auth: string | null }> = []
	const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers ?? {})
		calls.push({
			url: String(input),
			method: (init?.method ?? 'GET') as string,
			body: typeof init?.body === 'string' ? init.body : '',
			auth: headers.get('authorization'),
		})
		return new Response(JSON.stringify(response.body), {
			status: response.status,
			headers: { 'content-type': 'application/json' },
		})
	}) as unknown as typeof fetch
	return { fetch: fn, calls }
}

describe('StripeClient.createCheckoutSession', () => {
	it('POSTs to /v1/checkout/sessions with form-encoded body + Bearer auth', async () => {
		const { fetch, calls } = captureFetch({
			status: 200,
			body: { id: 'cs_1', url: 'https://checkout.stripe.com/x' },
		})
		const c = new StripeClient({
			secretKey: 'sk_test_abc',
			fetchImpl: fetch,
			baseUrl: 'https://api.stripe.com',
		})
		const out = await c.createCheckoutSession({
			workspace_id: 'ws_1',
			price_id: 'price_abc',
			success_url: 'https://app/ok',
			cancel_url: 'https://app/x',
		})
		expect(out.url).toBe('https://checkout.stripe.com/x')
		expect(calls).toHaveLength(1)
		expect(calls[0]!.url).toBe('https://api.stripe.com/v1/checkout/sessions')
		expect(calls[0]!.method).toBe('POST')
		expect(calls[0]!.auth).toBe('Bearer sk_test_abc')
		const body = calls[0]!.body
		// Form keys we promised the route.
		expect(body).toContain('mode=subscription')
		expect(body).toContain(encodeURIComponent('line_items[0][price]') + '=price_abc')
		expect(body).toContain(encodeURIComponent('line_items[0][quantity]') + '=1')
		expect(body).toContain(encodeURIComponent('metadata[workspace_id]') + '=ws_1')
	})

	it('passes customer_id when supplied', async () => {
		const { fetch, calls } = captureFetch({
			status: 200,
			body: { id: 'cs_1', url: 'u' },
		})
		const c = new StripeClient({ secretKey: 'sk', fetchImpl: fetch })
		await c.createCheckoutSession({
			workspace_id: 'ws_1',
			price_id: 'price_abc',
			success_url: 's',
			cancel_url: 'c',
			customer_id: 'cus_xyz',
		})
		expect(calls[0]!.body).toContain('customer=cus_xyz')
	})

	it('passes customer_email when supplied (and no customer_id)', async () => {
		const { fetch, calls } = captureFetch({
			status: 200,
			body: { id: 'cs_1', url: 'u' },
		})
		const c = new StripeClient({ secretKey: 'sk', fetchImpl: fetch })
		await c.createCheckoutSession({
			workspace_id: 'ws_1',
			price_id: 'price_abc',
			success_url: 's',
			cancel_url: 'c',
			customer_email: 'a@example.com',
		})
		expect(calls[0]!.body).toContain('customer_email=' + encodeURIComponent('a@example.com'))
	})

	it('throws StripeApiError with status + code on a 4xx', async () => {
		const { fetch } = captureFetch({
			status: 400,
			body: { error: { code: 'parameter_invalid', message: 'bad price_id' } },
		})
		const c = new StripeClient({ secretKey: 'sk', fetchImpl: fetch })
		await expect(
			c.createCheckoutSession({
				workspace_id: 'ws_1',
				price_id: 'bad',
				success_url: 's',
				cancel_url: 'c',
			})
		).rejects.toMatchObject({
			name: 'StripeApiError',
			status: 400,
			stripeCode: 'parameter_invalid',
		})
	})
})

describe('StripeClient.createPortalSession', () => {
	it('POSTs to /v1/billing_portal/sessions with customer + return_url', async () => {
		const { fetch, calls } = captureFetch({
			status: 200,
			body: { id: 'bps_1', url: 'https://billing.stripe.com/p/x' },
		})
		const c = new StripeClient({ secretKey: 'sk', fetchImpl: fetch })
		const out = await c.createPortalSession({
			customer_id: 'cus_xyz',
			return_url: 'https://app/settings',
		})
		expect(out.url).toBe('https://billing.stripe.com/p/x')
		expect(calls[0]!.url).toBe('https://api.stripe.com/v1/billing_portal/sessions')
		expect(calls[0]!.body).toContain('customer=cus_xyz')
		expect(calls[0]!.body).toContain(
			'return_url=' + encodeURIComponent('https://app/settings')
		)
	})

	it('throws StripeApiError on non-2xx', async () => {
		const { fetch } = captureFetch({
			status: 404,
			body: { error: { code: 'resource_missing', message: 'no such customer' } },
		})
		const c = new StripeClient({ secretKey: 'sk', fetchImpl: fetch })
		await expect(
			c.createPortalSession({ customer_id: 'cus_missing', return_url: 'r' })
		).rejects.toBeInstanceOf(StripeApiError)
	})
})
