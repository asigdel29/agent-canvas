import { describe, expect, it } from 'vitest'
import {
	InMemoryNonceStore,
	mintSseToken,
	SseTokenError,
	verifySseToken,
	verifySseTokenSignatureAndScope,
	claimSseTokenNonce,
} from './sseToken.js'

const SECRET = 'sse_secret_test'

function freshStore(): InMemoryNonceStore {
	return new InMemoryNonceStore()
}

describe('SSE token mint + verify', () => {
	it('round-trips a fresh token', async () => {
		const store = freshStore()
		const token = mintSseToken({ sub: 'u_anu', room_id: 'room_a', secret: SECRET })
		const claims = await verifySseToken({
			token,
			room_id: 'room_a',
			secret: SECRET,
			nonceStore: store,
		})
		expect(claims.sub).toBe('u_anu')
		expect(claims.room_id).toBe('room_a')
	})

	it('rejects a token verified against the wrong room', async () => {
		const store = freshStore()
		const token = mintSseToken({ sub: 'u_anu', room_id: 'room_a', secret: SECRET })
		await expect(
			verifySseToken({ token, room_id: 'room_other', secret: SECRET, nonceStore: store })
		).rejects.toThrow(SseTokenError)
	})

	it('rejects a token signed with the wrong secret', async () => {
		const store = freshStore()
		const token = mintSseToken({ sub: 'u_anu', room_id: 'room_a', secret: SECRET })
		await expect(
			verifySseToken({ token, room_id: 'room_a', secret: 'other', nonceStore: store })
		).rejects.toThrow(expect.objectContaining({ reason: 'bad_signature' }))
	})

	it('rejects an expired token', async () => {
		const store = freshStore()
		const token = mintSseToken({
			sub: 'u_anu',
			room_id: 'room_a',
			secret: SECRET,
			ttlSeconds: 60,
			nowSeconds: 1_700_000_000,
		})
		await expect(
			verifySseToken({
				token,
				room_id: 'room_a',
				secret: SECRET,
				nonceStore: store,
				nowSeconds: 1_700_000_999,
			})
		).rejects.toThrow(expect.objectContaining({ reason: 'expired' }))
	})

	it('rejects a replayed token (same nonce twice on the same instance)', async () => {
		const store = freshStore()
		const token = mintSseToken({ sub: 'u_anu', room_id: 'room_a', secret: SECRET })
		const first = await verifySseToken({
			token,
			room_id: 'room_a',
			secret: SECRET,
			nonceStore: store,
		})
		expect(first.sub).toBe('u_anu')
		await expect(
			verifySseToken({ token, room_id: 'room_a', secret: SECRET, nonceStore: store })
		).rejects.toThrow(expect.objectContaining({ reason: 'replayed' }))
	})

	it('rejects a tampered token (forged sub)', async () => {
		const store = freshStore()
		const token = mintSseToken({ sub: 'u_anu', room_id: 'room_a', secret: SECRET })
		const parts = token.split('.')
		parts[1] = 'u_attacker'
		const tampered = parts.join('.')
		await expect(
			verifySseToken({ token: tampered, room_id: 'room_a', secret: SECRET, nonceStore: store })
		).rejects.toThrow(expect.objectContaining({ reason: 'bad_signature' }))
	})

	it('rejects a malformed token shape', async () => {
		const store = freshStore()
		await expect(
			verifySseToken({
				token: 'not.enough.parts',
				room_id: 'room_a',
				secret: SECRET,
				nonceStore: store,
			})
		).rejects.toThrow(expect.objectContaining({ reason: 'malformed' }))
	})

	it('rejects a token of a future version (forward-compat guard)', async () => {
		const store = freshStore()
		const token = mintSseToken({ sub: 'u_anu', room_id: 'room_a', secret: SECRET })
		const wrongVersion = 'sse99' + token.slice(4)
		await expect(
			verifySseToken({
				token: wrongVersion,
				room_id: 'room_a',
				secret: SECRET,
				nonceStore: store,
			})
		).rejects.toThrow(SseTokenError)
	})

	it('InMemoryNonceStore evicts oldest beyond capacity (sync test helper)', () => {
		const store = new InMemoryNonceStore(3)
		expect(store.claimSync('a')).toBe(true)
		expect(store.claimSync('b')).toBe(true)
		expect(store.claimSync('c')).toBe(true)
		// 'b' and 'c' still cached at this point.
		expect(store.claimSync('b')).toBe(false)
		expect(store.claimSync('c')).toBe(false)
		// Filling past capacity evicts 'a' — re-claiming it succeeds.
		expect(store.claimSync('d')).toBe(true) // fifo=[a,b,c,d] → evicts 'a'; cache holds {b,c,d}
		expect(store.claimSync('a')).toBe(true) // 'a' was evicted, accepted again
	})

	it('InMemoryNonceStore async claim has the same semantics', async () => {
		const store = new InMemoryNonceStore(2)
		expect(await store.claim('x', 60)).toBe(true)
		expect(await store.claim('x', 60)).toBe(false) // replay
		expect(await store.claim('y', 60)).toBe(true)
		expect(await store.claim('z', 60)).toBe(true) // evicts 'x'
		expect(await store.claim('x', 60)).toBe(true) // 'x' was evicted
	})
})

describe('Two-phase verify (signature/scope + nonce-claim)', () => {
	it('signature-and-scope verify does NOT touch the nonce store', async () => {
		const store = new InMemoryNonceStore()
		const token = mintSseToken({ sub: 'u_anu', room_id: 'room_a', secret: SECRET })
		const claims = verifySseTokenSignatureAndScope({
			token,
			room_id: 'room_a',
			secret: SECRET,
		})
		expect(claims.sub).toBe('u_anu')
		// A second call with the same token still works — nonce is untouched.
		const claims2 = verifySseTokenSignatureAndScope({
			token,
			room_id: 'room_a',
			secret: SECRET,
		})
		expect(claims2.nonce).toBe(claims.nonce)
		// Only an explicit claim burns the nonce.
		expect(await claimSseTokenNonce(claims.nonce, store)).toBe(true)
		expect(await claimSseTokenNonce(claims.nonce, store)).toBe(false)
	})

	it('signature/scope rejects bad sig before any nonce side-effect', async () => {
		const store = new InMemoryNonceStore()
		expect(() =>
			verifySseTokenSignatureAndScope({
				token: 'sse1.u.r.999999999.aaaa.deadbeef',
				room_id: 'r',
				secret: SECRET,
			})
		).toThrow(expect.objectContaining({ reason: 'bad_signature' }))
		// Store is empty — no claim happened.
		expect(await store.claim('aaaa', 60)).toBe(true)
	})
})
