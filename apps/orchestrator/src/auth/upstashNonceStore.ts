/**
 * UpstashNonceStore — atomic single-use nonce store backed by Upstash
 * Redis over the REST API.
 *
 * Why HTTP-only Redis: Vercel serverless functions can't hold long-lived
 * TCP connections to a classic Redis. Upstash's REST API is HTTP, so it
 * works from any Vercel function without a connection pool.
 *
 * Atomicity: `SET key NX EX <ttl>` is a single Redis command. NX means
 * "only set if not exists" — the response is "OK" on first claim, null
 * on any subsequent claim within the TTL. This is true cross-instance
 * atomicity; two concurrent function invocations with the same nonce
 * cannot both win.
 *
 * Key prefix: nonces are stored under `sse:nonce:<hex>` so the Redis
 * keyspace stays scoped if the same instance hosts other state.
 *
 * Failure mode: if Upstash is down or misconfigured, `claim` returns
 * false (treats as replay). This is fail-closed — the conservative
 * default for an auth check. The caller surfaces 401 to the user; the
 * client retries with a fresh token. Operators must monitor Upstash
 * availability separately.
 */

import type { NonceStore } from './sseToken.js'

const KEY_PREFIX = 'sse:nonce:'

export interface UpstashNonceStoreOptions {
	readonly url: string
	readonly token: string
	/** Test seam — defaults to `globalThis.fetch`. */
	readonly fetchImpl?: typeof fetch
	/** Test seam — defaults to a no-op console.warn. */
	readonly onError?: (err: Error) => void
}

export class UpstashNonceStore implements NonceStore {
	private readonly url: string
	private readonly token: string
	private readonly fetchImpl: typeof fetch
	private readonly onError: (err: Error) => void

	constructor(opts: UpstashNonceStoreOptions) {
		// Strip trailing slash; the REST path concatenates raw.
		this.url = opts.url.replace(/\/+$/, '')
		this.token = opts.token
		this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
		this.onError =
			opts.onError ??
			((err: Error) => {
				// Best-effort observability. Don't crash the function on log failure.
				try {
					// eslint-disable-next-line no-console
					console.warn('[UpstashNonceStore]', err.message)
				} catch {
					/* ignore */
				}
			})
	}

	async claim(nonce: string, ttlSeconds: number): Promise<boolean> {
		const key = `${KEY_PREFIX}${nonce}`
		// Upstash REST pipeline:
		//   POST /set/<key>/<value>?NX=true&EX=<ttl>
		// Returns {"result":"OK"} on first claim, {"result":null} on conflict.
		const path = `/set/${encodeURIComponent(key)}/1?NX=true&EX=${ttlSeconds}`
		try {
			const res = await this.fetchImpl(`${this.url}${path}`, {
				method: 'POST',
				headers: { authorization: `Bearer ${this.token}` },
				// 2 second timeout protects against slow Upstash; AbortController
				// is the standards-conformant way.
				signal: AbortSignal.timeout(2000),
			})
			if (!res.ok) {
				this.onError(
					new Error(`Upstash returned HTTP ${res.status} for nonce claim`)
				)
				return false
			}
			const body = (await res.json()) as { result?: string | null }
			return body.result === 'OK'
		} catch (err) {
			this.onError(err instanceof Error ? err : new Error(String(err)))
			return false
		}
	}
}

/**
 * Construct an UpstashNonceStore from the standard Upstash env vars.
 * Returns null if either is missing so callers can fall back to the
 * in-memory store with a startup warning.
 */
export function tryCreateUpstashNonceStore(): UpstashNonceStore | null {
	const url = process.env['UPSTASH_REDIS_REST_URL']
	const token = process.env['UPSTASH_REDIS_REST_TOKEN']
	if (!url || !token) return null
	return new UpstashNonceStore({ url, token })
}
