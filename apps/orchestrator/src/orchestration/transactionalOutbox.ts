/**
 * TransactionalOutbox — bridges authoritative writes (event_log) to
 * downstream effects (projection, broadcast, audit) without breaking
 * the transactional consistency of the source-of-truth.
 *
 * Outside-voice CRITICAL on decision 4.1: writing run_current_state in
 * the same transaction as event_log only covers PG, not the broadcast.
 * The fix: never broadcast from in-memory event projection. Always
 * write an outbox row in the same transaction as the event, then a
 * drainer fans out from the outbox AFTER commit. The drainer is
 * idempotent: same outbox row applied twice has the same effect as once.
 *
 * In-memory implementation here is correct-by-construction for tests.
 * Production wires Postgres LISTEN/NOTIFY on the outbox table for
 * low-latency drain.
 */

import type { RunEvent, RunId } from '@agent-canvas/orchestrator-types'

export interface OutboxRow {
	readonly id: string
	readonly run_id: RunId
	readonly seq: number
	readonly event: RunEvent
	readonly enqueued_at: string
	readonly attempts: number
	readonly delivered_at: string | null
}

export interface Outbox {
	/** Enqueue MUST happen in the same transaction as the event_log append. */
	enqueue(event: RunEvent): Promise<OutboxRow>
	/** Drain unfinished rows. Returns rows attempted; idempotent on retry. */
	drain(opts?: { limit?: number }): Promise<readonly OutboxRow[]>
	markDelivered(row_id: string): Promise<void>
	pending(): Promise<number>
	/**
	 * Install a subscriber called on each drained event. Returns the
	 * disposal hook (not all implementations support detachment;
	 * production drops subscribers on instance restart).
	 */
	subscribe(s: Subscriber): void
}

export type Subscriber = (event: RunEvent) => Promise<void>

export class InMemoryOutbox implements Outbox {
	private readonly rows = new Map<string, OutboxRow>()
	private readonly subscribers: Subscriber[] = []
	private nextId = 1

	subscribe(s: Subscriber): void {
		this.subscribers.push(s)
	}

	async enqueue(event: RunEvent): Promise<OutboxRow> {
		const id = `outbox_${this.nextId++}`
		const row: OutboxRow = {
			id,
			run_id: event.run_id,
			seq: event.seq,
			event,
			enqueued_at: new Date().toISOString(),
			attempts: 0,
			delivered_at: null,
		}
		this.rows.set(id, row)
		return row
	}

	async drain(opts: { limit?: number } = {}): Promise<readonly OutboxRow[]> {
		const limit = opts.limit ?? Infinity
		const undelivered = [...this.rows.values()].filter((r) => r.delivered_at === null).slice(0, limit)
		const attempted: OutboxRow[] = []
		for (const row of undelivered) {
			const bumped: OutboxRow = { ...row, attempts: row.attempts + 1 }
			this.rows.set(row.id, bumped)
			attempted.push(bumped)
			try {
				for (const s of this.subscribers) await s(row.event)
				await this.markDelivered(row.id)
			} catch {
				// leave undelivered; next drain will retry
			}
		}
		return attempted
	}

	async markDelivered(row_id: string): Promise<void> {
		const row = this.rows.get(row_id)
		if (!row) return
		this.rows.set(row_id, { ...row, delivered_at: new Date().toISOString() })
	}

	async pending(): Promise<number> {
		let count = 0
		for (const r of this.rows.values()) if (r.delivered_at === null) count += 1
		return count
	}
}
