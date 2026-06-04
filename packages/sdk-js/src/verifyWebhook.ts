/**
 * verifyWebhook — the receiver's mirror of the orchestrator's
 * signWebhook routine.
 *
 * Why this lives in the SDK and not as an import from the
 * orchestrator: the SDK is published; the orchestrator is private.
 * Duplicating the routine keeps the SDK installable without a
 * private dep, and the test suite below pins the wire compatibility
 * between the two implementations so they cannot drift.
 *
 * Header shape (same as the orchestrator emits):
 *
 *   X-AC-Signature: t=<unix_ts>,v1=<hex_hmac>
 *
 * The receiver:
 *   1. Reads the X-AC-Signature header value off the inbound POST.
 *   2. Calls verifyWebhook({ secret, header, body, ...}).
 *   3. On result.ok === true, processes the event.
 *   4. On result.ok === false, returns 400 to the orchestrator.
 *
 * Constant-time HMAC compare via timingSafeEqual; a wrong byte
 * does not leak through latency.
 * @author asigdel29
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_HEADER = 'x-ac-signature'

/** Clock-skew tolerance in seconds. Matches the orchestrator's emit-side value. */
export const DEFAULT_TOLERANCE_SEC = 300

export interface VerifyWebhookArgs {
	readonly secret: string
	readonly header: string
	/** Raw request body. MUST be the exact bytes received. */
	readonly body: string
	readonly tolerance_sec?: number
	readonly now_sec?: number
}

export type VerifyWebhookResult =
	| { ok: true; timestamp_sec: number }
	| { ok: false; reason: 'malformed_header' | 'bad_signature' | 'stale_timestamp' }

export function verifyWebhook(args: VerifyWebhookArgs): VerifyWebhookResult {
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
