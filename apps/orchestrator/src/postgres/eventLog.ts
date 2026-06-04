/**
 * PostgresEventLog — backs the in-memory EventLog interface against
 * the schema in migrations/001_init.sql.
 *
 * Concurrency: each append takes a per-run advisory lock so seq
 * assignment is serialized within a run_id without serializing the
 * whole table. The lock is transaction-scoped (released on commit).
 *
 * Idempotency: `provider_event_id` has a partial unique index. We
 * SELECT first; if found, return existing seq with deduped=true.
 * Otherwise INSERT with seq = COALESCE(MAX(seq), 0) + 1 inside the
 * advisory-locked transaction.
 * @author asigdel29
 */

import type {
	RunEvent,
	RunEventKind,
	RunId,
	VendorId,
} from '@agent-canvas/orchestrator-types'
import type {
	AppendInput,
	AppendResult,
	EventLog,
} from '../orchestration/eventLog.js'
import { hashRunIdForLock } from './_lock.js'
import type { SqlClient } from './client.js'

export class PostgresEventLog implements EventLog {
	constructor(private readonly sql: SqlClient) {}

	async append(input: AppendInput): Promise<AppendResult> {
		const ts = input.ts ?? new Date().toISOString()
		const sv = input.schema_version ?? 1
		return await this.sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(${hashRunIdForLock(input.run_id)})`
			if (input.provider_event_id !== undefined) {
				const existing = await tx<{ seq: number }[]>`
					SELECT seq FROM event_log
					 WHERE run_id = ${input.run_id}
					   AND provider_event_id = ${input.provider_event_id}
					LIMIT 1
				`
				const first = existing[0]
				if (first) return { seq: first.seq, deduped: true }
			}
			const rows = await tx<{ seq: number }[]>`
				INSERT INTO event_log
					(run_id, seq, kind, ts, schema_version, payload, provider_event_id, vendor)
				SELECT
					${input.run_id},
					COALESCE(MAX(seq), 0) + 1,
					${input.kind},
					${ts},
					${sv},
					${tx.json(input.payload as never)},
					${input.provider_event_id ?? null},
					${input.vendor ?? null}
				FROM event_log WHERE run_id = ${input.run_id}
				RETURNING seq
			`
			const row = rows[0]
			if (!row) throw new Error('event_log insert returned no row')
			return { seq: row.seq, deduped: false }
		})
	}

	async read(
		run_id: RunId,
		opts: { fromSeq?: number; limit?: number } = {}
	): Promise<readonly RunEvent[]> {
		const fromSeq = opts.fromSeq ?? 1
		const limit = opts.limit ?? 10_000
		const rows = await this.sql<EventRow[]>`
			SELECT seq, run_id, kind, ts, schema_version, payload, provider_event_id, vendor
			  FROM event_log
			 WHERE run_id = ${run_id} AND seq >= ${fromSeq}
			 ORDER BY seq ASC
			 LIMIT ${limit}
		`
		return rows.map(rowToEvent)
	}

	async truncateBefore(run_id: RunId, checkpoint_seq: number): Promise<{ removed: number }> {
		const result = await this.sql`
			DELETE FROM event_log
			 WHERE run_id = ${run_id} AND seq < ${checkpoint_seq}
		`
		return { removed: result.count }
	}
}

interface EventRow {
	seq: number
	run_id: string
	kind: string
	ts: string
	schema_version: number
	payload: Record<string, unknown>
	provider_event_id: string | null
	vendor: string | null
}

function rowToEvent(row: EventRow): RunEvent {
	const base: RunEvent = {
		seq: row.seq,
		run_id: row.run_id as RunId,
		kind: row.kind as RunEventKind,
		ts: row.ts,
		schema_version: row.schema_version,
		payload: row.payload,
		...(row.provider_event_id !== null && { provider_event_id: row.provider_event_id }),
		...(row.vendor !== null && { vendor: row.vendor as VendorId }),
	}
	return base
}
