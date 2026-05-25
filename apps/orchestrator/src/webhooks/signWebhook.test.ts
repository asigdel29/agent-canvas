import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import {
	DEFAULT_TOLERANCE_SEC,
	signWebhook,
	verifyWebhook,
} from './signWebhook.js'

const SECRET = 'shhh-this-is-a-test-secret'
const BODY = '{"event":"agent.created","id":"agt_1"}'

describe('signWebhook', () => {
	it('emits a t=<ts>,v1=<hex> header that round-trips through verify', () => {
		const { header, timestamp_sec } = signWebhook({ secret: SECRET, body: BODY })
		expect(header).toMatch(/^t=\d+,v1=[0-9a-f]+$/)
		const result = verifyWebhook({ secret: SECRET, header, body: BODY })
		expect(result.ok).toBe(true)
		if (result.ok) expect(result.timestamp_sec).toBe(timestamp_sec)
	})

	it('signs deterministically for a pinned timestamp', () => {
		const t = 1_700_000_000
		const { header } = signWebhook({ secret: SECRET, timestamp_sec: t, body: BODY })
		// Reproduce the HMAC by hand and compare. Catches accidental
		// changes to the signing payload format.
		const expected = createHmac('sha256', SECRET).update(`${t}.${BODY}`).digest('hex')
		expect(header).toBe(`t=${t},v1=${expected}`)
	})

	it('different bodies produce different signatures', () => {
		const a = signWebhook({ secret: SECRET, timestamp_sec: 1, body: 'a' })
		const b = signWebhook({ secret: SECRET, timestamp_sec: 1, body: 'b' })
		expect(a.header).not.toBe(b.header)
	})
})

describe('verifyWebhook', () => {
	it('rejects a tampered body', () => {
		const { header } = signWebhook({ secret: SECRET, body: BODY })
		const r = verifyWebhook({ secret: SECRET, header, body: BODY + ' extra' })
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('bad_signature')
	})

	it('rejects a tampered timestamp (sig no longer matches)', () => {
		const { header } = signWebhook({ secret: SECRET, body: BODY, timestamp_sec: 1000 })
		// Replace the timestamp in-place and check verify rejects it.
		const tampered = header.replace(/^t=\d+/, 't=2000')
		const r = verifyWebhook({ secret: SECRET, header: tampered, body: BODY })
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('bad_signature')
	})

	it('rejects a stale timestamp even when the signature matches', () => {
		const ancient = Math.floor(Date.now() / 1000) - (DEFAULT_TOLERANCE_SEC + 60)
		const { header } = signWebhook({ secret: SECRET, body: BODY, timestamp_sec: ancient })
		const r = verifyWebhook({ secret: SECRET, header, body: BODY })
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('stale_timestamp')
	})

	it('accepts a timestamp inside the tolerance window', () => {
		const now = Math.floor(Date.now() / 1000)
		const { header } = signWebhook({ secret: SECRET, body: BODY, timestamp_sec: now - 60 })
		const r = verifyWebhook({ secret: SECRET, header, body: BODY })
		expect(r.ok).toBe(true)
	})

	it('rejects a malformed header', () => {
		const r = verifyWebhook({ secret: SECRET, header: 'not-a-real-header', body: BODY })
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('malformed_header')
	})

	it('accepts header keys in any order', () => {
		const t = Math.floor(Date.now() / 1000)
		const mac = createHmac('sha256', SECRET).update(`${t}.${BODY}`).digest('hex')
		const reversed = `v1=${mac},t=${t}`
		const r = verifyWebhook({ secret: SECRET, header: reversed, body: BODY })
		expect(r.ok).toBe(true)
	})

	it('different secret rejects', () => {
		const { header } = signWebhook({ secret: SECRET, body: BODY })
		const r = verifyWebhook({ secret: 'wrong-secret', header, body: BODY })
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('bad_signature')
	})
})
