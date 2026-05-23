import { describe, expect, it } from 'vitest'
import type { RunCurrentState, RunId, RunStatus } from '@agent-canvas/orchestrator-types'
import { InMemoryRunCurrentStateCache } from './runCurrentState.js'
import {
	InMemoryRunArchiverSink,
	RunArchiver,
} from './runArchiver.js'

function row(
	run_id: string,
	status: RunStatus,
	last_event_at: string
): RunCurrentState {
	return {
		run_id: run_id as RunId,
		status,
		vendor: 'codex',
		last_seq: 1,
		last_event_at,
		schema_version: 1,
		updated_at: last_event_at,
	}
}

async function buildHarness(rows: RunCurrentState[]) {
	const cache = new InMemoryRunCurrentStateCache()
	for (const r of rows) await cache.insertInitial(r)
	const sink = new InMemoryRunArchiverSink()
	const archiver = new RunArchiver({
		runCurrentState: cache,
		sink,
		listTerminalRuns: async () => rows.filter((r) => isTerminal(r.status)),
	})
	return { cache, sink, archiver, rows }
}

function isTerminal(s: RunStatus): boolean {
	return ['succeeded', 'failed', 'cancelled', 'unreachable'].includes(s)
}

describe('RunArchiver.archive', () => {
	it('marks a terminal run as archived', async () => {
		const h = await buildHarness([row('r1', 'succeeded', '2026-01-01T00:00:00Z')])
		const ok = await h.archiver.archive('r1' as RunId)
		expect(ok).toBe(true)
		expect(h.sink.archived.has('r1' as RunId)).toBe(true)
	})

	it('refuses to archive a non-terminal run', async () => {
		const h = await buildHarness([row('r1', 'running', '2026-01-01T00:00:00Z')])
		const ok = await h.archiver.archive('r1' as RunId)
		expect(ok).toBe(false)
		expect(h.sink.archived.size).toBe(0)
	})

	it('returns false for an unknown run without throwing', async () => {
		const h = await buildHarness([])
		const ok = await h.archiver.archive('r_missing' as RunId)
		expect(ok).toBe(false)
	})
})

describe('RunArchiver.sweep', () => {
	const NOW = new Date('2026-06-01T12:00:00Z')
	const TWO_MONTHS_AGO = '2026-04-01T00:00:00Z'
	const TWO_DAYS_AGO = '2026-05-30T12:00:00Z'

	it('archives terminal runs whose last_event_at is older than the cutoff', async () => {
		const h = await buildHarness([
			row('old_succeeded', 'succeeded', TWO_MONTHS_AGO),
			row('recent_succeeded', 'succeeded', TWO_DAYS_AGO),
		])
		const result = await h.archiver.sweep({ now: NOW, maxAgeMs: 30 * 86_400_000 })
		expect(result.archived).toEqual(['old_succeeded'])
		expect(result.skipped.map((s) => s.reason)).toEqual(['within_window'])
		expect(h.sink.archived.has('old_succeeded' as RunId)).toBe(true)
		expect(h.sink.archived.has('recent_succeeded' as RunId)).toBe(false)
	})

	it('skips non-terminal entries defensively even if listTerminalRuns leaks them', async () => {
		const h = await buildHarness([row('running_leak', 'running', TWO_MONTHS_AGO)])
		// Bypass the harness's filter to simulate a buggy listTerminalRuns.
		const sink = new InMemoryRunArchiverSink()
		const archiver = new RunArchiver({
			runCurrentState: h.cache,
			sink,
			listTerminalRuns: async () => h.rows, // includes 'running_leak'
		})
		const result = await archiver.sweep({ now: NOW, maxAgeMs: 30 * 86_400_000 })
		expect(result.archived).toEqual([])
		expect(result.skipped).toEqual([
			{ run_id: 'running_leak' as RunId, reason: 'not_terminal' },
		])
	})

	it('respects the limit option', async () => {
		const h = await buildHarness([
			row('a', 'succeeded', TWO_MONTHS_AGO),
			row('b', 'failed', TWO_MONTHS_AGO),
			row('c', 'cancelled', TWO_MONTHS_AGO),
		])
		const result = await h.archiver.sweep({ now: NOW, maxAgeMs: 30 * 86_400_000, limit: 2 })
		expect(result.archived).toHaveLength(2)
	})

	it('handles malformed last_event_at by skipping (within_window)', async () => {
		const h = await buildHarness([row('bad', 'succeeded', 'not-a-date')])
		const result = await h.archiver.sweep({ now: NOW, maxAgeMs: 30 * 86_400_000 })
		expect(result.archived).toEqual([])
		expect(result.skipped[0]!.reason).toBe('within_window')
	})

	it('reports the total considered count', async () => {
		const h = await buildHarness([
			row('old1', 'succeeded', TWO_MONTHS_AGO),
			row('old2', 'failed', TWO_MONTHS_AGO),
			row('recent', 'cancelled', TWO_DAYS_AGO),
		])
		const result = await h.archiver.sweep({ now: NOW, maxAgeMs: 30 * 86_400_000 })
		expect(result.considered).toBe(3)
		expect(result.archived).toHaveLength(2)
		expect(result.skipped).toHaveLength(1)
	})
})
