/**
 * DNS-resolution SSRF defense.
 *
 * P6's validateWebhookUrl is lexical only — it catches an attacker
 * who registers https://127.0.0.1 directly, but not one who
 * registers https://attacker-controlled.example.com that resolves
 * to a private IP at delivery time (DNS rebinding).
 *
 * This module closes that gap: it resolves the hostname to a list
 * of IPs and aborts the delivery if ANY resolved address lands in
 * a private range. Conservative: a domain with mixed public+private
 * A records fails. Stops the rebinding race because we observe the
 * same answer we'd give the underlying TCP socket.
 *
 * The check is bypassed when WEBHOOK_URL_ALLOW_PRIVATE=true (dev
 * escape hatch shared with validateWebhookUrl).
 * @author asigdel29
 */

import { lookup } from 'node:dns/promises'

const PRIVATE_V4_RANGES: ReadonlyArray<[number, number, number]> = [
	// 10.0.0.0/8
	[10, 0, 8],
	// 127.0.0.0/8 loopback
	[127, 0, 8],
	// 0.0.0.0/8
	[0, 0, 8],
	// 172.16.0.0/12
	[172, 16, 12],
	// 192.168.0.0/16
	[192, 168, 16],
	// 169.254.0.0/16 link-local + AWS metadata
	[169, 254, 16],
]

export type IpCheckResult =
	| { ok: true; resolved: readonly string[] }
	| { ok: false; reason: 'dns_failure' | 'private_address'; resolved?: readonly string[] }

export interface IpCheckOptions {
	/** Test seam — defaults to node:dns/promises.lookup. */
	readonly lookupImpl?: typeof lookup
}

export async function resolveAndCheckIp(
	hostname: string,
	opts: IpCheckOptions = {}
): Promise<IpCheckResult> {
	if (process.env['WEBHOOK_URL_ALLOW_PRIVATE'] === 'true') {
		return { ok: true, resolved: [] }
	}
	const lookupFn = opts.lookupImpl ?? lookup
	// 'all' returns every A/AAAA record so we check the whole set,
	// not just the first answer that dns_lookup_resolve happens to
	// pick.
	let records: Array<{ address: string; family: number }>
	try {
		records = (await lookupFn(hostname, { all: true })) as Array<{
			address: string
			family: number
		}>
	} catch {
		return { ok: false, reason: 'dns_failure' }
	}
	if (records.length === 0) {
		return { ok: false, reason: 'dns_failure' }
	}
	const resolved = records.map((r) => r.address)
	for (const r of records) {
		if (r.family === 4) {
			if (isPrivateV4(r.address)) {
				return { ok: false, reason: 'private_address', resolved }
			}
		} else if (r.family === 6) {
			if (isPrivateV6(r.address)) {
				return { ok: false, reason: 'private_address', resolved }
			}
		}
	}
	return { ok: true, resolved }
}

function isPrivateV4(addr: string): boolean {
	const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
	if (!m) return true // unparseable → treat as private (fail safe)
	const a = Number(m[1])
	const b = Number(m[2])
	for (const [pa, pb, mask] of PRIVATE_V4_RANGES) {
		if (mask === 8) {
			if (a === pa) return true
		} else if (mask === 12) {
			// 172.16.0.0/12 → b in 16..31
			if (a === pa && b >= 16 && b <= 31) return true
		} else if (mask === 16) {
			if (a === pa && b === pb) return true
		}
	}
	return false
}

function isPrivateV6(addr: string): boolean {
	const lower = addr.toLowerCase()
	// IPv6 loopback ::1
	if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true
	// Link-local fe80::/10 — first 10 bits are 1111111010.
	// Cheap check: starts with 'fe8', 'fe9', 'fea', 'feb'.
	if (/^fe[89ab]/.test(lower)) return true
	// Unique-local fc00::/7 — starts with 'fc' or 'fd'.
	if (/^f[cd]/.test(lower)) return true
	// IPv4-mapped (::ffff:x.x.x.x) — check the embedded v4.
	const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
	if (mapped) return isPrivateV4(mapped[1]!)
	return false
}
