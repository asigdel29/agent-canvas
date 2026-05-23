import { describe, expect, it } from 'vitest'
import type { RunEvent, RunId } from '@agent-canvas/orchestrator-types'
import { InMemoryOutbox } from './transactionalOutbox.js'

const RUN: RunId = 'run_t' as RunId

function evt(seq: number, kind: RunEvent['kind'] = 'progress'): RunEvent {
	return { seq, run_id: RUN, kind, ts: new Date().toISOString(), schema_version: 1, payload: {} }
}

describe('InMemoryOutbox', () => {
	it('enqueues a row and counts it as pending', async () => {
		const box = new InMemoryOutbox()
		await box.enqueue(evt(1))
		expect(await box.pending()).toBe(1)
	})

	it('drain delivers to subscribers and clears pending', async () => {
		const box = new InMemoryOutbox()
		const seen: number[] = []
		box.subscribe(async (e) => {
			seen.push(e.seq)
		})
		await box.enqueue(evt(1))
		await box.enqueue(evt(2))
		await box.enqueue(evt(3))
		await box.drain()
		expect(seen).toEqual([1, 2, 3])
		expect(await box.pending()).toBe(0)
	})

	it('retries failed deliveries on subsequent drain', async () => {
		const box = new InMemoryOutbox()
		let attempts = 0
		box.subscribe(async () => {
			attempts += 1
			if (attempts < 3) throw new Error('downstream blip')
		})
		await box.enqueue(evt(1))
		await box.drain()
		expect(await box.pending()).toBe(1) // failed; still pending
		await box.drain()
		expect(await box.pending()).toBe(1)
		await box.drain()
		expect(await box.pending()).toBe(0) // third attempt succeeds
	})

	it('drain limit caps the batch size', async () => {
		const box = new InMemoryOutbox()
		const seen: number[] = []
		box.subscribe(async (e) => {
			seen.push(e.seq)
		})
		for (let i = 1; i <= 5; i += 1) await box.enqueue(evt(i))
		await box.drain({ limit: 2 })
		expect(seen).toEqual([1, 2])
		await box.drain({ limit: 2 })
		expect(seen).toEqual([1, 2, 3, 4])
		await box.drain()
		expect(seen).toEqual([1, 2, 3, 4, 5])
	})

	it('is idempotent: replayed events do not corrupt the pending tally', async () => {
		const box = new InMemoryOutbox()
		box.subscribe(async () => {})
		await box.enqueue(evt(1))
		await box.drain()
		expect(await box.pending()).toBe(0)
		await box.drain() // re-drain with nothing pending
		expect(await box.pending()).toBe(0)
	})
})
