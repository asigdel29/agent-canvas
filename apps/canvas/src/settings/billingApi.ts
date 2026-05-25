/**
 * Thin client for /api/billing/*. Session-authenticated.
 */

export interface BillingStatus {
	readonly live: boolean
	readonly status: string
	readonly plan_lookup_key: string | null
	readonly current_period_end: string | null
	readonly cancel_at_period_end: boolean
	readonly gate_enabled: boolean
}

export class BillingApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly detail?: string
	) {
		super(detail ? `[${status} ${code}] ${detail}` : `[${status}] ${code}`)
		this.name = 'BillingApiError'
	}
}

async function throwOnError(res: Response): Promise<void> {
	if (res.ok) return
	let body: { error?: string; detail?: string } = {}
	try {
		body = (await res.json()) as typeof body
	} catch {
		/* swallow */
	}
	throw new BillingApiError(res.status, body.error ?? `http_${res.status}`, body.detail)
}

export interface BillingApiOptions {
	readonly baseUrl: string
	readonly session: string
}

export class BillingApi {
	constructor(private readonly opts: BillingApiOptions) {}

	private headers(json = false): Record<string, string> {
		const h: Record<string, string> = { authorization: `Bearer ${this.opts.session}` }
		if (json) h['content-type'] = 'application/json'
		return h
	}

	async status(): Promise<BillingStatus> {
		const res = await fetch(`${this.opts.baseUrl}/api/billing/status`, {
			headers: this.headers(),
		})
		await throwOnError(res)
		return (await res.json()) as BillingStatus
	}

	async checkoutSession(input: {
		return_url: string
		cancel_url: string
		price_lookup_key?: string
	}): Promise<{ url: string; session_id: string }> {
		const res = await fetch(`${this.opts.baseUrl}/api/billing/checkout-session`, {
			method: 'POST',
			headers: this.headers(true),
			body: JSON.stringify(input),
		})
		await throwOnError(res)
		return (await res.json()) as { url: string; session_id: string }
	}

	async portalSession(input: { return_url: string }): Promise<{ url: string }> {
		const res = await fetch(`${this.opts.baseUrl}/api/billing/portal-session`, {
			method: 'POST',
			headers: this.headers(true),
			body: JSON.stringify(input),
		})
		await throwOnError(res)
		return (await res.json()) as { url: string }
	}
}
