/**
 * Rate-limit primitives.
 *
 * Model: fixed window counter. Every (key, window_start) tuple holds
 * a counter; the bucket resets when the window ends. Less accurate
 * than a sliding window (a burst at the boundary can do 2x the
 * allowance), more efficient (one INCR per request). For foundation
 * shape this is enough; sliding-window upgrade is deferred.
 *
 * Two adapters, runtime-selected:
 *
 *   InMemoryRateLimitStore   single-instance dev / tests. Per-process
 *                            Map; restart resets every bucket. Cross-
 *                            instance traffic is NOT limited.
 *
 *   UpstashRateLimitStore    cross-instance. INCR+EXPIRE batched in
 *                            one Upstash REST pipeline round-trip.
 *
 * Selection rule mirrors {@link UpstashNonceStore}: when
 * UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set, the
 * Upstash adapter wins. Otherwise we fall back to in-memory with a
 * boot-time warning (logged from runtime.ts, not here).
 *
 * Failure mode for Upstash: when the REST call errors or times out
 * we FAIL OPEN, i.e. allow the request through. This is the opposite
 * of the nonce store, where we fail closed. Reasoning: rate limit is
 * a brownout knob, not an auth check; a Redis outage taking down all
 * traffic would amplify the incident. Operators should monitor
 * Upstash availability separately and add a circuit breaker layer
 * if the brownout risk needs to flip.
 */

export interface RateLimitResult {
	/** True when the request should proceed. */
	readonly allowed: boolean
	/** Configured ceiling for this bucket; surfaced as X-RateLimit-Limit. */
	readonly limit: number
	/** Remaining tokens in the bucket. Zero when blocked. */
	readonly remaining: number
	/** Epoch ms when the window resets. Surfaced as X-RateLimit-Reset. */
	readonly reset_at_ms: number
}

export interface RateLimitStore {
	/**
	 * Atomically increment the counter at `key` and report whether the
	 * caller is under the per-window ceiling.
	 *
	 * Postconditions:
	 *   - On success: bucket count is incremented and TTL armed.
	 *   - On Upstash failure: returns allowed=true, remaining=limit
	 *     (fail-open). Caller cannot distinguish; operators must
	 *     monitor Upstash error counts separately.
	 */
	consume(key: string, limit: number, windowSec: number): Promise<RateLimitResult>
}

/** Compute the epoch-second window start for a given timestamp. */
function windowStartSec(nowMs: number, windowSec: number): number {
	return Math.floor(nowMs / 1000 / windowSec) * windowSec
}

/* -------------------------------------------------------------- *
 * InMemoryRateLimitStore                                          *
 * -------------------------------------------------------------- */

interface Bucket {
	count: number
	resetAtMs: number
}

export class InMemoryRateLimitStore implements RateLimitStore {
	/** Visible for testing. */
	readonly buckets = new Map<string, Bucket>()

	async consume(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
		const now = Date.now()
		const winStartSec = windowStartSec(now, windowSec)
		const resetAtMs = (winStartSec + windowSec) * 1000
		const bucketKey = `${key}:${winStartSec}`
		const existing = this.buckets.get(bucketKey)
		if (!existing) {
			// Opportunistic garbage collection of expired buckets keyed by
			// the same logical key. Keeps the Map from leaking when a
			// caller hammers the same key with long windows.
			for (const [k, v] of this.buckets) {
				if (v.resetAtMs <= now) this.buckets.delete(k)
			}
			this.buckets.set(bucketKey, { count: 1, resetAtMs })
			return { allowed: true, limit, remaining: limit - 1, reset_at_ms: resetAtMs }
		}
		existing.count += 1
		if (existing.count > limit) {
			return { allowed: false, limit, remaining: 0, reset_at_ms: existing.resetAtMs }
		}
		return {
			allowed: true,
			limit,
			remaining: Math.max(0, limit - existing.count),
			reset_at_ms: existing.resetAtMs,
		}
	}
}

/* -------------------------------------------------------------- *
 * UpstashRateLimitStore                                           *
 * -------------------------------------------------------------- */

export interface UpstashRateLimitStoreOptions {
	readonly url: string
	readonly token: string
	readonly fetchImpl?: typeof fetch
	readonly onError?: (err: Error) => void
}

const KEY_PREFIX = 'rl:'

export class UpstashRateLimitStore implements RateLimitStore {
	private readonly url: string
	private readonly token: string
	private readonly fetchImpl: typeof fetch
	private readonly onError: (err: Error) => void

	constructor(opts: UpstashRateLimitStoreOptions) {
		this.url = opts.url.replace(/\/+$/, '')
		this.token = opts.token
		this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
		this.onError =
			opts.onError ??
			((err: Error) => {
				try {
					// eslint-disable-next-line no-console
					console.warn('[UpstashRateLimitStore]', err.message)
				} catch {
					/* ignore */
				}
			})
	}

	async consume(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
		const now = Date.now()
		const winStartSec = windowStartSec(now, windowSec)
		const resetAtMs = (winStartSec + windowSec) * 1000
		const bucketKey = `${KEY_PREFIX}${key}:${winStartSec}`
		// Pipeline two commands in one HTTP round-trip:
		//   INCR <key>          -> integer count after increment
		//   EXPIRE <key> <ttl>  -> 1 if applied, 0 if key missing
		// EXPIRE is idempotent; setting it on every call wastes a few
		// bytes but eliminates the "first INCR raced ahead of EXPIRE"
		// failure mode where the key would never expire.
		try {
			const res = await this.fetchImpl(`${this.url}/pipeline`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${this.token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify([
					['INCR', bucketKey],
					['EXPIRE', bucketKey, windowSec],
				]),
				signal: AbortSignal.timeout(2000),
			})
			if (!res.ok) {
				this.onError(
					new Error(`Upstash pipeline returned HTTP ${res.status} for rate limit`)
				)
				return this.failOpen(limit, resetAtMs)
			}
			const body = (await res.json()) as Array<{ result?: number | null; error?: string }>
			const incrResult = body[0]?.result
			if (typeof incrResult !== 'number') {
				this.onError(new Error('Upstash INCR returned non-numeric result'))
				return this.failOpen(limit, resetAtMs)
			}
			if (incrResult > limit) {
				return { allowed: false, limit, remaining: 0, reset_at_ms: resetAtMs }
			}
			return {
				allowed: true,
				limit,
				remaining: Math.max(0, limit - incrResult),
				reset_at_ms: resetAtMs,
			}
		} catch (err) {
			this.onError(err instanceof Error ? err : new Error(String(err)))
			return this.failOpen(limit, resetAtMs)
		}
	}

	private failOpen(limit: number, resetAtMs: number): RateLimitResult {
		// Fail-open: a Redis outage must not take all traffic down.
		// Surface as "full bucket" so headers don't lie about a phantom
		// 0-remaining state.
		return { allowed: true, limit, remaining: limit, reset_at_ms: resetAtMs }
	}
}

/** Construct from env, or null when not configured. */
export function tryCreateUpstashRateLimitStore(): UpstashRateLimitStore | null {
	const url = process.env['UPSTASH_REDIS_REST_URL']
	const token = process.env['UPSTASH_REDIS_REST_TOKEN']
	if (!url || !token) return null
	return new UpstashRateLimitStore({ url, token })
}
