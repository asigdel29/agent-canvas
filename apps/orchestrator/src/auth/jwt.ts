/**
 * Tiny HS256 JWT — sign and verify session tokens without an external
 * dependency.
 *
 * The session token carries:
 *   sub  the UserId
 *   iat  issued-at (unix seconds)
 *   exp  expiry    (unix seconds)
 *   sid  session id (for revocation; opaque)
 *
 * SECRET comes from JWT_SECRET. Rotate by re-issuing tokens; old
 * tokens fail verification once the secret changes.
 *
 * This is not a general-purpose JWT library — only the subset the
 * orchestrator needs.
 * @author asigdel29
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SessionClaims {
	readonly sub: string
	readonly iat: number
	readonly exp: number
	/** Session id — opaque, kept for legacy callers. */
	readonly sid?: string
	/**
	 * The workspace this session is currently scoped to. Carried in
	 * the JWT so every workspace-scoped route can authorize without
	 * an extra DB lookup. Set by the GitHub OAuth callback; the
	 * workspace switcher (P1, follow-up) re-mints the JWT with a
	 * different workspace_id when the user picks another one.
	 */
	readonly workspace_id?: string
	/**
	 * Set when this session was minted by redeeming a share link
	 * (POST /api/share/redeem) rather than a login. `share_link_id`
	 * identifies the originating link; `share_role` is the granted
	 * access level. These are informational — the real gate is the
	 * synthetic principal's workspace_members row, which revocation
	 * removes — so the client can switch to read-only without trusting
	 * an unsigned source.
	 */
	readonly share_link_id?: string
	readonly share_role?: 'viewer' | 'member'
}

export class JwtVerificationError extends Error {
	constructor(public readonly reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_alg') {
		super(`JWT verification failed: ${reason}`)
		this.name = 'JwtVerificationError'
	}
}

export function signSession(claims: SessionClaims, secret: string): string {
	const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
	const payload = base64url(JSON.stringify(claims))
	const data = `${header}.${payload}`
	const signature = createHmac('sha256', secret).update(data).digest()
	return `${data}.${base64urlBuf(signature)}`
}

export function verifySession(token: string, secret: string, nowSeconds: number = Math.floor(Date.now() / 1000)): SessionClaims {
	const parts = token.split('.')
	if (parts.length !== 3) throw new JwtVerificationError('malformed')
	const [headerB64, payloadB64, sigB64] = parts as [string, string, string]

	let header: { alg?: string; typ?: string }
	try {
		header = JSON.parse(b64urlDecode(headerB64).toString('utf8')) as { alg?: string; typ?: string }
	} catch {
		throw new JwtVerificationError('malformed')
	}
	if (header.alg !== 'HS256') throw new JwtVerificationError('wrong_alg')

	const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest()
	let provided: Buffer
	try {
		provided = b64urlDecode(sigB64)
	} catch {
		throw new JwtVerificationError('malformed')
	}
	if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
		throw new JwtVerificationError('bad_signature')
	}

	let payload: SessionClaims
	try {
		payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) as SessionClaims
	} catch {
		throw new JwtVerificationError('malformed')
	}
	if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
		throw new JwtVerificationError('malformed')
	}
	if (nowSeconds >= payload.exp) throw new JwtVerificationError('expired')
	return payload
}

function base64url(s: string): string {
	return base64urlBuf(Buffer.from(s, 'utf8'))
}

function base64urlBuf(b: Buffer): string {
	return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Buffer {
	const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
	const std = s.replace(/-/g, '+').replace(/_/g, '/') + pad
	return Buffer.from(std, 'base64')
}
