/**
 * Tests for vendorRunMap.
 *
 * @author asigdel29
 */

import { describe, expect, it } from 'vitest'
import type { RunId } from '@agent-canvas/orchestrator-types'
import { InMemoryVendorRunMap } from './vendorRunMap.js'

describe('InMemoryVendorRunMap', () => {
	it('records a mapping and resolves it back', async () => {
		const map = new InMemoryVendorRunMap()
		await map.record({ vendor: 'codex', vendor_run_id: 'vrn_abc', run_id: 'run_1' as RunId })
		expect(await map.resolve('codex', 'vrn_abc')).toBe('run_1')
	})

	it('returns null for unknown vendor_run_ids', async () => {
		const map = new InMemoryVendorRunMap()
		expect(await map.resolve('codex', 'vrn_missing')).toBeNull()
	})

	it('namespaces by vendor — same opaque id can repeat across vendors', async () => {
		const map = new InMemoryVendorRunMap()
		await map.record({ vendor: 'codex', vendor_run_id: 'same_string', run_id: 'run_a' as RunId })
		await map.record({
			vendor: 'openhands',
			vendor_run_id: 'same_string',
			run_id: 'run_b' as RunId,
		})
		expect(await map.resolve('codex', 'same_string')).toBe('run_a')
		expect(await map.resolve('openhands', 'same_string')).toBe('run_b')
	})

	it('record() is idempotent on the same (vendor, vendor_run_id, run_id) triple', async () => {
		const map = new InMemoryVendorRunMap()
		const a = await map.record({ vendor: 'codex', vendor_run_id: 'v1', run_id: 'r1' as RunId })
		const b = await map.record({ vendor: 'codex', vendor_run_id: 'v1', run_id: 'r1' as RunId })
		expect(b.created_at).toBe(a.created_at)
	})

	it('throws on collision: same (vendor, vendor_run_id) cannot rebind to a different run', async () => {
		const map = new InMemoryVendorRunMap()
		await map.record({ vendor: 'codex', vendor_run_id: 'v1', run_id: 'r1' as RunId })
		await expect(
			map.record({ vendor: 'codex', vendor_run_id: 'v1', run_id: 'r2' as RunId })
		).rejects.toThrow(/collision/)
	})
})
