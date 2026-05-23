/**
 * EventLog — authoritative append-only log of run state transitions.
 *
 * Backend-authoritative architecture (CEO decision 1, post-inversion):
 * this log is the source of truth. The tldraw canvas is a projection
 * driven from this log; the run_current_state denormalized row is an
 * O(1) cache, also driven from this log.
 *
 * Invariants:
 *   1. APPEND-ONLY. No update, no delete (except truncation behind
 *      status_checkpoint events; see truncateBefore).
 *   2. MONOTONIC seq per run_id. Enforced by the storage backend
 *      (Postgres UNIQUE(run_id, seq)).
 *   3. IDEMPOTENT on (run_id, provider_event_id) when present —
 *      webhook redelivery folds once, not twice.
 */

import type {
	RunEvent,
	RunEventKind,
	RunId,
} from '@agent-canvas/orchestrator-types'

export interface EventLog {
	/**
	 * Append an event. Returns the seq assigned. If an event with the
	 * same (run_id, provider_event_id) already exists, returns the
	 * existing seq and does NOT write a duplicate.
	 */
	append(input: AppendInput): Promise<AppendResult>

	/**
	 * Read events for a run in monotonic seq order, optionally from a
	 * given seq forward. Used for fold, reconciliation, and recovery.
	 */
	read(run_id: RunId, opts?: { fromSeq?: number; limit?: number }): Promise<readonly RunEvent[]>

	/**
	 * Truncate events before a status_checkpoint. The caller MUST have
	 * just appended a status_checkpoint event; truncateBefore drops
	 * everything strictly before that checkpoint's seq.
	 */
	truncateBefore(run_id: RunId, checkpoint_seq: number): Promise<{ removed: number }>
}

export interface AppendInput {
	readonly run_id: RunId
	readonly kind: RunEventKind
	readonly payload: Readonly<Record<string, unknown>>
	readonly ts?: string
	readonly schema_version?: number
	readonly provider_event_id?: string
	readonly vendor?: RunEvent['vendor']
}

export interface AppendResult {
	readonly seq: number
	readonly deduped: boolean // true when a same-provider_event_id row already existed
}

// ─────────────────────────────────────────────────────────────────────
// In-memory implementation. Used by tests and as the reference. Phase 1
// production uses PostgresEventLog (see postgresEventLog.ts).
// ─────────────────────────────────────────────────────────────────────

interface StoredEvent extends RunEvent {}

export class InMemoryEventLog implements EventLog {
	private readonly byRun = new Map<RunId, StoredEvent[]>()
	/** (run_id × provider_event_id) → seq, for idempotency. */
	private readonly providerKeyIndex = new Map<string, number>()

	async append(input: AppendInput): Promise<AppendResult> {
		const events = this.byRun.get(input.run_id) ?? []
		if (input.provider_event_id) {
			const key = `${input.run_id}::${input.provider_event_id}`
			const existing = this.providerKeyIndex.get(key)
			if (existing !== undefined) return { seq: existing, deduped: true }
		}
		const seq = events.length === 0 ? 1 : (events[events.length - 1]?.seq ?? 0) + 1
		const event: StoredEvent = {
			seq,
			run_id: input.run_id,
			kind: input.kind,
			ts: input.ts ?? new Date().toISOString(),
			schema_version: input.schema_version ?? 1,
			payload: input.payload,
			...(input.provider_event_id !== undefined && {
				provider_event_id: input.provider_event_id,
			}),
			...(input.vendor !== undefined && { vendor: input.vendor }),
		}
		events.push(event)
		this.byRun.set(input.run_id, events)
		if (input.provider_event_id) {
			this.providerKeyIndex.set(`${input.run_id}::${input.provider_event_id}`, seq)
		}
		return { seq, deduped: false }
	}

	async read(
		run_id: RunId,
		opts: { fromSeq?: number; limit?: number } = {}
	): Promise<readonly RunEvent[]> {
		const events = this.byRun.get(run_id) ?? []
		let filtered = events
		if (opts.fromSeq !== undefined) {
			const from = opts.fromSeq
			filtered = events.filter((e) => e.seq >= from)
		}
		if (opts.limit !== undefined) {
			filtered = filtered.slice(0, opts.limit)
		}
		return filtered
	}

	async truncateBefore(run_id: RunId, checkpoint_seq: number): Promise<{ removed: number }> {
		const events = this.byRun.get(run_id) ?? []
		const kept = events.filter((e) => e.seq >= checkpoint_seq)
		const removed = events.length - kept.length
		this.byRun.set(run_id, kept)
		return { removed }
	}
}
