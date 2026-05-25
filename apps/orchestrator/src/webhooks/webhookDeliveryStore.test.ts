import { describe, expect, it, vi } from 'vitest'
import {
	InMemoryWebhookDeliveryStore,
	MAX_ATTEMPTS,
	nextDelayMs,
} from './webhookDeliveryStore.js'

describe('nextDelayMs schedule', () => {
	it('first attempt is immediate', () => {
		expect(nextDelayMs(1)).toBe(0)
	})
	it('increases with each attempt', () => {
		for (let i = 2; i <= MAX_ATTEMPTS; i++) {
			expect(nextDelayMs(i)).toBeGreaterThan(nextDelayMs(i - 1))
		}
	})
	it('clamps at the last bucket for overflow', () => {
		expect(nextDelayMs(99)).toBe(nextDelayMs(MAX_ATTEMPTS))
	})
})

describe('InMemoryWebhookDeliveryStore', () => {
	function mkDelivery(endpoint = 'whe_1') {
		return {
			endpoint_id: endpoint,
			event_id: 'evt_1',
			event_type: 'token.minted',
			body: '{"hello":"world"}',
		}
	}

	it('enqueue stamps id, pending, attempt_num=0, next_attempt_at=now', async () => {
		const s = new InMemoryWebhookDeliveryStore()
		const r = await s.enqueue(mkDelivery())
		expect(r.id.startsWith('whd_')).toBe(true)
		expect(r.status).toBe('pending')
		expect(r.attempt_num).toBe(0)
		expect(r.next_attempt_at).not.toBeNull()
	})

	it('claimPending flips status atomically and respects the batch size', async () => {
		const s = new InMemoryWebhookDeliveryStore()
		await s.enqueue(mkDelivery())
		await s.enqueue(mkDelivery())
		await s.enqueue(mkDelivery())
		const claimed = await s.claimPending(2)
		expect(claimed).toHaveLength(2)
		for (const c of claimed) expect(c.status).toBe('in_flight')
		// Second claim sees only the remaining row.
		const remaining = await s.claimPending(10)
		expect(remaining).toHaveLength(1)
	})

	it('claimPending skips rows whose next_attempt_at is still in the future', async () => {
		const s = new InMemoryWebhookDeliveryStore()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
		const r = await s.enqueue(mkDelivery())
		// Force a retry with a future next_attempt_at.
		await s.markAttemptFailed({
			delivery_id: r.id,
			status_code: 500,
			error: 'transient',
		})
		// Right after: should not be claimable yet.
		expect(await s.claimPending(10)).toHaveLength(0)
		// Advance past the retry delay.
		vi.setSystemTime(new Date('2026-01-01T01:00:00Z'))
		expect(await s.claimPending(10)).toHaveLength(1)
		vi.useRealTimers()
	})

	it('markSucceeded leaves the row terminal with succeeded_at', async () => {
		const s = new InMemoryWebhookDeliveryStore()
		const r = await s.enqueue(mkDelivery())
		await s.markSucceeded({ delivery_id: r.id, status_code: 200, error: null })
		const after = (await s.listByEndpoint('whe_1'))[0]!
		expect(after.status).toBe('succeeded')
		expect(after.succeeded_at).not.toBeNull()
		expect(after.next_attempt_at).toBeNull()
	})

	it('markAttemptFailed retries until the budget exhausts, then fails', async () => {
		const s = new InMemoryWebhookDeliveryStore()
		const r = await s.enqueue(mkDelivery())
		for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
			// eslint-disable-next-line no-await-in-loop
			const after = await s.markAttemptFailed({
				delivery_id: r.id,
				status_code: 500,
				error: 'transient',
			})
			expect(after.status).toBe('pending')
		}
		const final = await s.markAttemptFailed({
			delivery_id: r.id,
			status_code: 500,
			error: 'transient',
		})
		expect(final.status).toBe('failed')
		expect(final.failed_at).not.toBeNull()
		expect(final.next_attempt_at).toBeNull()
		expect(final.attempt_num).toBe(MAX_ATTEMPTS)
	})

	it('listByEndpoint returns newest first, capped by limit', async () => {
		const s = new InMemoryWebhookDeliveryStore()
		const a = await s.enqueue(mkDelivery('whe_1'))
		const b = await s.enqueue(mkDelivery('whe_1'))
		await s.enqueue(mkDelivery('whe_other'))
		const rows = await s.listByEndpoint('whe_1', 10)
		expect(rows).toHaveLength(2)
		expect(rows.map((r) => r.id)).toEqual([b.id, a.id])
	})
})
