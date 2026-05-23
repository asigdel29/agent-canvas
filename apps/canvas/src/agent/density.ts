/**
 * Density-adaptive collapse.
 *
 * Pure function. Given the set of agent runs visible in the current
 * viewport at the current zoom, and a per-user override map of forced-
 * expanded runs, decides which runs render in `compact` mode vs `full`.
 *
 * Rule (locked in design review 34):
 *
 *   visible > N → all auto-compact
 *   visible ≤ N → all full
 *   click-to-expand override → that specific run renders full regardless
 *
 * N defaults to 3 (validated by the Phase 0 prototype). Performance:
 * O(visible) — a cheap visible-bbox count, not a layout pass (decision
 * 34 mandate).
 */

import type { RunId } from '@agent-canvas/orchestrator-types'

export type RenderMode = 'full' | 'compact'

export interface DensityInput {
	readonly visible: readonly RunId[]
	readonly forceExpanded: ReadonlySet<RunId>
	readonly threshold?: number
}

export interface DensityOutput {
	readonly mode_by_run: ReadonlyMap<RunId, RenderMode>
	readonly auto_compact: boolean
}

export function decideDensity(input: DensityInput): DensityOutput {
	const threshold = input.threshold ?? 3
	const autoCompact = input.visible.length > threshold
	const map = new Map<RunId, RenderMode>()
	for (const run_id of input.visible) {
		if (!autoCompact) {
			map.set(run_id, 'full')
		} else if (input.forceExpanded.has(run_id)) {
			map.set(run_id, 'full')
		} else {
			map.set(run_id, 'compact')
		}
	}
	return { mode_by_run: map, auto_compact: autoCompact }
}
