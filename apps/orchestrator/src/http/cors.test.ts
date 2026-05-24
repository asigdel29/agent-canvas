import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { corsHeadersFor, preflightResponse, readCorsConfig, withCorsHeaders } from './cors.js'

const ALLOWED = ['https://canvas.example.com']

function req(method: string, origin?: string): Request {
	const headers = new Headers()
	if (origin) headers.set('origin', origin)
	return new Request('http://localhost/api/commands', { method, headers })
}

describe('CORS', () => {
	it('emits only Vary: Origin when there is no Origin header (same-origin)', () => {
		// Vary must fire on every endpoint that may vary by origin so a
		// shared cache cannot serve a response cached for origin A back
		// to origin B.
		expect(corsHeadersFor(req('POST'), { allowedOrigins: ALLOWED })).toEqual({
			vary: 'Origin',
		})
	})

	it('returns matching headers for an allowed origin', () => {
		const h = corsHeadersFor(req('POST', 'https://canvas.example.com'), {
			allowedOrigins: ALLOWED,
		})
		expect(h['access-control-allow-origin']).toBe('https://canvas.example.com')
		expect(h['access-control-allow-credentials']).toBe('true')
		expect(h['vary']).toBe('Origin')
	})

	it('emits only Vary: Origin (no allow-origin) for an origin not in the allowlist', () => {
		const h = corsHeadersFor(req('POST', 'https://evil.example.com'), {
			allowedOrigins: ALLOWED,
		})
		expect(h).toEqual({ vary: 'Origin' })
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
		expect(wrapped.headers.get('vary')).toBe('Origin')
		expect(await wrapped.text()).toBe('{"ok":true}')
	})

	describe('readCorsConfig', () => {
		const original = process.env['ALLOWED_ORIGINS']
		beforeEach(() => {
			delete process.env['ALLOWED_ORIGINS']
		})
		afterEach(() => {
			if (original === undefined) delete process.env['ALLOWED_ORIGINS']
			else process.env['ALLOWED_ORIGINS'] = original
		})

		it('strips wildcard "*" silently', () => {
			process.env['ALLOWED_ORIGINS'] = '*,https://canvas.example.com'
			expect(readCorsConfig().allowedOrigins).toEqual(['https://canvas.example.com'])
		})

		it('rejects the literal string "null" (sandboxed iframe / file://)', () => {
			process.env['ALLOWED_ORIGINS'] = 'null,https://canvas.example.com'
			expect(readCorsConfig().allowedOrigins).toEqual(['https://canvas.example.com'])
		})

		it('strips trailing slashes and paths so entries match the browser Origin form', () => {
			process.env['ALLOWED_ORIGINS'] = 'https://canvas.example.com/,https://other.example.com/app'
			expect(readCorsConfig().allowedOrigins).toEqual([
				'https://canvas.example.com',
				'https://other.example.com',
			])
		})

		it('rejects http:// for non-localhost origins', () => {
			process.env['ALLOWED_ORIGINS'] =
				'http://evil.example.com,http://localhost:5173,https://canvas.example.com'
			expect(readCorsConfig().allowedOrigins).toEqual([
				'http://localhost:5173',
				'https://canvas.example.com',
			])
		})

		it('rejects non-URL garbage entries', () => {
			process.env['ALLOWED_ORIGINS'] = 'not-a-url,javascript:alert(1),https://canvas.example.com'
			expect(readCorsConfig().allowedOrigins).toEqual(['https://canvas.example.com'])
		})
	})
})
