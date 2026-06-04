/**
 * RunCurrentStateCache — O(1) read cache for "current run state."
 *
 * Updated in the SAME transaction as every event_log append (Eng review
 * decision 42). The monotonicity predicate is non-negotiable:
 *
 *   UPDATE run_current_state SET ... WHERE run_id = $1 AND last_seq < $2
 *
 * Without that predicate, a delayed re-delivery of an old event silently
 * downgrades state (outside-voice HIGH on event log fold caching).
 *
 * The in-memory implementation here enforces the same predicate so that
 * tests catch monotonicity bugs.
 * @author asigdel29
 */

import type {
	RunCurrentState,
	RunId,
	RunStatus,
	VendorId,
} from '@agent-canvas/orchestrator-types'

export interface RunCurrentStateCache {
	get(run_id: RunId): Promise<RunCurrentState | null>

	/**
	 * Conditionally update the row, only if `last_seq < next.last_seq`.
	 * Returns the applied row on success, or null if the predicate
	 * rejected the write (stale event arriving out of order).
	 */
	updateIfNewer(next: RunCurrentState): Promise<RunCurrentState | null>

	/** Create the row on the very first event of a run. */
	insertInitial(initial: RunCurrentState): Promise<void>
}

export class InMemoryRunCurrentStateCache implements RunCurrentStateCache {
	private readonly rows = new Map<RunId, RunCurrentState>()

	async get(run_id: RunId): Promise<RunCurrentState | null> {
		return this.rows.get(run_id) ?? null
	}

	async insertInitial(initial: RunCurrentState): Promise<void> {
		if (this.rows.has(initial.run_id)) {
			throw new Error(`runCurrentState already exists: ${initial.run_id}`)
		}
		this.rows.set(initial.run_id, initial)
	}

	async updateIfNewer(next: RunCurrentState): Promise<RunCurrentState | null> {
		const current = this.rows.get(next.run_id)
		if (current === undefined) {
			// no row to update; caller must call insertInitial first
			return null
		}
		if (current.last_seq >= next.last_seq) {
			// stale apply — out-of-order replay or duplicate. Reject.
			return null
		}
		this.rows.set(next.run_id, next)
		return next
	}
}

/**
 * Convenience helper to build a RunCurrentState row from an event.
 * Schema version is read from the event; if the event's kind is not a
 * status event, status carries over from `prior` (or `null` if prior
 * is null and the event is not status-bearing — caller's problem).
 */
export function projectStateFromEvent(
	prior: RunCurrentState | null,
	run_id: RunId,
	seq: number,
	status: RunStatus,
	vendor: VendorId | null,
	event_ts: string
): RunCurrentState {
	return {
		run_id,
		status,
		vendor: vendor ?? prior?.vendor ?? null,
		last_seq: seq,
		last_event_at: event_ts,
		schema_version: prior?.schema_version ?? 1,
		updated_at: new Date().toISOString(),
	}
}
