/**
 * Thin client for /api/tokens. Mirrors the SDK shape but lives in
 * the canvas because the canvas calls the orchestrator via session
 * JWT, not an API token.
 * @author asigdel29
 */

export type ApiTokenScope = 'read' | 'write'

export interface ApiTokenSummary {
	readonly id: string
	readonly name: string
	readonly token_prefix: string
	readonly scope: ApiTokenScope
	readonly created_at: string
	readonly last_used_at: string | null
	readonly expires_at: string | null
	readonly revoked_at: string | null
}

export interface IssuedToken {
	readonly record: ApiTokenSummary
	/** Returned once on creation. */
	readonly raw_token: string
}

export class TokensApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly detail?: string
	) {
		super(detail ? `[${status} ${code}] ${detail}` : `[${status}] ${code}`)
		this.name = 'TokensApiError'
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
	throw new TokensApiError(res.status, body.error ?? `http_${res.status}`, body.detail)
}

export interface TokensApiOptions {
	readonly baseUrl: string
	readonly session: string
}

export class TokensApi {
	constructor(private readonly opts: TokensApiOptions) {}

	private headers(json = false): Record<string, string> {
		const h: Record<string, string> = { authorization: `Bearer ${this.opts.session}` }
		if (json) h['content-type'] = 'application/json'
		return h
	}

	async list(): Promise<readonly ApiTokenSummary[]> {
		const res = await fetch(`${this.opts.baseUrl}/api/tokens`, { headers: this.headers() })
		await throwOnError(res)
		const body = (await res.json()) as { items: ApiTokenSummary[] }
		return body.items
	}

	async mint(input: { name: string; scope: ApiTokenScope }): Promise<IssuedToken> {
		const res = await fetch(`${this.opts.baseUrl}/api/tokens`, {
			method: 'POST',
			headers: this.headers(true),
			body: JSON.stringify(input),
		})
		await throwOnError(res)
		return (await res.json()) as IssuedToken
	}

	async revoke(id: string): Promise<void> {
		const res = await fetch(`${this.opts.baseUrl}/api/tokens/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			headers: this.headers(),
		})
		await throwOnError(res)
	}
}
