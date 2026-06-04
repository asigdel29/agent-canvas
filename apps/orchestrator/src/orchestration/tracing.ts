/**
 * W3C traceparent propagation.
 *
 * Outside-voice HIGH: cross-cloud propagation requires explicit header
 * discipline at every boundary — queue envelope, HTTP push, Postgres
 * event_log row, internal RPC. This module centralizes traceparent
 * parsing and generation so no boundary forgets.
 *
 * Format: 00-<32 hex trace_id>-<16 hex span_id>-<2 hex flags>
 * Spec:   https://www.w3.org/TR/trace-context/
 * @author asigdel29
 */

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

export interface TraceContext {
	readonly trace_id: string
	readonly span_id: string
	readonly flags: string
}

/** Generate a fresh traceparent for the root of a new trace. */
export function newTraceparent(): string {
	return `00-${randomHex(32)}-${randomHex(16)}-01`
}

/**
 * Parse a traceparent header. Returns null if malformed; the caller
 * should then generate a new one rather than propagating garbage.
 */
export function parseTraceparent(header: string | undefined): TraceContext | null {
	if (!header) return null
	const match = TRACEPARENT_RE.exec(header.toLowerCase())
	if (!match) return null
	return { trace_id: match[1]!, span_id: match[2]!, flags: match[3]! }
}

/** Mint a child span under an existing trace, keeping flags. */
export function childTraceparent(parent: TraceContext): string {
	return `00-${parent.trace_id}-${randomHex(16)}-${parent.flags}`
}

/**
 * Ensure a traceparent exists: if the input is valid, reuse it; if
 * absent or malformed, mint a fresh root trace. Returns the wire value.
 */
export function ensureTraceparent(header: string | undefined): string {
	const parsed = parseTraceparent(header)
	if (parsed) return childTraceparent(parsed)
	return newTraceparent()
}

// ─────────────────────────────────────────────────────────────────────
// Local helpers
// ─────────────────────────────────────────────────────────────────────

function randomHex(chars: number): string {
	const bytes = chars >> 1
	const arr = new Uint8Array(bytes)
	cryptoSource().getRandomValues(arr)
	let out = ''
	for (const b of arr) out += b.toString(16).padStart(2, '0')
	return out
}

function cryptoSource(): Crypto {
	// globalThis.crypto is available on Node 19+ and all modern browsers.
	const c = (globalThis as { crypto?: Crypto }).crypto
	if (!c) throw new Error('no crypto.getRandomValues available')
	return c
}
