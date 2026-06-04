import { describe, expect, it } from 'vitest'
import { signSession } from './jwt.js'
import { extractSession } from './session.js'

const SECRET = 'sek_session_test'

function reqWith(authHeader: string | null): Request {
	const headers = new Headers()
	if (authHeader) headers.set('authorization', authHeader)
	return new Request('http://localhost/api/commands', { method: 'POST', headers })
}

describe('extractSession', () => {
	it('returns null when no Authorization header is present', () => {
		expect(extractSession(reqWith(null), SECRET)).toBeNull()
	})

	it('returns null when the header is not bearer scheme', () => {
		expect(extractSession(reqWith('Basic dXNlcjpwYXNz'), SECRET)).toBeNull()
	})

	it('returns the claims for a valid bearer token', () => {
		const token = signSession(
			{ sub: 'u_alice', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60, sid: 's1' },
			SECRET
		)
		const claims = extractSession(reqWith(`Bearer ${token}`), SECRET)
		expect(claims?.sub).toBe('u_alice')
	})

	it('returns null when the token signature is wrong', () => {
		const token = signSession(
			{ sub: 'u_alice', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60, sid: 's1' },
			'different_secret'
		)
		expect(extractSession(reqWith(`Bearer ${token}`), SECRET)).toBeNull()
	})

	it('accepts the case-insensitive bearer keyword', () => {
		const token = signSession(
			{ sub: 'u_alice', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60, sid: 's1' },
			SECRET
		)
		expect(extractSession(reqWith(`bearer ${token}`), SECRET)?.sub).toBe('u_alice')
		expect(extractSession(reqWith(`BEARER ${token}`), SECRET)?.sub).toBe('u_alice')
	})
})
