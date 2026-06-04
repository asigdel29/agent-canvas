/**
 * Tests for eventLog.
 *
 * @author asigdel29
 */

import { describe, expect, it } from 'vitest'
import type { RunId } from '@agent-canvas/orchestrator-types'
import { InMemoryEventLog } from './eventLog.js'

const RUN: RunId = 'run_test' as RunId

describe('InMemoryEventLog', () => {
	it('assigns monotonic seq starting at 1', async () => {
		const log = new InMemoryEventLog()
		const r1 = await log.append({ run_id: RUN, kind: 'queued', payload: {} })
		const r2 = await log.append({ run_id: RUN, kind: 'provisioning', payload: {} })
		expect(r1.seq).toBe(1)
		expect(r2.seq).toBe(2)
	})

	it('returns events in seq order via read', async () => {
		const log = new InMemoryEventLog()
		await log.append({ run_id: RUN, kind: 'queued', payload: {} })
		await log.append({ run_id: RUN, kind: 'provisioning', payload: {} })
		await log.append({ run_id: RUN, kind: 'running', payload: {} })
		const events = await log.read(RUN)
		expect(events.map((e) => e.kind)).toEqual(['queued', 'provisioning', 'running'])
		expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
	})

	it('dedupes on (run_id, provider_event_id)', async () => {
		const log = new InMemoryEventLog()
		const r1 = await log.append({
			run_id: RUN,
			kind: 'progress',
			payload: { msg: 'first' },
			provider_event_id: 'github_delivery_abc',
		})
		const r2 = await log.append({
			run_id: RUN,
			kind: 'progress',
			payload: { msg: 'second (should not be written)' },
			provider_event_id: 'github_delivery_abc',
		})
		expect(r1.deduped).toBe(false)
		expect(r2.deduped).toBe(true)
		expect(r2.seq).toBe(r1.seq) // returned existing
		const events = await log.read(RUN)
		expect(events).toHaveLength(1)
		expect((events[0]!.payload as { msg: string }).msg).toBe('first')
	})

	it('read with fromSeq filter returns only events at or after that seq', async () => {
		const log = new InMemoryEventLog()
		await log.append({ run_id: RUN, kind: 'queued', payload: {} })
		await log.append({ run_id: RUN, kind: 'provisioning', payload: {} })
		await log.append({ run_id: RUN, kind: 'running', payload: {} })
		const tail = await log.read(RUN, { fromSeq: 2 })
		expect(tail.map((e) => e.seq)).toEqual([2, 3])
	})

	it('truncateBefore removes events strictly before the seq and reports the count', async () => {
		const log = new InMemoryEventLog()
		for (const kind of ['queued', 'provisioning', 'running', 'progress', 'progress'] as const) {
			await log.append({ run_id: RUN, kind, payload: {} })
		}
		const { removed } = await log.truncateBefore(RUN, 4)
		expect(removed).toBe(3) // seqs 1, 2, 3 removed
		const remaining = await log.read(RUN)
		expect(remaining.map((e) => e.seq)).toEqual([4, 5])
	})

	it('runs in different namespaces do not interfere', async () => {
		const log = new InMemoryEventLog()
		const A: RunId = 'run_a' as RunId
		const B: RunId = 'run_b' as RunId
		await log.append({ run_id: A, kind: 'queued', payload: {} })
		await log.append({ run_id: B, kind: 'queued', payload: {} })
		await log.append({ run_id: A, kind: 'provisioning', payload: {} })
		expect((await log.read(A)).map((e) => e.seq)).toEqual([1, 2])
		expect((await log.read(B)).map((e) => e.seq)).toEqual([1])
	})
})
