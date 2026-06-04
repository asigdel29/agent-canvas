/**
 * Tests for upstashNonceStore.
 *
 * @author asigdel29
 */

import { describe, expect, it, vi } from 'vitest'
import { UpstashNonceStore } from './upstashNonceStore.js'

/**
 * Fake fetch that records every request and returns a scripted result.
 * We don't hit the real Upstash REST API in tests — we verify the request
 * shape (URL, headers, NX=true, EX=<ttl>) and the response-parsing logic.
 */
function fakeFetch(scripted: Array<{ ok: boolean; status?: number; body?: unknown; throws?: Error }>): {
	fetchImpl: typeof fetch
	calls: Array<{ url: string; init?: RequestInit }>
} {
	const calls: Array<{ url: string; init?: RequestInit }> = []
	let i = 0
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : ''
		calls.push({ url, init })
		const next = scripted[i++]
		if (!next) throw new Error('fakeFetch: script exhausted')
		if (next.throws) throw next.throws
		return {
			ok: next.ok,
			status: next.status ?? (next.ok ? 200 : 500),
			json: async () => next.body,
		} as unknown as Response
	}
	return { fetchImpl, calls }
}

describe('UpstashNonceStore', () => {
	it('claim sends POST /set/<key>/1?NX=true&EX=<ttl> with Bearer auth', async () => {
		const { fetchImpl, calls } = fakeFetch([{ ok: true, body: { result: 'OK' } }])
		const store = new UpstashNonceStore({
			url: 'https://example.upstash.io',
			token: 'tok_secret',
			fetchImpl,
		})
		await store.claim('nonce_abc', 120)
		expect(calls).toHaveLength(1)
		expect(calls[0]!.url).toContain('https://example.upstash.io/set/')
		expect(calls[0]!.url).toContain(encodeURIComponent('sse:nonce:nonce_abc'))
		expect(calls[0]!.url).toContain('NX=true')
		expect(calls[0]!.url).toContain('EX=120')
		const headers = new Headers(calls[0]!.init?.headers)
		expect(headers.get('authorization')).toBe('Bearer tok_secret')
		expect(calls[0]!.init?.method).toBe('POST')
	})

	it('returns true on "OK" response (first claim wins)', async () => {
		const { fetchImpl } = fakeFetch([{ ok: true, body: { result: 'OK' } }])
		const store = new UpstashNonceStore({ url: 'https://x', token: 't', fetchImpl })
		expect(await store.claim('nonce_first', 60)).toBe(true)
	})

	it('returns false on null result (nonce already claimed)', async () => {
		const { fetchImpl } = fakeFetch([{ ok: true, body: { result: null } }])
		const store = new UpstashNonceStore({ url: 'https://x', token: 't', fetchImpl })
		expect(await store.claim('nonce_replayed', 60)).toBe(false)
	})

	it('returns false (fail-closed) when Upstash returns 5xx', async () => {
		const errs: Error[] = []
		const { fetchImpl } = fakeFetch([{ ok: false, status: 503 }])
		const store = new UpstashNonceStore({
			url: 'https://x',
			token: 't',
			fetchImpl,
			onError: (e) => errs.push(e),
		})
		expect(await store.claim('nonce_x', 60)).toBe(false)
		expect(errs).toHaveLength(1)
		expect(errs[0]!.message).toContain('503')
	})

	it('returns false (fail-closed) on network error', async () => {
		const errs: Error[] = []
		const { fetchImpl } = fakeFetch([{ ok: false, throws: new Error('ECONNREFUSED') }])
		const store = new UpstashNonceStore({
			url: 'https://x',
			token: 't',
			fetchImpl,
			onError: (e) => errs.push(e),
		})
		expect(await store.claim('nonce_y', 60)).toBe(false)
		expect(errs[0]!.message).toBe('ECONNREFUSED')
	})

	it('strips trailing slashes from the configured URL', async () => {
		const { fetchImpl, calls } = fakeFetch([{ ok: true, body: { result: 'OK' } }])
		const store = new UpstashNonceStore({
			url: 'https://x.upstash.io///',
			token: 't',
			fetchImpl,
		})
		await store.claim('n', 60)
		expect(calls[0]!.url.startsWith('https://x.upstash.io/set/')).toBe(true)
		// no triple-slash in the path
		expect(calls[0]!.url).not.toContain('.io///set')
	})

	it('uses URL-encoded keys (handles odd nonces safely)', async () => {
		const { fetchImpl, calls } = fakeFetch([{ ok: true, body: { result: 'OK' } }])
		const store = new UpstashNonceStore({ url: 'https://x', token: 't', fetchImpl })
		await store.claim('nonce with spaces / and slash', 60)
		expect(calls[0]!.url).toContain(
			encodeURIComponent('sse:nonce:nonce with spaces / and slash')
		)
	})

	it('passes ttlSeconds verbatim (callers control TTL)', async () => {
		const { fetchImpl, calls } = fakeFetch([
			{ ok: true, body: { result: 'OK' } },
			{ ok: true, body: { result: 'OK' } },
		])
		const store = new UpstashNonceStore({ url: 'https://x', token: 't', fetchImpl })
		await store.claim('a', 60)
		await store.claim('b', 600)
		expect(calls[0]!.url).toContain('EX=60')
		expect(calls[1]!.url).toContain('EX=600')
	})

	it('default onError logs via console.warn without throwing', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const { fetchImpl } = fakeFetch([{ ok: false, throws: new Error('boom') }])
		const store = new UpstashNonceStore({ url: 'https://x', token: 't', fetchImpl })
		expect(await store.claim('n', 60)).toBe(false)
		expect(warnSpy).toHaveBeenCalled()
		warnSpy.mockRestore()
	})
})
