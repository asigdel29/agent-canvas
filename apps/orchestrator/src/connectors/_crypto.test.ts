import { describe, expect, it } from 'vitest'
import {
	createHmac,
	createSign,
	generateKeyPairSync,
	type KeyObject,
} from 'node:crypto'
import {
	verifyEd25519,
	verifyHmacSha1,
	verifyHmacSha256,
	verifySlack,
} from './_crypto.js'

const SECRET = 'whsec_test_secret_abcdef'
const BODY = '{"event":"pull_request","action":"opened"}'

describe('verifyHmacSha256', () => {
	it('accepts a valid GitHub-style signature with sha256= prefix', () => {
		const sig =
			'sha256=' + createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex')
		expect(
			verifyHmacSha256({
				secret: SECRET,
				body: BODY,
				providedSignature: sig,
				prefix: 'sha256=',
			})
		).toBe(true)
	})

	it('rejects a wrong-secret signature', () => {
		const sig = 'sha256=' + createHmac('sha256', 'wrong').update(BODY, 'utf8').digest('hex')
		expect(
			verifyHmacSha256({
				secret: SECRET,
				body: BODY,
				providedSignature: sig,
				prefix: 'sha256=',
			})
		).toBe(false)
	})

	it('rejects a tampered body', () => {
		const sig = 'sha256=' + createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex')
		expect(
			verifyHmacSha256({
				secret: SECRET,
				body: BODY + 'x',
				providedSignature: sig,
				prefix: 'sha256=',
			})
		).toBe(false)
	})

	it('rejects an undefined or empty signature', () => {
		expect(
			verifyHmacSha256({ secret: SECRET, body: BODY, providedSignature: undefined })
		).toBe(false)
		expect(verifyHmacSha256({ secret: SECRET, body: BODY, providedSignature: '' })).toBe(false)
	})

	it('rejects a signature of the wrong length (would otherwise crash timingSafeEqual)', () => {
		expect(
			verifyHmacSha256({
				secret: SECRET,
				body: BODY,
				providedSignature: 'sha256=short',
				prefix: 'sha256=',
			})
		).toBe(false)
	})

	it('Linear-style signatures (no prefix) work', () => {
		const sig = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex')
		expect(
			verifyHmacSha256({ secret: SECRET, body: BODY, providedSignature: sig })
		).toBe(true)
	})
})

describe('verifyHmacSha1', () => {
	it('accepts a Vercel-style HMAC-SHA1 signature', () => {
		const sig = createHmac('sha1', SECRET).update(BODY, 'utf8').digest('hex')
		expect(
			verifyHmacSha1({ secret: SECRET, body: BODY, providedSignature: sig })
		).toBe(true)
	})

	it('rejects wrong-secret SHA1', () => {
		const sig = createHmac('sha1', 'wrong').update(BODY, 'utf8').digest('hex')
		expect(
			verifyHmacSha1({ secret: SECRET, body: BODY, providedSignature: sig })
		).toBe(false)
	})
})

describe('verifySlack', () => {
	const TS = '1700000000'
	const NOW_MS = 1700000000 * 1000 + 30_000 // 30s after the request

	function slackSig(secret: string, ts: string, body: string): string {
		const base = `v0:${ts}:${body}`
		return 'v0=' + createHmac('sha256', secret).update(base, 'utf8').digest('hex')
	}

	it('accepts a fresh, correctly-signed request', () => {
		expect(
			verifySlack({
				secret: SECRET,
				body: BODY,
				timestamp: TS,
				providedSignature: slackSig(SECRET, TS, BODY),
				nowMs: NOW_MS,
			})
		).toBe(true)
	})

	it('rejects a request older than the max-age window (replay defense)', () => {
		const oldTs = String(1700000000 - 10 * 60) // 10 minutes earlier
		expect(
			verifySlack({
				secret: SECRET,
				body: BODY,
				timestamp: oldTs,
				providedSignature: slackSig(SECRET, oldTs, BODY),
				nowMs: NOW_MS,
				maxAgeMs: 5 * 60 * 1000,
			})
		).toBe(false)
	})

	it('rejects a request whose body was tampered', () => {
		expect(
			verifySlack({
				secret: SECRET,
				body: BODY + 'tampered',
				timestamp: TS,
				providedSignature: slackSig(SECRET, TS, BODY),
				nowMs: NOW_MS,
			})
		).toBe(false)
	})

	it('rejects a missing timestamp or signature', () => {
		expect(
			verifySlack({
				secret: SECRET,
				body: BODY,
				timestamp: undefined,
				providedSignature: slackSig(SECRET, TS, BODY),
				nowMs: NOW_MS,
			})
		).toBe(false)
		expect(
			verifySlack({
				secret: SECRET,
				body: BODY,
				timestamp: TS,
				providedSignature: undefined,
				nowMs: NOW_MS,
			})
		).toBe(false)
	})

	it('rejects a non-numeric timestamp without throwing', () => {
		expect(
			verifySlack({
				secret: SECRET,
				body: BODY,
				timestamp: 'not-a-number',
				providedSignature: slackSig(SECRET, TS, BODY),
				nowMs: NOW_MS,
			})
		).toBe(false)
	})
})

describe('verifyEd25519', () => {
	// Discord-style Ed25519 signature verification. Generate a real
	// Ed25519 keypair and sign timestamp+body the way Discord would.

	function ed25519Sig(privateKey: KeyObject, ts: string, body: string): string {
		const signer = createSign('SHA512') // unused — ed25519 ignores algorithm
		void signer
		const { sign } = require('node:crypto') as typeof import('node:crypto')
		const sig = sign(null, Buffer.from(ts + body, 'utf8'), privateKey)
		return sig.toString('hex')
	}

	function rawPublicHex(publicKey: KeyObject): string {
		// Extract the raw 32-byte ed25519 public key from a KeyObject.
		const der = publicKey.export({ type: 'spki', format: 'der' })
		// Strip the 12-byte SPKI prefix to leave the raw key.
		return Buffer.from(der.subarray(12)).toString('hex')
	}

	it('accepts a valid Discord-style Ed25519 signature', () => {
		const { publicKey, privateKey } = generateKeyPairSync('ed25519')
		const ts = '1700000000'
		const sig = ed25519Sig(privateKey, ts, BODY)
		expect(
			verifyEd25519({
				publicKeyHex: rawPublicHex(publicKey),
				body: BODY,
				timestamp: ts,
				providedSignatureHex: sig,
			})
		).toBe(true)
	})

	it('rejects a wrong-key signature', () => {
		const { privateKey } = generateKeyPairSync('ed25519')
		const { publicKey: otherPublic } = generateKeyPairSync('ed25519')
		const ts = '1700000000'
		const sig = ed25519Sig(privateKey, ts, BODY)
		expect(
			verifyEd25519({
				publicKeyHex: rawPublicHex(otherPublic),
				body: BODY,
				timestamp: ts,
				providedSignatureHex: sig,
			})
		).toBe(false)
	})

	it('rejects a tampered body without throwing', () => {
		const { publicKey, privateKey } = generateKeyPairSync('ed25519')
		const ts = '1700000000'
		const sig = ed25519Sig(privateKey, ts, BODY)
		expect(
			verifyEd25519({
				publicKeyHex: rawPublicHex(publicKey),
				body: BODY + 'tampered',
				timestamp: ts,
				providedSignatureHex: sig,
			})
		).toBe(false)
	})

	it('rejects a malformed signature hex without throwing', () => {
		const { publicKey } = generateKeyPairSync('ed25519')
		const ts = '1700000000'
		expect(
			verifyEd25519({
				publicKeyHex: rawPublicHex(publicKey),
				body: BODY,
				timestamp: ts,
				providedSignatureHex: 'not-hex',
			})
		).toBe(false)
	})

	it('rejects a missing timestamp or signature', () => {
		const { publicKey } = generateKeyPairSync('ed25519')
		const ts = '1700000000'
		expect(
			verifyEd25519({
				publicKeyHex: rawPublicHex(publicKey),
				body: BODY,
				timestamp: undefined,
				providedSignatureHex: 'aa'.repeat(64),
			})
		).toBe(false)
		expect(
			verifyEd25519({
				publicKeyHex: rawPublicHex(publicKey),
				body: BODY,
				timestamp: ts,
				providedSignatureHex: undefined,
			})
		).toBe(false)
	})
})
