/**
 * RunArchiver — manual + scheduled archiving of terminated runs.
 *
 * The canvas projection holds a recent window per design decision 7.1
 * (hard cap with truncation). Terminal runs that age out get marked
 * archived in the projection sink so the canvas can hide them; the
 * authoritative event_log + audit_log are NEVER touched here.
 *
 * Two entry points:
 *
 *   archive(run_id)            user clicks "Archive" on a terminal card
 *   sweep(now, maxAgeMs)       scheduled hygiene sweep
 *
 * Both no-op on non-terminal runs to prevent accidental hiding of
 * in-flight work.
 */

import { isTerminal, type RunCurrentState, type RunId } from '@agent-canvas/orchestrator-types'
import type { RunCurrentStateCache } from './runCurrentState.js'

export interface RunArchiverSink {
	/** Hide the run from active canvas projections; idempotent. */
	markArchived(run_id: RunId): Promise<void>
}

export interface RunArchiverDeps {
	readonly runCurrentState: RunCurrentStateCache
	readonly sink: RunArchiverSink
	/** Source of truth for terminal runs the sweep should consider. */
	readonly listTerminalRuns: () => Promise<readonly RunCurrentState[]>
}

export interface SweepOptions {
	/** Current time, injectable for tests. */
	readonly now: Date
	/** Max age of a terminal run before it's swept. Default 30 days. */
	readonly maxAgeMs?: number
	/** Max number of runs archived per sweep. Default unlimited. */
	readonly limit?: number
}

export interface SweepResult {
	readonly considered: number
	readonly archived: readonly RunId[]
	readonly skipped: readonly { run_id: RunId; reason: 'not_terminal' | 'within_window' }[]
}

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export class RunArchiver {
	constructor(private readonly deps: RunArchiverDeps) {}

	/**
	 * Archive a single run on demand. Returns true if the run was
	 * actually archived; false if it was not terminal (the sink is not
	 * called in that case).
	 */
	async archive(run_id: RunId): Promise<boolean> {
		const row = await this.deps.runCurrentState.get(run_id)
		if (!row || !isTerminal(row.status)) return false
		await this.deps.sink.markArchived(run_id)
		return true
	}

	/**
	 * Bulk sweep. Considers every terminal run from listTerminalRuns and
	 * archives those whose last_event_at is older than now - maxAgeMs.
	 * `skipped` reports non-terminal entries (defensive — a buggy
	 * listTerminalRuns can leak non-terminal rows) and within-window
	 * entries (a non-archive that's still inside the freshness budget).
	 */
	async sweep(opts: SweepOptions): Promise<SweepResult> {
		const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS
		const cutoffMs = opts.now.getTime() - maxAgeMs
		const limit = opts.limit ?? Infinity

		const candidates = await this.deps.listTerminalRuns()
		const archived: RunId[] = []
		const skipped: { run_id: RunId; reason: 'not_terminal' | 'within_window' }[] = []

		for (const row of candidates) {
			if (archived.length >= limit) break
			if (!isTerminal(row.status)) {
				skipped.push({ run_id: row.run_id, reason: 'not_terminal' })
				continue
			}
			const eventMs = Date.parse(row.last_event_at)
			if (!Number.isFinite(eventMs) || eventMs > cutoffMs) {
				skipped.push({ run_id: row.run_id, reason: 'within_window' })
				continue
			}
			await this.deps.sink.markArchived(row.run_id)
			archived.push(row.run_id)
		}

		return { considered: candidates.length, archived, skipped }
	}
}

// ─────────────────────────────────────────────────────────────────────
// Convenience InMemory sink for tests
// ─────────────────────────────────────────────────────────────────────

export class InMemoryRunArchiverSink implements RunArchiverSink {
	readonly archived = new Set<RunId>()
	async markArchived(run_id: RunId): Promise<void> {
		this.archived.add(run_id)
	}
}
