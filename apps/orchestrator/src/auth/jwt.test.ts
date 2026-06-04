/**
 * Tests for jwt.
 *
 * @author asigdel29
 */

import { describe, expect, it } from 'vitest'
import { JwtVerificationError, signSession, verifySession } from './jwt.js'

const SECRET = 'sek_orchestrator_test'

function claims(overrides: Partial<Parameters<typeof signSession>[0]> = {}) {
	return {
		sub: 'u_alice',
		iat: 1700000000,
		exp: 1700000000 + 3600,
		sid: 'sess_abc',
		...overrides,
	}
}

describe('JWT session', () => {
	it('round-trips a signed token', () => {
		const token = signSession(claims(), SECRET)
		const verified = verifySession(token, SECRET, claims().iat + 10)
		expect(verified.sub).toBe('u_alice')
		expect(verified.sid).toBe('sess_abc')
	})

	it('rejects a token signed with a different secret', () => {
		const token = signSession(claims(), SECRET)
		expect(() => verifySession(token, 'other_secret', claims().iat + 10)).toThrow(
			JwtVerificationError
		)
	})

	it('rejects an expired token', () => {
		const token = signSession(claims(), SECRET)
		const afterExpiry = claims().exp + 1
		expect(() => verifySession(token, SECRET, afterExpiry)).toThrow(
			expect.objectContaining({ reason: 'expired' })
		)
	})

	it('rejects a malformed token', () => {
		expect(() => verifySession('not.a.jwt.extra', SECRET, 0)).toThrow(JwtVerificationError)
		expect(() => verifySession('not_a_jwt', SECRET, 0)).toThrow(JwtVerificationError)
	})

	it('rejects a tampered payload (signature no longer matches)', () => {
		const token = signSession(claims(), SECRET)
		const parts = token.split('.')
		// Forge a payload with a different `sub` while keeping the original sig.
		const forgedPayload = Buffer.from(JSON.stringify(claims({ sub: 'u_attacker' })), 'utf8')
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '')
		const tampered = `${parts[0]}.${forgedPayload}.${parts[2]}`
		expect(() => verifySession(tampered, SECRET, claims().iat + 10)).toThrow(
			expect.objectContaining({ reason: 'bad_signature' })
		)
	})

	it('rejects an alg-confusion attack (alg=none)', () => {
		const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8')
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '')
		const payload = Buffer.from(JSON.stringify(claims()), 'utf8')
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '')
		const token = `${header}.${payload}.`
		expect(() => verifySession(token, SECRET, claims().iat + 10)).toThrow(JwtVerificationError)
	})
})
