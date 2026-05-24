/**
 * Ephemeral SSE tokens — short-lived, single-use, room-scoped.
 *
 * The SSE route at /api/sync/:room runs over EventSource, which cannot
 * set Authorization headers — clients have to pass the bearer in the
 * URL query string. Long-lived session JWTs in URLs leak through CDN
 * logs, Vercel access logs, Referer headers, and browser history.
 *
 * The mitigation: the client mints a 60-second token via a normal POST
 * (Authorization: Bearer <session>) and uses it once on the SSE URL.
 * Even if the URL is logged, the token is dead by the time any human
 * sees the log.
 *
 * Mechanism: HMAC-SHA256 over (sub, room_id, exp, nonce). Server-side
 * "used" tracking is in-memory + bounded (we accept the rare double-
 * use under instance restart; the worst case is one extra second of
 * SSE access). For production hardening, a Redis-backed nonce store
 * survives restarts.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const DEFAULT_TTL_SECONDS = 60
const SSE_TOKEN_VERSION = 'sse1'

export interface SseTokenClaims {
	readonly sub: string
	readonly room_id: string
	readonly exp: number // unix seconds
	readonly nonce: string
}

export class SseTokenError extends Error {
	constructor(
		public readonly reason:
			| 'malformed'
			| 'wrong_version'
			| 'bad_signature'
			| 'expired'
			| 'wrong_room'
			| 'replayed'
	) {
		super(`SSE token rejected: ${reason}`)
		this.name = 'SseTokenError'
	}
}

export interface MintInput {
	readonly sub: string
	readonly room_id: string
	readonly secret: string
	readonly ttlSeconds?: number
	readonly nowSeconds?: number
}

export function mintSseToken(input: MintInput): string {
	const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
	const exp = now + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS)
	const nonce = randomBytes(12).toString('hex')
	const claims = `${SSE_TOKEN_VERSION}.${input.sub}.${input.room_id}.${exp}.${nonce}`
	const sig = createHmac('sha256', input.secret).update(claims).digest('hex')
	return `${claims}.${sig}`
}

/**
 * Bounded in-memory nonce store. Holds up to N nonces; evicts FIFO.
 * Same-instance reuse is rejected; cross-instance reuse falls back to
 * the TTL window (best-effort under multi-Lambda).
 */
export class NonceCache {
	private readonly seen = new Set<string>()
	private readonly fifo: string[] = []
	constructor(private readonly capacity = 10_000) {}

	claim(nonce: string): boolean {
		if (this.seen.has(nonce)) return false
		this.seen.add(nonce)
		this.fifo.push(nonce)
		if (this.fifo.length > this.capacity) {
			const evicted = this.fifo.shift()
			if (evicted) this.seen.delete(evicted)
		}
		return true
	}
}

export interface VerifyInput {
	readonly token: string
	readonly room_id: string
	readonly secret: string
	readonly nonceCache: NonceCache
	readonly nowSeconds?: number
}

/**
 * Signature + expiry + scope check ONLY. Does NOT touch the nonce
 * cache. Callers MUST call `claimSseTokenNonce(claims.nonce, cache)`
 * after the protected resource is successfully constructed; otherwise
 * a transient infra failure burns a one-shot token and confuses
 * legitimate retries with replays.
 */
export function verifySseTokenSignatureAndScope(input: {
	readonly token: string
	readonly room_id: string
	readonly secret: string
	readonly nowSeconds?: number
}): SseTokenClaims {
	const parts = input.token.split('.')
	if (parts.length !== 6) throw new SseTokenError('malformed')
	const [version, sub, room_id, expStr, nonce, sig] = parts as [
		string,
		string,
		string,
		string,
		string,
		string,
	]
	if (version !== SSE_TOKEN_VERSION) throw new SseTokenError('wrong_version')
	const exp = Number.parseInt(expStr, 10)
	if (!Number.isFinite(exp)) throw new SseTokenError('malformed')
	// Constant-time-style hex check: Buffer.from silently truncates on
	// invalid hex, which the length+timingSafeEqual gate would catch, but
	// validating up front avoids constructing the buffer at all on garbage.
	if (!/^[0-9a-f]+$/.test(sig)) throw new SseTokenError('malformed')

	const claims = `${version}.${sub}.${room_id}.${exp}.${nonce}`
	const expected = createHmac('sha256', input.secret).update(claims).digest('hex')
	const provided = Buffer.from(sig, 'hex')
	const expectedBuf = Buffer.from(expected, 'hex')
	if (
		provided.length !== expectedBuf.length ||
		!timingSafeEqual(provided, expectedBuf)
	) {
		throw new SseTokenError('bad_signature')
	}

	const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
	if (now >= exp) throw new SseTokenError('expired')

	if (room_id !== input.room_id) throw new SseTokenError('wrong_room')

	return { sub, room_id, exp, nonce }
}

/** Claim the nonce. Returns true if accepted, false if already used. */
export function claimSseTokenNonce(nonce: string, cache: NonceCache): boolean {
	return cache.claim(nonce)
}

/**
 * One-shot verify-and-claim. Convenience for callers that don't need
 * the two-phase ordering (e.g. tests, or routes where the resource is
 * pure-compute and can't fail). Production SSE routes should prefer
 * verifySseTokenSignatureAndScope + claimSseTokenNonce explicitly so a
 * post-verify failure doesn't burn the nonce.
 */
export function verifySseToken(input: VerifyInput): SseTokenClaims {
	const claims = verifySseTokenSignatureAndScope(input)
	if (!claimSseTokenNonce(claims.nonce, input.nonceCache)) {
		throw new SseTokenError('replayed')
	}
	return claims
}
