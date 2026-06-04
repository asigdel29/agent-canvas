/**
 * Thin client for /api/webhooks. Session-authenticated.
 * @author asigdel29
 */

export interface WebhookEndpointSummary {
	readonly id: string
	readonly workspace_id: string
	readonly user_id: string
	readonly url: string
	readonly events: readonly string[]
	readonly description: string | null
	readonly created_at: string
	readonly revoked_at: string | null
}

export interface IssuedWebhookEndpoint {
	readonly record: WebhookEndpointSummary
	/** Returned once on creation. */
	readonly signing_secret: string
}

export class WebhooksApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly detail?: string
	) {
		super(detail ? `[${status} ${code}] ${detail}` : `[${status}] ${code}`)
		this.name = 'WebhooksApiError'
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
	throw new WebhooksApiError(res.status, body.error ?? `http_${res.status}`, body.detail)
}

export interface WebhooksApiOptions {
	readonly baseUrl: string
	readonly session: string
}

export class WebhooksApi {
	constructor(private readonly opts: WebhooksApiOptions) {}

	private headers(json = false): Record<string, string> {
		const h: Record<string, string> = { authorization: `Bearer ${this.opts.session}` }
		if (json) h['content-type'] = 'application/json'
		return h
	}

	async list(): Promise<readonly WebhookEndpointSummary[]> {
		const res = await fetch(`${this.opts.baseUrl}/api/webhooks`, { headers: this.headers() })
		await throwOnError(res)
		const body = (await res.json()) as { items: WebhookEndpointSummary[] }
		return body.items
	}

	async register(input: {
		url: string
		events?: readonly string[]
		description?: string
	}): Promise<IssuedWebhookEndpoint> {
		const res = await fetch(`${this.opts.baseUrl}/api/webhooks`, {
			method: 'POST',
			headers: this.headers(true),
			body: JSON.stringify(input),
		})
		await throwOnError(res)
		return (await res.json()) as IssuedWebhookEndpoint
	}

	async revoke(id: string): Promise<void> {
		const res = await fetch(`${this.opts.baseUrl}/api/webhooks/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			headers: this.headers(),
		})
		await throwOnError(res)
	}
}

/**
 * Subset of the audit action enum. The mint route accepts the
 * literal '*' for "every event"; otherwise pick from this list.
 * Kept in sync with the orchestrator's auditActions.ts.
 */
export const AVAILABLE_EVENTS = [
	'token.minted',
	'token.revoked',
	'webhook.created',
	'webhook.revoked',
	'member.added',
	'member.role_changed',
	'member.removed',
	'workspace.created',
] as const
