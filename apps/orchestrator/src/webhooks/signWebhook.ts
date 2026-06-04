/**
 * HMAC-SHA256 signing for outbound webhook deliveries.
 *
 * Header shape (Stripe-style):
 *
 *   X-AC-Signature: t=<unix_ts>,v1=<hex_hmac>
 *
 * The receiver:
 *   1. Parses t and v1 out of the header.
 *   2. Builds the signed payload as `<t>.<raw_body>` and computes
 *      HMAC-SHA256 keyed by the signing_secret it has on file.
 *   3. Compares timing-safely against v1. Rejects if mismatched.
 *   4. Rejects if |now - t| exceeds the configured tolerance,
 *      defending against replay of an old signed body.
 *
 * Tolerance default 5 minutes matches Stripe / Slack / GitHub.
 *
 * Why this layer is its own file, not inlined in the delivery
 * worker: customers want to verify the same way we sign. Exporting
 * the verify function (so it can be unit-tested in isolation and
 * later reused from a published SDK) makes that path obvious.
 * @author asigdel29
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_HEADER = 'x-ac-signature'

/** Tolerance for clock skew, in seconds. */
export const DEFAULT_TOLERANCE_SEC = 300

export interface SignArgs {
	readonly secret: string
	/** Unix timestamp in seconds; defaults to current time. */
	readonly timestamp_sec?: number
	/** The JSON-serialized body that will be sent as the HTTP request body. */
	readonly body: string
}

export interface SignResult {
	readonly header: string
	readonly timestamp_sec: number
}

/**
 * Produce the X-AC-Signature header value for a given body+secret.
 * Returns both the header string and the timestamp that was signed,
 * so the caller can log or pin it.
 */
export function signWebhook(args: SignArgs): SignResult {
	const ts = args.timestamp_sec ?? Math.floor(Date.now() / 1000)
	const signed = `${ts}.${args.body}`
	const mac = createHmac('sha256', args.secret).update(signed).digest('hex')
	return { header: `t=${ts},v1=${mac}`, timestamp_sec: ts }
}

export interface VerifyArgs {
	readonly secret: string
	/** Value of the X-AC-Signature header from the inbound request. */
	readonly header: string
	/** Raw request body. MUST be the exact bytes received, not a re-serialized object. */
	readonly body: string
	/** Override for the clock-skew tolerance, in seconds. */
	readonly tolerance_sec?: number
	/** Override for "now", for tests. */
	readonly now_sec?: number
}

export type VerifyResult =
	| { ok: true; timestamp_sec: number }
	| { ok: false; reason: 'malformed_header' | 'bad_signature' | 'stale_timestamp' }

/**
 * Verify an inbound X-AC-Signature header against the body and secret.
 *
 * Postconditions:
 *   - ok: signature matches AND timestamp is within tolerance.
 *   - bad_signature: HMAC compare failed; reject the delivery.
 *   - stale_timestamp: HMAC matched but the request is too old or
 *     too far in the future; reject as a replay candidate.
 *   - malformed_header: header is missing parts; reject.
 *
 * Comparison is constant-time via timingSafeEqual; a wrong byte
 * doesn't leak through latency.
 */
export function verifyWebhook(args: VerifyArgs): VerifyResult {
	const parsed = parseHeader(args.header)
	if (!parsed) return { ok: false, reason: 'malformed_header' }

	const expected = createHmac('sha256', args.secret)
		.update(`${parsed.timestamp_sec}.${args.body}`)
		.digest('hex')
	if (!constantTimeEqualHex(expected, parsed.hex)) {
		return { ok: false, reason: 'bad_signature' }
	}

	const tolerance = args.tolerance_sec ?? DEFAULT_TOLERANCE_SEC
	const now = args.now_sec ?? Math.floor(Date.now() / 1000)
	if (Math.abs(now - parsed.timestamp_sec) > tolerance) {
		return { ok: false, reason: 'stale_timestamp' }
	}
	return { ok: true, timestamp_sec: parsed.timestamp_sec }
}

function parseHeader(header: string): { timestamp_sec: number; hex: string } | null {
	// Format: t=<digits>,v1=<hex>
	// Order is not guaranteed — accept any order, accept extra keys.
	const parts = header.split(',').map((p) => p.trim())
	let ts: number | null = null
	let hex: string | null = null
	for (const p of parts) {
		const eq = p.indexOf('=')
		if (eq < 0) continue
		const k = p.slice(0, eq)
		const v = p.slice(eq + 1)
		if (k === 't') {
			const n = Number(v)
			if (Number.isFinite(n) && n > 0) ts = n
		} else if (k === 'v1') {
			if (/^[0-9a-f]+$/i.test(v)) hex = v.toLowerCase()
		}
	}
	if (ts === null || hex === null) return null
	return { timestamp_sec: ts, hex }
}

function constantTimeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	try {
		return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
	} catch {
		return false
	}
}
