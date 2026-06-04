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
 * Mechanism: HMAC-SHA256 over (sub, room_id, exp, nonce). The nonce
 * store is pluggable: production uses Upstash Redis (atomic SET NX EX
 * across all serverless instances); dev uses an in-memory FIFO. Both
 * implement `NonceStore`. See `runtime.ts` for selection.
 * @author asigdel29
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
 * Atomic single-use nonce store. `claim(nonce)` returns true if the
 * nonce was unused (and is now claimed), false if it was already seen.
 *
 * Implementations:
 *   - InMemoryNonceStore — FIFO-bounded, per-instance. Dev / single-
 *     process deployments.
 *   - UpstashNonceStore — `SET nonce NX EX <ttl>`, atomic across all
 *     serverless function instances. Production.
 *
 * Production note: with horizontal scale and a per-instance store, two
 * concurrent requests with the same captured token landing on different
 * instances can both pass `claim`. The token TTL bounds the window
 * (60s default) but a distributed store closes it entirely.
 */
export interface NonceStore {
	claim(nonce: string, ttlSeconds: number): Promise<boolean>
}

/**
 * Bounded in-memory nonce store. Holds up to N nonces; evicts FIFO.
 * Production deployments should prefer a distributed store via the
 * NonceStore interface — this class is for dev and single-instance use.
 *
 * NOTE: `capacity` must exceed peak requests-per-TTL-window. With 60s
 * TTL and 10k capacity, sustained ~167 req/s/instance starts evicting
 * still-valid nonces; that weakens the single-use property without
 * enabling replay (signature+exp still gate). Pick a Redis store for
 * any deployment where burst > 100 req/s/instance is plausible.
 */
export class InMemoryNonceStore implements NonceStore {
	private readonly seen = new Set<string>()
	private readonly fifo: string[] = []
	constructor(private readonly capacity = 10_000) {}

	// Async signature for interface conformance; the in-memory path is sync.
	// eslint-disable-next-line @typescript-eslint/require-await
	async claim(nonce: string, _ttlSeconds: number): Promise<boolean> {
		if (this.seen.has(nonce)) return false
		this.seen.add(nonce)
		this.fifo.push(nonce)
		if (this.fifo.length > this.capacity) {
			const evicted = this.fifo.shift()
			if (evicted) this.seen.delete(evicted)
		}
		return true
	}

	/** Test helper — synchronous claim with default TTL. */
	claimSync(nonce: string): boolean {
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

/**
 * @deprecated Renamed to InMemoryNonceStore. Keep as alias for the
 * single-pass migration; remove after callers update.
 */
export const NonceCache = InMemoryNonceStore
export type NonceCache = InMemoryNonceStore

export interface VerifyInput {
	readonly token: string
	readonly room_id: string
	readonly secret: string
	readonly nonceStore: NonceStore
	/** Defaults to `DEFAULT_TTL_SECONDS + 60` so a Redis nonce TTL covers the token's full lifetime plus clock-skew slack. */
	readonly nonceTtlSeconds?: number
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
export async function claimSseTokenNonce(
	nonce: string,
	store: NonceStore,
	ttlSeconds = DEFAULT_TTL_SECONDS + 60
): Promise<boolean> {
	return store.claim(nonce, ttlSeconds)
}

/**
 * One-shot verify-and-claim. Convenience for callers that don't need
 * the two-phase ordering (e.g. tests, or routes where the resource is
 * pure-compute and can't fail). Production SSE routes should prefer
 * verifySseTokenSignatureAndScope + claimSseTokenNonce explicitly so a
 * post-verify failure doesn't burn the nonce.
 */
export async function verifySseToken(input: VerifyInput): Promise<SseTokenClaims> {
	const claims = verifySseTokenSignatureAndScope(input)
	const ttl = input.nonceTtlSeconds ?? DEFAULT_TTL_SECONDS + 60
	if (!(await input.nonceStore.claim(claims.nonce, ttl))) {
		throw new SseTokenError('replayed')
	}
	return claims
}
