/**
 * Tests for validateWebhookUrl.
 *
 * @author asigdel29
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateWebhookUrl } from './validateWebhookUrl.js'

describe('validateWebhookUrl', () => {
	const originalEnv = { ...process.env }
	beforeEach(() => {
		delete process.env['WEBHOOK_URL_ALLOW_HTTP']
		delete process.env['WEBHOOK_URL_ALLOW_PRIVATE']
	})
	afterEach(() => {
		process.env = { ...originalEnv }
	})

	it('accepts a normal https URL', () => {
		expect(validateWebhookUrl('https://api.example.com/hook')).toEqual({ ok: true })
	})

	it('rejects http by default', () => {
		const r = validateWebhookUrl('http://api.example.com/hook')
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('unsupported_scheme')
	})

	it('rejects javascript: and data: URIs', () => {
		expect(validateWebhookUrl('javascript:alert(1)').ok).toBe(false)
		expect(validateWebhookUrl('data:text/plain,hello').ok).toBe(false)
		expect(validateWebhookUrl('file:///etc/passwd').ok).toBe(false)
	})

	it('rejects loopback variants', () => {
		const loopbacks = [
			'https://localhost/hook',
			'https://127.0.0.1/hook',
			'https://127.1.2.3/hook',
			'https://[::1]/hook',
			'https://foo.localhost/hook',
		]
		for (const url of loopbacks) {
			const r = validateWebhookUrl(url)
			expect(r.ok, `expected reject for ${url}`).toBe(false)
		}
	})

	it('rejects RFC1918 private ranges', () => {
		const privates = [
			'https://10.0.0.1/hook',
			'https://10.255.255.255/hook',
			'https://172.16.0.1/hook',
			'https://172.31.255.255/hook',
			'https://192.168.1.1/hook',
		]
		for (const url of privates) {
			const r = validateWebhookUrl(url)
			expect(r.ok, `expected reject for ${url}`).toBe(false)
		}
	})

	it('rejects link-local 169.254.* and IPv6 fe80::*', () => {
		expect(validateWebhookUrl('https://169.254.169.254/hook').ok).toBe(false)
		expect(validateWebhookUrl('https://[fe80::1]/hook').ok).toBe(false)
	})

	it('rejects 172.15.* (just outside the private range)', () => {
		expect(validateWebhookUrl('https://172.15.0.1/hook').ok).toBe(true)
		expect(validateWebhookUrl('https://172.32.0.1/hook').ok).toBe(true)
	})

	it('WEBHOOK_URL_ALLOW_HTTP=true opens up http://', () => {
		process.env['WEBHOOK_URL_ALLOW_HTTP'] = 'true'
		expect(validateWebhookUrl('http://api.example.com/hook').ok).toBe(true)
	})

	it('WEBHOOK_URL_ALLOW_PRIVATE=true opens up loopback for dev', () => {
		process.env['WEBHOOK_URL_ALLOW_PRIVATE'] = 'true'
		expect(validateWebhookUrl('https://127.0.0.1/hook').ok).toBe(true)
	})

	it('rejects malformed URLs', () => {
		const r = validateWebhookUrl('not a url at all')
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('malformed_url')
	})
})
