import { describe, expect, it } from 'vitest'
import type { RunCurrentState, RunId } from '@agent-canvas/orchestrator-types'
import {
	InMemoryRunCurrentStateCache,
	projectStateFromEvent,
} from './runCurrentState.js'

const RUN: RunId = 'run_test' as RunId

function row(last_seq: number, status: RunCurrentState['status'] = 'running'): RunCurrentState {
	return {
		run_id: RUN,
		status,
		vendor: 'codex',
		last_seq,
		last_event_at: new Date().toISOString(),
		schema_version: 1,
		updated_at: new Date().toISOString(),
	}
}

describe('InMemoryRunCurrentStateCache', () => {
	it('inserts the initial row', async () => {
		const cache = new InMemoryRunCurrentStateCache()
		await cache.insertInitial(row(1, 'queued'))
		const r = await cache.get(RUN)
		expect(r?.status).toBe('queued')
		expect(r?.last_seq).toBe(1)
	})

	it('rejects updateIfNewer with stale seq (monotonicity guard)', async () => {
		const cache = new InMemoryRunCurrentStateCache()
		await cache.insertInitial(row(5, 'running'))
		const applied = await cache.updateIfNewer(row(3, 'queued')) // older seq
		expect(applied).toBeNull()
		expect((await cache.get(RUN))?.last_seq).toBe(5)
		expect((await cache.get(RUN))?.status).toBe('running')
	})

	it('rejects updateIfNewer when last_seq equals current (no progress)', async () => {
		const cache = new InMemoryRunCurrentStateCache()
		await cache.insertInitial(row(5, 'running'))
		const applied = await cache.updateIfNewer(row(5, 'succeeded'))
		expect(applied).toBeNull()
	})

	it('accepts updateIfNewer with strictly greater seq', async () => {
		const cache = new InMemoryRunCurrentStateCache()
		await cache.insertInitial(row(5, 'running'))
		const applied = await cache.updateIfNewer(row(6, 'succeeded'))
		expect(applied?.status).toBe('succeeded')
		expect(applied?.last_seq).toBe(6)
	})

	it('insertInitial throws on duplicate', async () => {
		const cache = new InMemoryRunCurrentStateCache()
		await cache.insertInitial(row(1, 'queued'))
		await expect(cache.insertInitial(row(1, 'queued'))).rejects.toThrow()
	})

	it('get returns null for unknown runs', async () => {
		const cache = new InMemoryRunCurrentStateCache()
		expect(await cache.get('unknown' as RunId)).toBeNull()
	})
})

describe('projectStateFromEvent', () => {
	it('carries vendor forward from prior when the new event has none', () => {
		const prior: RunCurrentState = row(1)
		const next = projectStateFromEvent(prior, RUN, 2, 'running', null, '2026-01-01T00:00:02Z')
		expect(next.vendor).toBe('codex')
	})

	it('uses the new vendor when one is provided', () => {
		const prior: RunCurrentState = row(1)
		const next = projectStateFromEvent(prior, RUN, 2, 'running', 'openhands', '2026-01-01T00:00:02Z')
		expect(next.vendor).toBe('openhands')
	})

	it('defaults vendor to null when there is no prior and none provided', () => {
		const next = projectStateFromEvent(null, RUN, 1, 'queued', null, '2026-01-01T00:00:01Z')
		expect(next.vendor).toBeNull()
	})
})
