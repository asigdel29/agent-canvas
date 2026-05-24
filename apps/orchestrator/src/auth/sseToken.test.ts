import { describe, expect, it } from 'vitest'
import {
	mintSseToken,
	NonceCache,
	SseTokenError,
	verifySseToken,
} from './sseToken.js'

const SECRET = 'sse_secret_test'

describe('SSE token mint + verify', () => {
	it('round-trips a fresh token', () => {
		const cache = new NonceCache()
		const token = mintSseToken({ sub: 'u_anu', room_id: 'room_a', secret: SECRET })
		const claims = verifySseToken({
			token,
			room_id: 'room_a',
			secret: SECRET,
			nonceCache: cache,
		})
		expect(claims.sub).toBe('u_anu')
		expect(claims.room_id).toBe('room_a')
	})

	it('rejects a token verified against the wrong room', () => {
		const cache = new NonceCache()
		const token = mintSseToken({ sub: 'u_anu', room_id: 'room_a', secret: SECRET })
		expect(() =>
			verifySseToken({ token, room_id: 'room_other', secret: SECRET, nonceCache: cache })
		).toThrow(SseTokenError)
	})

	it('rejects a token signed with the wrong secret', () => {
		const cache = new NonceCache()
		const token = mintSseToken({ sub: 'u_anu', room_id: 'room_a', secret: SECRET })
		expect(() =>
			verifySseToken({ token, room_id: 'room_a', secret: 'other', nonceCache: cache })
		).toThrow(expect.objectContaining({ reason: 'bad_signature' }))
	})

	it('rejects an expired token', () => {
		const cache = new NonceCache()
		const token = mintSseToken({
			sub: 'u_anu',
			room_id: 'room_a',
			secret: SECRET,
			ttlSeconds: 60,
			nowSeconds: 1_700_000_000,
		})
		expect(() =>
			verifySseToken({
				token,
				room_id: 'room_a',
				secret: SECRET,
				nonceCache: cache,
				nowSeconds: 1_700_000_999,
			})
		).toThrow(expect.objectContaining({ reason: 'expired' }))
	})

	it('rejects a replayed token (same nonce twice on the same instance)', () => {
		const cache = new NonceCache()
		const token = mintSseToken({ sub: 'u_anu', room_id: 'room_a', secret: SECRET })
		const first = verifySseToken({
			token,
			room_id: 'room_a',
			secret: SECRET,
			nonceCache: cache,
		})
		expect(first.sub).toBe('u_anu')
		expect(() =>
			verifySseToken({ token, room_id: 'room_a', secret: SECRET, nonceCache: cache })
		).toThrow(expect.objectContaining({ reason: 'replayed' }))
	})

	it('rejects a tampered token (forged sub)', () => {
		const cache = new NonceCache()
		const token = mintSseToken({ sub: 'u_anu', room_id: 'room_a', secret: SECRET })
		const parts = token.split('.')
		parts[1] = 'u_attacker'
		const tampered = parts.join('.')
		expect(() =>
			verifySseToken({ token: tampered, room_id: 'room_a', secret: SECRET, nonceCache: cache })
		).toThrow(expect.objectContaining({ reason: 'bad_signature' }))
	})

	it('rejects a malformed token shape', () => {
		const cache = new NonceCache()
		expect(() =>
			verifySseToken({ token: 'not.enough.parts', room_id: 'room_a', secret: SECRET, nonceCache: cache })
		).toThrow(expect.objectContaining({ reason: 'malformed' }))
	})

	it('rejects a token of a future version (forward-compat guard)', () => {
		const cache = new NonceCache()
		const token = mintSseToken({ sub: 'u_anu', room_id: 'room_a', secret: SECRET })
		const wrongVersion = 'sse99' + token.slice(4)
		expect(() =>
			verifySseToken({ token: wrongVersion, room_id: 'room_a', secret: SECRET, nonceCache: cache })
		).toThrow(SseTokenError)
	})

	it('NonceCache evicts oldest beyond capacity', () => {
		const cache = new NonceCache(3)
		expect(cache.claim('a')).toBe(true)
		expect(cache.claim('b')).toBe(true)
		expect(cache.claim('c')).toBe(true)
		// 'b' and 'c' still cached at this point.
		expect(cache.claim('b')).toBe(false)
		expect(cache.claim('c')).toBe(false)
		// Filling past capacity evicts 'a' — re-claiming it succeeds.
		expect(cache.claim('d')).toBe(true) // fifo=[a,b,c,d] → evicts 'a'; cache holds {b,c,d}
		expect(cache.claim('a')).toBe(true) // 'a' was evicted, accepted again
	})
})
