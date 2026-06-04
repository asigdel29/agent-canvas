/**
 * withRateLimit — wraps a route handler with a fixed-window check.
 *
 * Contract:
 *   - The caller chooses the bucket key. Common shapes:
 *       `mint-token:${user_id}`
 *       `start-run:${user_id}`
 *       `oauth-callback:${ip}`
 *     The store namespaces by key prefix internally; callers do not.
 *   - On allowed=true: invoke the wrapped handler. Attach the four
 *     standard headers (Limit, Remaining, Reset, Policy) to its
 *     response so well-behaved clients can self-pace.
 *   - On allowed=false: short-circuit with 429 and an explanatory
 *     JSON body. Retry-After is set to the seconds until reset; the
 *     same four headers are attached.
 *
 * Header set follows the IETF "RateLimit" draft (the X-RateLimit-*
 * family is the convention every public API has shipped for years).
 * @author asigdel29
 */

import type { RateLimitStore } from './rateLimitStore.js'

export interface RateLimitOptions {
	readonly store: RateLimitStore
	readonly key: string
	readonly limit: number
	readonly windowSec: number
	/** Optional override for the 429 response body. */
	readonly blockedBody?: () => Record<string, unknown>
}

/** Attach the rate-limit headers to a Response (mutates by clone). */
function attachHeaders(
	res: Response,
	opts: { limit: number; remaining: number; resetAtMs: number; windowSec: number }
): Response {
	const headers = new Headers(res.headers)
	headers.set('X-RateLimit-Limit', String(opts.limit))
	headers.set('X-RateLimit-Remaining', String(opts.remaining))
	headers.set('X-RateLimit-Reset', String(Math.floor(opts.resetAtMs / 1000)))
	headers.set('X-RateLimit-Policy', `${opts.limit};w=${opts.windowSec}`)
	return new Response(res.body, { status: res.status, headers })
}

export async function withRateLimit(
	opts: RateLimitOptions,
	handler: () => Promise<Response>
): Promise<Response> {
	const result = await opts.store.consume(opts.key, opts.limit, opts.windowSec)
	if (!result.allowed) {
		const retryAfter = Math.max(1, Math.ceil((result.reset_at_ms - Date.now()) / 1000))
		const body = opts.blockedBody?.() ?? {
			error: 'rate_limited',
			detail: 'request rate exceeded; retry after the window resets',
			retry_after_sec: retryAfter,
		}
		const res = new Response(JSON.stringify(body), {
			status: 429,
			headers: {
				'content-type': 'application/json',
				'retry-after': String(retryAfter),
			},
		})
		return attachHeaders(res, {
			limit: result.limit,
			remaining: 0,
			resetAtMs: result.reset_at_ms,
			windowSec: opts.windowSec,
		})
	}
	const res = await handler()
	return attachHeaders(res, {
		limit: result.limit,
		remaining: result.remaining,
		resetAtMs: result.reset_at_ms,
		windowSec: opts.windowSec,
	})
}

/**
 * Best-effort IP extraction for anonymous bucket keys (OAuth start,
 * unauth POST surfaces). Vercel sets x-forwarded-for; the first hop
 * is the client. Falls back to a constant when missing so a misconfig
 * doesn't dump every request into the same anonymous bucket.
 */
export function extractClientIp(req: Request): string {
	const xff = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip')
	if (xff) {
		const first = xff.split(',')[0]?.trim()
		if (first) return first
	}
	return 'unknown'
}
