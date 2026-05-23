/**
 * PostgresOutbox — transactional outbox bridging event_log -> projection.
 *
 * Enqueue MUST happen inside the same transaction that appends the
 * event_log row (caller's responsibility — the SqlClient instance
 * passed to enqueue MUST be the same transaction handle).
 *
 * `drain` pops undelivered rows in enqueued_at order and runs them
 * through registered subscribers. Idempotent on retry: a subscriber
 * that throws leaves the row undelivered for the next drain.
 *
 * Production uses LISTEN/NOTIFY on outbox inserts to drive near-real-
 * time fan-out. Phase 0 research doc settled on this pattern for the
 * Vercel-native sync backend.
 */

import type { RunEvent, RunId } from '@agent-canvas/orchestrator-types'
import type {
	Outbox,
	OutboxRow,
	Subscriber,
} from '../orchestration/transactionalOutbox.js'
import type { SqlClient } from './client.js'

export class PostgresOutbox implements Outbox {
	private readonly subscribers: Subscriber[] = []

	constructor(private readonly sql: SqlClient) {}

	subscribe(s: Subscriber): void {
		this.subscribers.push(s)
	}

	async enqueue(event: RunEvent): Promise<OutboxRow> {
		const id = `outbox_${crypto.randomUUID()}`
		const rows = await this.sql<DbRow[]>`
			INSERT INTO outbox (id, run_id, seq, event, enqueued_at, attempts, delivered_at)
			VALUES (${id}, ${event.run_id}, ${event.seq}, ${this.sql.json(event as never)},
				now(), 0, NULL)
			RETURNING id, run_id, seq, event, enqueued_at, attempts, delivered_at
		`
		return toOutboxRow(rows[0]!)
	}

	async drain(opts: { limit?: number } = {}): Promise<readonly OutboxRow[]> {
		const limit = opts.limit ?? 100
		const undelivered = await this.sql<DbRow[]>`
			SELECT id, run_id, seq, event, enqueued_at, attempts, delivered_at
			  FROM outbox
			 WHERE delivered_at IS NULL
			 ORDER BY enqueued_at ASC
			 LIMIT ${limit}
			 FOR UPDATE SKIP LOCKED
		`
		const attempted: OutboxRow[] = []
		for (const row of undelivered) {
			const bumped = await this.sql<DbRow[]>`
				UPDATE outbox SET attempts = attempts + 1 WHERE id = ${row.id}
				RETURNING id, run_id, seq, event, enqueued_at, attempts, delivered_at
			`
			const bumpedRow = bumped[0]
			if (!bumpedRow) continue
			attempted.push(toOutboxRow(bumpedRow))
			try {
				for (const s of this.subscribers) await s(row.event as unknown as RunEvent)
				await this.markDelivered(row.id)
			} catch {
				// leave undelivered; next drain retries
			}
		}
		return attempted
	}

	async markDelivered(row_id: string): Promise<void> {
		await this.sql`
			UPDATE outbox SET delivered_at = now() WHERE id = ${row_id}
		`
	}

	async pending(): Promise<number> {
		const rows = await this.sql<{ count: number }[]>`
			SELECT COUNT(*)::int AS count FROM outbox WHERE delivered_at IS NULL
		`
		return rows[0]?.count ?? 0
	}
}

interface DbRow {
	id: string
	run_id: string
	seq: number
	event: Record<string, unknown>
	enqueued_at: Date | string
	attempts: number
	delivered_at: Date | string | null
}

function toOutboxRow(row: DbRow): OutboxRow {
	return {
		id: row.id,
		run_id: row.run_id as RunId,
		seq: row.seq,
		event: row.event as unknown as RunEvent,
		enqueued_at: toIso(row.enqueued_at),
		attempts: row.attempts,
		delivered_at: row.delivered_at === null ? null : toIso(row.delivered_at),
	}
}

function toIso(v: Date | string): string {
	if (v instanceof Date) return v.toISOString()
	return v
}
