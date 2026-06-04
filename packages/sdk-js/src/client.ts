/**
 * AgentCanvasClient — Bearer-authenticated REST client.
 *
 * Usage:
 *
 *   const ac = new AgentCanvasClient({
 *     base_url: 'https://orchestrator.example.com',
 *     token: process.env.AGENT_CANVAS_TOKEN!,  // ack_<43-char-base64url>
 *   })
 *
 *   const tokens = await ac.tokens.list()
 *   const run = await ac.runs.start({ ... })
 *   for await (const event of ac.runs.stream(run.run_id)) { ... }  // future
 *
 * Method shape mirrors the route surface: tokens, webhooks, audit,
 * runs. Each method throws an ApiError when the orchestrator
 * returns a non-2xx; success returns a typed body.
 *
 * Rate-limit headers are surfaced through the ApiError on 429 so a
 * caller can self-pace without re-parsing them.
 * @author asigdel29
 */

import type {
	ApiTokenSummary,
	IssuedToken,
	IssuedWebhookEndpoint,
	WebhookEndpointSummary,
	AuditEvent,
	RunStartInput,
	RunStartResult,
	ApiTokenScope,
} from './types.js'

export interface AgentCanvasClientOptions {
	/** Orchestrator origin, e.g. https://orchestrator.example.com */
	readonly base_url: string
	/** API token from POST /api/tokens (prefix `ack_`). */
	readonly token: string
	/** Test seam. */
	readonly fetchImpl?: typeof fetch
	/** Per-request timeout in ms. Default 30s. */
	readonly timeout_ms?: number
}

export class ApiError extends Error {
	override readonly name = 'ApiError' as const
	constructor(
		readonly status: number,
		readonly code: string,
		readonly detail: string | null,
		/** Standard rate-limit headers, when present on the response. */
		readonly rate_limit: RateLimitMeta | null
	) {
		super(`${status} ${code}${detail ? `: ${detail}` : ''}`)
	}
}

export interface RateLimitMeta {
	readonly limit: number | null
	readonly remaining: number | null
	readonly reset_at_sec: number | null
	readonly retry_after_sec: number | null
}

export class AgentCanvasClient {
	private readonly base: string
	private readonly token: string
	private readonly fetchImpl: typeof fetch
	private readonly timeoutMs: number

	constructor(opts: AgentCanvasClientOptions) {
		this.base = opts.base_url.replace(/\/+$/, '')
		this.token = opts.token
		this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
		this.timeoutMs = opts.timeout_ms ?? 30_000
	}

	/* ---------------------------------------------------------- *
	 * tokens                                                      *
	 * ---------------------------------------------------------- */

	readonly tokens = {
		list: async (): Promise<readonly ApiTokenSummary[]> => {
			const res = await this.request<{ items: ApiTokenSummary[] }>('GET', '/api/tokens')
			return res.items
		},
		mint: async (input: {
			name: string
			scope: ApiTokenScope
			workspace_id?: string
			expires_at?: string | null
		}): Promise<IssuedToken> => {
			return this.request<IssuedToken>('POST', '/api/tokens', input)
		},
		revoke: async (id: string): Promise<void> => {
			await this.request<unknown>('DELETE', `/api/tokens/${encodeURIComponent(id)}`)
		},
	}

	/* ---------------------------------------------------------- *
	 * webhooks                                                    *
	 * ---------------------------------------------------------- */

	readonly webhooks = {
		list: async (): Promise<readonly WebhookEndpointSummary[]> => {
			const res = await this.request<{ items: WebhookEndpointSummary[] }>(
				'GET',
				'/api/webhooks'
			)
			return res.items
		},
		register: async (input: {
			url: string
			events?: readonly string[]
			description?: string
			workspace_id?: string
		}): Promise<IssuedWebhookEndpoint> => {
			return this.request<IssuedWebhookEndpoint>('POST', '/api/webhooks', input)
		},
		revoke: async (id: string): Promise<void> => {
			await this.request<unknown>(
				'DELETE',
				`/api/webhooks/${encodeURIComponent(id)}`
			)
		},
	}

	/* ---------------------------------------------------------- *
	 * audit                                                       *
	 * ---------------------------------------------------------- */

	readonly audit = {
		query: async (params: {
			workspace_id?: string
			since?: string
			until?: string
			actor?: string
			action?: string
			limit?: number
		} = {}): Promise<readonly AuditEvent[]> => {
			const qs = new URLSearchParams()
			for (const [k, v] of Object.entries(params)) {
				if (v !== undefined) qs.set(k, String(v))
			}
			const path = `/api/audit${qs.toString() ? `?${qs.toString()}` : ''}`
			const res = await this.request<{ items: AuditEvent[] }>('GET', path)
			return res.items
		},
	}

	/* ---------------------------------------------------------- *
	 * runs                                                        *
	 * ---------------------------------------------------------- */

	readonly runs = {
		start: async (input: RunStartInput): Promise<RunStartResult> => {
			return this.request<RunStartResult>('POST', '/api/agents/runs', input)
		},
	}

	/* ---------------------------------------------------------- *
	 * transport                                                   *
	 * ---------------------------------------------------------- */

	private async request<T>(
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		body?: unknown
	): Promise<T> {
		const headers: Record<string, string> = {
			authorization: `Bearer ${this.token}`,
			accept: 'application/json',
		}
		if (body !== undefined) headers['content-type'] = 'application/json'
		const init: RequestInit = {
			method,
			headers,
			signal: AbortSignal.timeout(this.timeoutMs),
		}
		if (body !== undefined) init.body = JSON.stringify(body)
		const res = await this.fetchImpl(`${this.base}${path}`, init)
		if (res.status === 204) {
			return undefined as T
		}
		const text = await res.text()
		let parsed: unknown = null
		if (text.length > 0) {
			try {
				parsed = JSON.parse(text)
			} catch {
				if (!res.ok) {
					throw new ApiError(res.status, 'malformed_response', text.slice(0, 200), null)
				}
				return undefined as T
			}
		}
		if (!res.ok) {
			const errBody = parsed as { error?: string; detail?: string } | null
			throw new ApiError(
				res.status,
				errBody?.error ?? `http_${res.status}`,
				errBody?.detail ?? null,
				readRateLimitMeta(res)
			)
		}
		return parsed as T
	}
}

function readRateLimitMeta(res: Response): RateLimitMeta | null {
	const limit = res.headers.get('x-ratelimit-limit')
	if (!limit) return null
	return {
		limit: numOrNull(limit),
		remaining: numOrNull(res.headers.get('x-ratelimit-remaining')),
		reset_at_sec: numOrNull(res.headers.get('x-ratelimit-reset')),
		retry_after_sec: numOrNull(res.headers.get('retry-after')),
	}
}

function numOrNull(v: string | null): number | null {
	if (v === null) return null
	const n = Number(v)
	return Number.isFinite(n) ? n : null
}
