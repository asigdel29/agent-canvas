import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import {
	DEFAULT_TOLERANCE_SEC,
	verifyStripeSignature,
} from './stripeSignature.js'

const SECRET = 'whsec_test_xxxxxxxxxxxxxxxx'
const BODY = '{"id":"evt_1","type":"customer.created","data":{"object":{}}}'

function sign(body: string, secret: string, ts: number): string {
	const mac = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
	return `t=${ts},v1=${mac}`
}

describe('verifyStripeSignature', () => {
	it('accepts a fresh, well-formed signature', () => {
		const ts = Math.floor(Date.now() / 1000)
		const header = sign(BODY, SECRET, ts)
		const r = verifyStripeSignature({ secret: SECRET, header, body: BODY })
		expect(r.ok).toBe(true)
		if (r.ok) expect(r.timestamp_sec).toBe(ts)
	})

	it('rejects a tampered body', () => {
		const ts = Math.floor(Date.now() / 1000)
		const header = sign(BODY, SECRET, ts)
		const r = verifyStripeSignature({
			secret: SECRET,
			header,
			body: BODY + ' tampered',
		})
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('bad_signature')
	})

	it('rejects when secret is wrong', () => {
		const ts = Math.floor(Date.now() / 1000)
		const header = sign(BODY, SECRET, ts)
		const r = verifyStripeSignature({
			secret: 'whsec_wrong',
			header,
			body: BODY,
		})
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('bad_signature')
	})

	it('rejects a stale timestamp even with a valid signature', () => {
		const ancient = Math.floor(Date.now() / 1000) - (DEFAULT_TOLERANCE_SEC + 60)
		const header = sign(BODY, SECRET, ancient)
		const r = verifyStripeSignature({ secret: SECRET, header, body: BODY })
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('stale_timestamp')
	})

	it('rejects a malformed header (no t=)', () => {
		const r = verifyStripeSignature({
			secret: SECRET,
			header: 'v1=deadbeef',
			body: BODY,
		})
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('malformed_header')
	})

	it('rejects a header with t= but no v1=', () => {
		const r = verifyStripeSignature({
			secret: SECRET,
			header: 't=1700000000',
			body: BODY,
		})
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('missing_signature')
	})

	it('accepts a multi-v1 header (key rotation) when any matches', () => {
		const ts = Math.floor(Date.now() / 1000)
		const goodMac = createHmac('sha256', SECRET).update(`${ts}.${BODY}`).digest('hex')
		const header = `t=${ts},v1=00deadbeef00,v1=${goodMac}`
		const r = verifyStripeSignature({ secret: SECRET, header, body: BODY })
		expect(r.ok).toBe(true)
	})

	it('rejects when every v1 is wrong', () => {
		const ts = Math.floor(Date.now() / 1000)
		const header = `t=${ts},v1=aaaaaa,v1=bbbbbb`
		const r = verifyStripeSignature({ secret: SECRET, header, body: BODY })
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('bad_signature')
	})

	it('accepts a custom tolerance window', () => {
		const ts = Math.floor(Date.now() / 1000) - 10
		const header = sign(BODY, SECRET, ts)
		const tight = verifyStripeSignature({
			secret: SECRET,
			header,
			body: BODY,
			tolerance_sec: 5,
		})
		expect(tight.ok).toBe(false)
		const loose = verifyStripeSignature({
			secret: SECRET,
			header,
			body: BODY,
			tolerance_sec: 30,
		})
		expect(loose.ok).toBe(true)
	})
})
