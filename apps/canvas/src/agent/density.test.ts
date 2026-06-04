/**
 * Tests for density.
 *
 * @author asigdel29
 */

import { describe, expect, it } from 'vitest'
import type { RunId } from '@agent-canvas/orchestrator-types'
import { decideDensity } from './density.js'

function ids(n: number): RunId[] {
	return Array.from({ length: n }, (_, i) => `run_${i}` as RunId)
}

describe('decideDensity', () => {
	it('renders all visible runs in full mode when count <= threshold', () => {
		const out = decideDensity({ visible: ids(3), forceExpanded: new Set(), threshold: 3 })
		expect(out.auto_compact).toBe(false)
		for (const id of ids(3)) expect(out.mode_by_run.get(id)).toBe('full')
	})

	it('compacts all visible runs when count > threshold', () => {
		const out = decideDensity({ visible: ids(4), forceExpanded: new Set(), threshold: 3 })
		expect(out.auto_compact).toBe(true)
		for (const id of ids(4)) expect(out.mode_by_run.get(id)).toBe('compact')
	})

	it('respects forceExpanded override per-run', () => {
		const out = decideDensity({
			visible: ids(5),
			forceExpanded: new Set([ids(5)[1]!, ids(5)[3]!]),
			threshold: 3,
		})
		expect(out.auto_compact).toBe(true)
		expect(out.mode_by_run.get(ids(5)[0]!)).toBe('compact')
		expect(out.mode_by_run.get(ids(5)[1]!)).toBe('full')
		expect(out.mode_by_run.get(ids(5)[2]!)).toBe('compact')
		expect(out.mode_by_run.get(ids(5)[3]!)).toBe('full')
		expect(out.mode_by_run.get(ids(5)[4]!)).toBe('compact')
	})

	it('forceExpanded has no effect when not in auto-compact mode', () => {
		const out = decideDensity({
			visible: ids(2),
			forceExpanded: new Set([ids(2)[0]!]),
			threshold: 3,
		})
		expect(out.auto_compact).toBe(false)
		for (const id of ids(2)) expect(out.mode_by_run.get(id)).toBe('full')
	})

	it('threshold defaults to 3 when omitted', () => {
		expect(decideDensity({ visible: ids(3), forceExpanded: new Set() }).auto_compact).toBe(false)
		expect(decideDensity({ visible: ids(4), forceExpanded: new Set() }).auto_compact).toBe(true)
	})

	it('empty visible set returns no modes and auto_compact false', () => {
		const out = decideDensity({ visible: [], forceExpanded: new Set() })
		expect(out.mode_by_run.size).toBe(0)
		expect(out.auto_compact).toBe(false)
	})

	it('configurable threshold of 5 fits more runs before collapsing', () => {
		const out = decideDensity({ visible: ids(5), forceExpanded: new Set(), threshold: 5 })
		expect(out.auto_compact).toBe(false)
		const out2 = decideDensity({ visible: ids(6), forceExpanded: new Set(), threshold: 5 })
		expect(out2.auto_compact).toBe(true)
	})
})
