/**
 * Stripe webhook signature verification.
 *
 * Stripe sends the header:
 *
 *   Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]
 *
 * The signed payload is `<t>.<raw_body>`. We compute HMAC-SHA256 with
 * the endpoint signing secret (provided by Stripe when the webhook
 * endpoint is registered in their dashboard) and compare to every
 * v1 hex provided. Stripe may include multiple v1 signatures during
 * a key rotation window; we accept the delivery if any match.
 *
 * Tolerance defaults to 300s per Stripe's documented recommendation.
 *
 * This is similar in shape to our own outbound signWebhook helper,
 * but the header format (multi-value, scheme prefix) differs enough
 * that they're separate modules. Sharing would create a brittle
 * abstraction.
 *
 * Failure modes (all map to 400 at the API layer):
 *   - malformed_header   the Stripe-Signature header is missing/empty
 *   - missing_signature  header parsed but no v1 entries found
 *   - bad_signature      no v1 entry matched the computed HMAC
 *   - stale_timestamp    HMAC matched but |now - t| > tolerance
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export const STRIPE_SIGNATURE_HEADER = 'stripe-signature'
export const DEFAULT_TOLERANCE_SEC = 300

export interface VerifyArgs {
	readonly secret: string
	readonly header: string
	/** Raw request body bytes as a UTF-8 string. */
	readonly body: string
	readonly tolerance_sec?: number
	readonly now_sec?: number
}

export type VerifyResult =
	| { ok: true; timestamp_sec: number }
	| {
			ok: false
			reason:
				| 'malformed_header'
				| 'missing_signature'
				| 'bad_signature'
				| 'stale_timestamp'
	  }

interface Parsed {
	readonly timestamp_sec: number
	readonly v1: readonly string[]
}

function parseHeader(header: string): Parsed | null {
	// The header is comma-separated key=value pairs; v1 may repeat.
	let ts: number | null = null
	const v1: string[] = []
	for (const part of header.split(',').map((p) => p.trim())) {
		const eq = part.indexOf('=')
		if (eq < 0) continue
		const k = part.slice(0, eq)
		const v = part.slice(eq + 1)
		if (k === 't') {
			const n = Number(v)
			if (Number.isFinite(n) && n > 0) ts = n
		} else if (k === 'v1') {
			if (/^[0-9a-f]+$/i.test(v)) v1.push(v.toLowerCase())
		}
	}
	if (ts === null) return null
	return { timestamp_sec: ts, v1 }
}

function constantTimeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	try {
		return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
	} catch {
		return false
	}
}

export function verifyStripeSignature(args: VerifyArgs): VerifyResult {
	const parsed = parseHeader(args.header)
	if (!parsed) return { ok: false, reason: 'malformed_header' }
	if (parsed.v1.length === 0) return { ok: false, reason: 'missing_signature' }

	const expected = createHmac('sha256', args.secret)
		.update(`${parsed.timestamp_sec}.${args.body}`)
		.digest('hex')

	let matched = false
	for (const sig of parsed.v1) {
		if (constantTimeEqualHex(expected, sig)) {
			matched = true
			break
		}
	}
	if (!matched) return { ok: false, reason: 'bad_signature' }

	const tolerance = args.tolerance_sec ?? DEFAULT_TOLERANCE_SEC
	const now = args.now_sec ?? Math.floor(Date.now() / 1000)
	if (Math.abs(now - parsed.timestamp_sec) > tolerance) {
		return { ok: false, reason: 'stale_timestamp' }
	}
	return { ok: true, timestamp_sec: parsed.timestamp_sec }
}
