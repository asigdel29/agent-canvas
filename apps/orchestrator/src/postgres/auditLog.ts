/**
 * PostgresAuditLog — durable forensic record (decision 8.1).
 *
 * Append-only. Queries by run, user, or room, each ordered most-recent
 * first via the indexes in 001_init.sql. Retention policy enforced
 * out-of-band; this adapter just reads/writes.
 */

import type {
	AuditEntry,
	RoomId,
	RunId,
	UserId,
} from '@agent-canvas/orchestrator-types'
import type { AuditLog } from '../orchestration/auditLog.js'
import type { SqlClient } from './client.js'

export class PostgresAuditLog implements AuditLog {
	constructor(private readonly sql: SqlClient) {}

	async record(entry: Omit<AuditEntry, 'id' | 'ts'>): Promise<AuditEntry> {
		const id = `audit_${crypto.randomUUID()}`
		const ts = new Date().toISOString()
		await this.sql`
			INSERT INTO audit_log (
				id, ts, actor_user_id, room_id, run_id, action, result,
				subscription_id, established_by_user_id, trace_id, details
			) VALUES (
				${id}, ${ts}, ${entry.actor_user_id}, ${entry.room_id}, ${entry.run_id ?? null},
				${entry.action}, ${entry.result},
				${entry.subscription_id ?? null}, ${entry.established_by_user_id ?? null},
				${entry.trace_id},
				${this.sql.json(entry.details as never)}
			)
		`
		return { id, ts, ...entry }
	}

	async queryByRun(run_id: RunId, opts: { limit?: number } = {}): Promise<readonly AuditEntry[]> {
		const limit = opts.limit ?? 1000
		const rows = await this.sql<AuditRow[]>`
			SELECT * FROM audit_log
			 WHERE run_id = ${run_id}
			 ORDER BY ts DESC
			 LIMIT ${limit}
		`
		return rows.map(rowToEntry)
	}

	async queryByUser(
		user_id: UserId,
		opts: { limit?: number } = {}
	): Promise<readonly AuditEntry[]> {
		const limit = opts.limit ?? 1000
		const rows = await this.sql<AuditRow[]>`
			SELECT * FROM audit_log
			 WHERE actor_user_id = ${user_id}
			 ORDER BY ts DESC
			 LIMIT ${limit}
		`
		return rows.map(rowToEntry)
	}

	async queryByRoom(
		room_id: RoomId,
		opts: { limit?: number } = {}
	): Promise<readonly AuditEntry[]> {
		const limit = opts.limit ?? 1000
		const rows = await this.sql<AuditRow[]>`
			SELECT * FROM audit_log
			 WHERE room_id = ${room_id}
			 ORDER BY ts DESC
			 LIMIT ${limit}
		`
		return rows.map(rowToEntry)
	}
}

interface AuditRow {
	id: string
	ts: string
	actor_user_id: string
	room_id: string
	run_id: string | null
	action: string
	result: string
	subscription_id: string | null
	established_by_user_id: string | null
	trace_id: string
	details: Record<string, unknown>
}

function rowToEntry(row: AuditRow): AuditEntry {
	return {
		id: row.id,
		ts: row.ts,
		actor_user_id: row.actor_user_id as UserId,
		room_id: row.room_id as RoomId,
		run_id: row.run_id as RunId | null,
		action: row.action,
		result: row.result as AuditEntry['result'],
		...(row.subscription_id !== null && { subscription_id: row.subscription_id }),
		...(row.established_by_user_id !== null && {
			established_by_user_id: row.established_by_user_id as UserId,
		}),
		trace_id: row.trace_id,
		details: row.details,
	}
}
