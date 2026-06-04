/**
 * Shared webhook-signature verification primitives.
 *
 * All comparisons run through `timingSafeEqual` to avoid leaking
 * secret bytes through response-time differences. Every verifier
 * returns `false` on any malformed input (missing header, wrong
 * length, parse error, etc.) — the alternative is throwing, which
 * the framework would surface as a 500 to attackers.
 * @author asigdel29
 */

import { createHmac, timingSafeEqual, verify as cryptoVerify } from 'node:crypto'

/**
 * HMAC-SHA256 verification with an explicit signature prefix scheme.
 *
 *   GitHub:   'sha256='   header `X-Hub-Signature-256`
 *   Vercel:   no prefix  (Vercel uses HMAC-SHA1; use verifyHmacSha1)
 *   Linear:   no prefix   header `Linear-Signature`
 *   Graphite: no prefix   header `Graphite-Signature`
 *   Railway:  no prefix   header `Railway-Signature`
 *   Supabase: no prefix   header `x-supabase-signature`
 *
 * Slack uses a different shape (`v0:{ts}:{body}`); see verifySlack.
 */
export interface VerifyHmacSha256Options {
	readonly secret: string
	readonly body: string
	readonly providedSignature: string | undefined
	readonly prefix?: string
}

export function verifyHmacSha256(opts: VerifyHmacSha256Options): boolean {
	if (!opts.providedSignature) return false
	const expectedHex = createHmac('sha256', opts.secret).update(opts.body, 'utf8').digest('hex')
	const expected = (opts.prefix ?? '') + expectedHex
	return constantTimeEquals(expected, opts.providedSignature)
}

/** HMAC-SHA1 with optional prefix. Vercel-as-integration uses this. */
export interface VerifyHmacSha1Options {
	readonly secret: string
	readonly body: string
	readonly providedSignature: string | undefined
	readonly prefix?: string
}

export function verifyHmacSha1(opts: VerifyHmacSha1Options): boolean {
	if (!opts.providedSignature) return false
	const expectedHex = createHmac('sha1', opts.secret).update(opts.body, 'utf8').digest('hex')
	const expected = (opts.prefix ?? '') + expectedHex
	return constantTimeEquals(expected, opts.providedSignature)
}

/**
 * Slack signature scheme:
 *
 *   sig_basestring = 'v0:' + ts + ':' + body
 *   expected       = 'v0=' + hex(hmac_sha256(secret, sig_basestring))
 *
 * Additionally, Slack requires that the request timestamp is within
 * five minutes of now (replay-attack defense). The caller passes
 * `now_ms` (injectable for tests).
 */
export interface VerifySlackOptions {
	readonly secret: string
	readonly body: string
	readonly timestamp: string | undefined
	readonly providedSignature: string | undefined
	readonly nowMs: number
	readonly maxAgeMs?: number
}

export function verifySlack(opts: VerifySlackOptions): boolean {
	if (!opts.providedSignature || !opts.timestamp) return false
	const tsSeconds = Number.parseInt(opts.timestamp, 10)
	if (!Number.isFinite(tsSeconds)) return false
	const maxAge = opts.maxAgeMs ?? 5 * 60 * 1000
	const skew = Math.abs(opts.nowMs - tsSeconds * 1000)
	if (skew > maxAge) return false
	const base = `v0:${opts.timestamp}:${opts.body}`
	const expected = 'v0=' + createHmac('sha256', opts.secret).update(base, 'utf8').digest('hex')
	return constantTimeEquals(expected, opts.providedSignature)
}

/**
 * Discord interaction signature: Ed25519 over `timestamp + body`,
 * verified against the application's public key.
 *
 * `publicKey` is the application's public key in hex (Discord supplies
 * it on the developer portal). `signature` is the hex-encoded Ed25519
 * signature from the `X-Signature-Ed25519` header.
 */
export interface VerifyEd25519Options {
	readonly publicKeyHex: string
	readonly body: string
	readonly timestamp: string | undefined
	readonly providedSignatureHex: string | undefined
}

export function verifyEd25519(opts: VerifyEd25519Options): boolean {
	if (!opts.providedSignatureHex || !opts.timestamp) return false
	let signature: Buffer
	let publicKey: Buffer
	try {
		signature = Buffer.from(opts.providedSignatureHex, 'hex')
		publicKey = Buffer.from(opts.publicKeyHex, 'hex')
	} catch {
		return false
	}
	if (signature.length !== 64) return false
	if (publicKey.length !== 32) return false
	const msg = Buffer.from(opts.timestamp + opts.body, 'utf8')
	const keyObject = ed25519PublicKeyObject(publicKey)
	if (keyObject === null) return false
	try {
		return cryptoVerify(null, msg, keyObject, signature)
	} catch {
		return false
	}
}

function ed25519PublicKeyObject(raw32: Buffer): ReturnType<typeof cryptoKeyImport> | null {
	// Wrap the 32-byte raw public key in DER (SubjectPublicKeyInfo for ed25519):
	//   30 2a 30 05 06 03 2b 65 70 03 21 00 <32 bytes>
	const prefix = Buffer.from([
		0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
	])
	const der = Buffer.concat([prefix, raw32])
	try {
		return cryptoKeyImport(der)
	} catch {
		return null
	}
}

// Indirection layer makes the import testable without pulling crypto into
// every file that uses these verifiers.
function cryptoKeyImport(der: Buffer): import('node:crypto').KeyObject {
	// Dynamic require keeps the test surface small and avoids ESM-vs-CJS dance.
	// node:crypto is always available on Node 22+.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { createPublicKey } = require('node:crypto') as typeof import('node:crypto')
	return createPublicKey({ key: der, format: 'der', type: 'spki' })
}

function constantTimeEquals(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	try {
		return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
	} catch {
		return false
	}
}
