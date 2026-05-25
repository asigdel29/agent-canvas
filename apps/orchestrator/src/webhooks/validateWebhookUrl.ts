/**
 * URL validation for outbound webhook endpoints.
 *
 * Rejected:
 *   - non-https schemes (http, ftp, file, javascript, data, ...).
 *   - hostnames that resolve to loopback / link-local / private
 *     IP ranges. These are SSRF surface — if we POST to whatever
 *     URL the caller provides, an attacker can register
 *     http://127.0.0.1:6379 and use the orchestrator to scan or
 *     write to internal services.
 *   - URLs that fail standard parsing.
 *
 * Allowed escape hatch:
 *   - WEBHOOK_URL_ALLOW_HTTP=true permits http:// (dev only).
 *   - WEBHOOK_URL_ALLOW_PRIVATE=true permits 10.*, 172.16-31.*,
 *     192.168.*, 169.254.*, 127.*, ::1, fe80::* (dev only).
 *
 * The check is hostname-based, not DNS-resolved. A determined
 * attacker could register an external domain that resolves to a
 * private IP at delivery time (DNS rebinding). The delivery
 * worker (separate PR) must perform a final IP check after
 * resolution and abort the request when the resolved address
 * lands in a private range. Foundation here is the lexical
 * defense; the resolution defense ships with the worker.
 */

const PRIVATE_V4_RANGES: ReadonlyArray<[number, number, number, number]> = [
	// 10.0.0.0/8
	[10, 0, 0, 0xff_ff_ff],
	// 172.16.0.0/12
	[172, 16, 0, 0xff_ff_ff],
	// 192.168.0.0/16
	[192, 168, 0, 0xff_ff_ff],
	// 127.0.0.0/8 loopback
	[127, 0, 0, 0xff_ff_ff],
	// 169.254.0.0/16 link-local
	[169, 254, 0, 0xff_ff_ff],
	// 0.0.0.0/8
	[0, 0, 0, 0xff_ff_ff],
]

export type ValidateUrlResult =
	| { ok: true }
	| {
			ok: false
			reason:
				| 'malformed_url'
				| 'unsupported_scheme'
				| 'private_address'
				| 'empty_host'
	  }

export function validateWebhookUrl(input: string): ValidateUrlResult {
	let url: URL
	try {
		url = new URL(input)
	} catch {
		return { ok: false, reason: 'malformed_url' }
	}

	const allowHttp = process.env['WEBHOOK_URL_ALLOW_HTTP'] === 'true'
	if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
		return { ok: false, reason: 'unsupported_scheme' }
	}

	const host = url.hostname
	if (!host) return { ok: false, reason: 'empty_host' }

	const allowPrivate = process.env['WEBHOOK_URL_ALLOW_PRIVATE'] === 'true'
	if (!allowPrivate && isPrivateOrLoopback(host)) {
		return { ok: false, reason: 'private_address' }
	}
	return { ok: true }
}

function isPrivateOrLoopback(host: string): boolean {
	// Node's URL.hostname preserves surrounding brackets for IPv6
	// literals ('[::1]', '[fe80::1]'). Strip them so the equality
	// checks below see the bare address.
	let lower = host.toLowerCase()
	if (lower.startsWith('[') && lower.endsWith(']')) {
		lower = lower.slice(1, -1)
	}
	// Common shortcuts that don't need parsing.
	if (lower === 'localhost' || lower.endsWith('.localhost')) return true
	if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true
	// IPv4 literal?
	const v4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
	if (v4) {
		const a = Number(v4[1])
		const b = Number(v4[2])
		for (const [pa, pb] of PRIVATE_V4_RANGES) {
			if (a !== pa) continue
			if (pb === 0) return true // /8 catches 10.* and 127.* and 0.*
			// 172.16.0.0/12 means b in 16..31
			if (pa === 172 && b >= 16 && b <= 31) return true
			// 192.168.0.0/16 means b === 168
			if (pa === 192 && b === 168) return true
			// 169.254.0.0/16 means b === 254
			if (pa === 169 && b === 254) return true
		}
		// 10.* catch-all from the table above wasn't matched on every
		// row; pick up here explicitly.
		if (a === 10 || a === 127 || a === 0) return true
		return false
	}
	// IPv6 literal in brackets — URL strips them, hostname is bare.
	if (lower.includes(':')) {
		// link-local fe80::/10
		if (lower.startsWith('fe80:')) return true
		// loopback handled above
	}
	return false
}
