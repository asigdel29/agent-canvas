import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAndCheckIp } from './resolveAndCheckIp.js'

function fakeLookup(records: Array<{ address: string; family: 4 | 6 }>): typeof import('node:dns/promises').lookup {
	return (async () => records) as unknown as typeof import('node:dns/promises').lookup
}

function failingLookup(): typeof import('node:dns/promises').lookup {
	return (async () => {
		throw new Error('ENOTFOUND')
	}) as unknown as typeof import('node:dns/promises').lookup
}

describe('resolveAndCheckIp', () => {
	const original = { ...process.env }
	beforeEach(() => {
		delete process.env['WEBHOOK_URL_ALLOW_PRIVATE']
	})
	afterEach(() => {
		process.env = { ...original }
	})

	it('accepts a public IPv4', async () => {
		const r = await resolveAndCheckIp('example.com', {
			lookupImpl: fakeLookup([{ address: '93.184.216.34', family: 4 }]),
		})
		expect(r.ok).toBe(true)
	})

	it('rejects loopback v4', async () => {
		const r = await resolveAndCheckIp('attacker.com', {
			lookupImpl: fakeLookup([{ address: '127.0.0.1', family: 4 }]),
		})
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('private_address')
	})

	it('rejects RFC1918 v4 (10/8, 172.16/12, 192.168/16)', async () => {
		for (const addr of ['10.0.0.1', '172.20.0.5', '192.168.1.1']) {
			// eslint-disable-next-line no-await-in-loop
			const r = await resolveAndCheckIp('h', {
				lookupImpl: fakeLookup([{ address: addr, family: 4 }]),
			})
			expect(r.ok, addr).toBe(false)
		}
	})

	it('rejects link-local 169.254.* (AWS metadata exfil target)', async () => {
		const r = await resolveAndCheckIp('rebound.attacker.com', {
			lookupImpl: fakeLookup([{ address: '169.254.169.254', family: 4 }]),
		})
		expect(r.ok).toBe(false)
	})

	it('rejects IPv6 loopback ::1', async () => {
		const r = await resolveAndCheckIp('h', {
			lookupImpl: fakeLookup([{ address: '::1', family: 6 }]),
		})
		expect(r.ok).toBe(false)
	})

	it('rejects fe80::/10 link-local', async () => {
		const r = await resolveAndCheckIp('h', {
			lookupImpl: fakeLookup([{ address: 'fe80::1', family: 6 }]),
		})
		expect(r.ok).toBe(false)
	})

	it('rejects fc00::/7 unique-local', async () => {
		const r = await resolveAndCheckIp('h', {
			lookupImpl: fakeLookup([{ address: 'fc00::1', family: 6 }]),
		})
		expect(r.ok).toBe(false)
	})

	it('rejects IPv4-mapped private (::ffff:10.0.0.1)', async () => {
		const r = await resolveAndCheckIp('h', {
			lookupImpl: fakeLookup([{ address: '::ffff:10.0.0.1', family: 6 }]),
		})
		expect(r.ok).toBe(false)
	})

	it('a multi-record set fails if ANY resolves private (rebinding defense)', async () => {
		const r = await resolveAndCheckIp('mixed.example', {
			lookupImpl: fakeLookup([
				{ address: '93.184.216.34', family: 4 },
				{ address: '127.0.0.1', family: 4 },
			]),
		})
		expect(r.ok).toBe(false)
	})

	it('treats DNS errors as dns_failure (retry candidate)', async () => {
		const r = await resolveAndCheckIp('nope.invalid', { lookupImpl: failingLookup() })
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('dns_failure')
	})

	it('empty record set is treated as dns_failure', async () => {
		const r = await resolveAndCheckIp('h', { lookupImpl: fakeLookup([]) })
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('dns_failure')
	})

	it('WEBHOOK_URL_ALLOW_PRIVATE=true bypasses the check', async () => {
		process.env['WEBHOOK_URL_ALLOW_PRIVATE'] = 'true'
		const r = await resolveAndCheckIp('h', {
			lookupImpl: fakeLookup([{ address: '127.0.0.1', family: 4 }]),
		})
		expect(r.ok).toBe(true)
	})
})
