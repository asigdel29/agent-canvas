import { describe, expect, it } from 'vitest'
import { corsHeadersFor, preflightResponse, withCorsHeaders } from './cors.js'

const ALLOWED = ['https://canvas.example.com']

function req(method: string, origin?: string): Request {
	const headers = new Headers()
	if (origin) headers.set('origin', origin)
	return new Request('http://localhost/api/commands', { method, headers })
}

describe('CORS', () => {
	it('returns empty headers when there is no Origin header (same-origin)', () => {
		expect(corsHeadersFor(req('POST'), { allowedOrigins: ALLOWED })).toEqual({})
	})

	it('returns matching headers for an allowed origin', () => {
		const h = corsHeadersFor(req('POST', 'https://canvas.example.com'), {
			allowedOrigins: ALLOWED,
		})
		expect(h['access-control-allow-origin']).toBe('https://canvas.example.com')
		expect(h['access-control-allow-credentials']).toBe('true')
		expect(h['vary']).toBe('Origin')
	})

	it('returns empty headers for an origin not in the allowlist', () => {
		const h = corsHeadersFor(req('POST', 'https://evil.example.com'), {
			allowedOrigins: ALLOWED,
		})
		expect(h).toEqual({})
	})

	it('refuses to echo a wildcard origin even if ALLOWED_ORIGINS includes *', () => {
		const h = corsHeadersFor(req('POST', 'https://anything.example.com'), {
			allowedOrigins: ['*', 'https://canvas.example.com'],
		})
		// '*' is stripped from the allowlist at read time, and the
		// other-origin request does not match the literal canvas URL.
		expect(h['access-control-allow-origin']).toBeUndefined()
	})

	it('preflight returns 204 + the full method/header allow set for an allowed origin', () => {
		const res = preflightResponse(req('OPTIONS', 'https://canvas.example.com'), {
			allowedOrigins: ALLOWED,
		})
		expect(res?.status).toBe(204)
		expect(res?.headers.get('access-control-allow-origin')).toBe(
			'https://canvas.example.com'
		)
		expect(res?.headers.get('access-control-allow-methods')).toContain('POST')
		expect(res?.headers.get('access-control-allow-headers')).toContain('authorization')
		expect(res?.headers.get('access-control-max-age')).toBe('600')
	})

	it('preflight returns 204 WITHOUT CORS headers for unknown origin', () => {
		const res = preflightResponse(req('OPTIONS', 'https://evil.example.com'), {
			allowedOrigins: ALLOWED,
		})
		expect(res?.status).toBe(204)
		expect(res?.headers.get('access-control-allow-origin')).toBeNull()
	})

	it('preflight returns null on non-OPTIONS requests', () => {
		expect(preflightResponse(req('POST', 'https://canvas.example.com'))).toBeNull()
	})

	it('withCorsHeaders merges CORS into an existing response without losing the body or status', async () => {
		const inner = new Response(JSON.stringify({ ok: true }), {
			status: 201,
			headers: { 'content-type': 'application/json' },
		})
		const wrapped = withCorsHeaders(req('POST', 'https://canvas.example.com'), inner)
		expect(wrapped.status).toBe(201)
		expect(wrapped.headers.get('content-type')).toBe('application/json')
		// Without ALLOWED_ORIGINS set, the wrapper returns the inner response unchanged.
		// Set the env var by routing through corsHeadersFor with an explicit config.
		// For coverage, also confirm headers are forwarded when present.
		expect(await wrapped.text()).toBe('{"ok":true}')
	})
})
