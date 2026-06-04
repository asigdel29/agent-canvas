/**
 * Tests for rateLimitStore.
 *
 * @author asigdel29
 */

import { describe, expect, it, vi } from 'vitest'
import {
	InMemoryRateLimitStore,
	UpstashRateLimitStore,
	type RateLimitStore,
} from './rateLimitStore.js'
import { withRateLimit } from './withRateLimit.js'

describe('InMemoryRateLimitStore', () => {
	it('allows the first N requests and blocks the (N+1)th', async () => {
		const s = new InMemoryRateLimitStore()
		for (let i = 0; i < 3; i++) {
			const r = await s.consume('k', 3, 60)
			expect(r.allowed).toBe(true)
			expect(r.remaining).toBe(2 - i)
		}
		const blocked = await s.consume('k', 3, 60)
		expect(blocked.allowed).toBe(false)
		expect(blocked.remaining).toBe(0)
	})

	it('decrements remaining linearly', async () => {
		const s = new InMemoryRateLimitStore()
		const a = await s.consume('k', 5, 60)
		const b = await s.consume('k', 5, 60)
		expect(a.remaining).toBe(4)
		expect(b.remaining).toBe(3)
	})

	it('separates buckets by key', async () => {
		const s = new InMemoryRateLimitStore()
		for (let i = 0; i < 2; i++) await s.consume('a', 2, 60)
		// 'a' is exhausted but 'b' has a fresh ceiling.
		const blockedA = await s.consume('a', 2, 60)
		const freshB = await s.consume('b', 2, 60)
		expect(blockedA.allowed).toBe(false)
		expect(freshB.allowed).toBe(true)
		expect(freshB.remaining).toBe(1)
	})

	it('reset_at_ms is the end of the fixed window', async () => {
		const s = new InMemoryRateLimitStore()
		const now = Date.now()
		const r = await s.consume('k', 1, 60)
		// Reset must be at the next minute boundary, never the past.
		expect(r.reset_at_ms).toBeGreaterThan(now)
		expect(r.reset_at_ms - now).toBeLessThanOrEqual(60_000)
	})

	it('resets the bucket when the window advances', async () => {
		const s = new InMemoryRateLimitStore()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
		for (let i = 0; i < 5; i++) await s.consume('k', 5, 1)
		expect((await s.consume('k', 5, 1)).allowed).toBe(false)
		// Advance to the next second-aligned window.
		vi.setSystemTime(new Date('2026-01-01T00:00:01Z'))
		const r = await s.consume('k', 5, 1)
		expect(r.allowed).toBe(true)
		expect(r.remaining).toBe(4)
		vi.useRealTimers()
	})

	it('garbage-collects expired buckets opportunistically', async () => {
		const s = new InMemoryRateLimitStore()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
		await s.consume('stale-1', 1, 1)
		await s.consume('stale-2', 1, 1)
		expect(s.buckets.size).toBe(2)
		// Advance past both windows; the next consume on a fresh key
		// triggers the GC sweep.
		vi.setSystemTime(new Date('2026-01-01T00:00:10Z'))
		await s.consume('fresh', 5, 60)
		// Stale entries are gone; only the fresh one remains.
		expect(s.buckets.size).toBe(1)
		vi.useRealTimers()
	})
})

describe('UpstashRateLimitStore', () => {
	function mockFetch(
		responseBody: unknown,
		opts: { ok?: boolean; status?: number } = {}
	): { fetch: typeof fetch; calls: Array<{ url: string; body: string }> } {
		const calls: Array<{ url: string; body: string }> = []
		const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({
				url: String(url),
				body: typeof init?.body === 'string' ? init.body : '',
			})
			return new Response(JSON.stringify(responseBody), {
				status: opts.status ?? 200,
				headers: { 'content-type': 'application/json' },
			})
		}) as unknown as typeof fetch
		return { fetch: fn, calls }
	}

	it('issues an INCR + EXPIRE pipeline in one round-trip', async () => {
		const { fetch, calls } = mockFetch([{ result: 1 }, { result: 1 }])
		const s = new UpstashRateLimitStore({
			url: 'https://example.upstash.io',
			token: 't',
			fetchImpl: fetch,
		})
		const r = await s.consume('k', 5, 60)
		expect(r.allowed).toBe(true)
		expect(r.remaining).toBe(4)
		expect(calls).toHaveLength(1)
		expect(calls[0]!.url).toBe('https://example.upstash.io/pipeline')
		const body = JSON.parse(calls[0]!.body) as unknown[]
		expect(body[0]).toEqual(['INCR', expect.stringMatching(/^rl:k:\d+$/)])
		expect(body[1]).toEqual(['EXPIRE', expect.stringMatching(/^rl:k:\d+$/), 60])
	})

	it('blocks when the INCR result exceeds the ceiling', async () => {
		const { fetch } = mockFetch([{ result: 6 }, { result: 1 }])
		const s = new UpstashRateLimitStore({ url: 'x', token: 't', fetchImpl: fetch })
		const r = await s.consume('k', 5, 60)
		expect(r.allowed).toBe(false)
		expect(r.remaining).toBe(0)
	})

	it('fails open on network error and reports the limit as full', async () => {
		const errs: Error[] = []
		const fn = (async () => {
			throw new Error('network down')
		}) as unknown as typeof fetch
		const s = new UpstashRateLimitStore({
			url: 'x',
			token: 't',
			fetchImpl: fn,
			onError: (e) => errs.push(e),
		})
		const r = await s.consume('k', 5, 60)
		expect(r.allowed).toBe(true)
		expect(r.remaining).toBe(5)
		expect(errs).toHaveLength(1)
		expect(errs[0]!.message).toBe('network down')
	})

	it('fails open on non-2xx response', async () => {
		const errs: Error[] = []
		const { fetch } = mockFetch({ error: 'unauthorized' }, { ok: false, status: 401 })
		const s = new UpstashRateLimitStore({
			url: 'x',
			token: 't',
			fetchImpl: fetch,
			onError: (e) => errs.push(e),
		})
		const r = await s.consume('k', 5, 60)
		expect(r.allowed).toBe(true)
		expect(errs[0]!.message).toContain('HTTP 401')
	})
})

describe('withRateLimit', () => {
	function fakeStore(allowed: boolean, remaining: number, resetAtMs: number): RateLimitStore {
		return {
			consume: async () => ({
				allowed,
				limit: 5,
				remaining,
				reset_at_ms: resetAtMs,
			}),
		}
	}

	it('invokes the wrapped handler and attaches rate-limit headers when allowed', async () => {
		const store = fakeStore(true, 4, Date.now() + 60_000)
		const res = await withRateLimit(
			{ store, key: 'k', limit: 5, windowSec: 60 },
			async () => new Response('ok', { status: 200 })
		)
		expect(res.status).toBe(200)
		expect(res.headers.get('X-RateLimit-Limit')).toBe('5')
		expect(res.headers.get('X-RateLimit-Remaining')).toBe('4')
		expect(res.headers.get('X-RateLimit-Policy')).toBe('5;w=60')
		expect(await res.text()).toBe('ok')
	})

	it('short-circuits with 429 + Retry-After when blocked', async () => {
		const future = Date.now() + 30_000
		const store = fakeStore(false, 0, future)
		let handlerRan = false
		const res = await withRateLimit(
			{ store, key: 'k', limit: 5, windowSec: 60 },
			async () => {
				handlerRan = true
				return new Response('should not be reached')
			}
		)
		expect(handlerRan).toBe(false)
		expect(res.status).toBe(429)
		const retryAfter = Number(res.headers.get('retry-after'))
		expect(retryAfter).toBeGreaterThan(0)
		expect(retryAfter).toBeLessThanOrEqual(30)
		const body = (await res.json()) as { error: string; retry_after_sec: number }
		expect(body.error).toBe('rate_limited')
	})

	it('honors a custom blockedBody override', async () => {
		const store = fakeStore(false, 0, Date.now() + 1000)
		const res = await withRateLimit(
			{
				store,
				key: 'k',
				limit: 1,
				windowSec: 60,
				blockedBody: () => ({ error: 'too_many_tokens', code: 'TKN_RL' }),
			},
			async () => new Response()
		)
		const body = (await res.json()) as { error: string; code: string }
		expect(body.error).toBe('too_many_tokens')
		expect(body.code).toBe('TKN_RL')
	})
})
