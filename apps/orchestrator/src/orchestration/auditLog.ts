/**
 * AuditLog — durable forensic record per run.
 *
 * Decision 8.1: the canvas projection is lossy by design (7.1
 * truncation); the audit log is the only complete record. Everything
 * that affects authz, money, or external systems writes here.
 *
 * Schema is intentionally narrow: actor, room, run, action, result,
 * trace_id, optional subscription provenance, free-form details. Each
 * row is append-only.
 */

import type { AuditEntry, RoomId, RunId, UserId } from '@agent-canvas/orchestrator-types'

export interface AuditLog {
	record(entry: Omit<AuditEntry, 'id' | 'ts'>): Promise<AuditEntry>
	queryByRun(run_id: RunId, opts?: { limit?: number }): Promise<readonly AuditEntry[]>
	queryByUser(user_id: UserId, opts?: { limit?: number }): Promise<readonly AuditEntry[]>
	queryByRoom(room_id: RoomId, opts?: { limit?: number }): Promise<readonly AuditEntry[]>
}

export class InMemoryAuditLog implements AuditLog {
	private readonly rows: AuditEntry[] = []
	private nextId = 1

	async record(entry: Omit<AuditEntry, 'id' | 'ts'>): Promise<AuditEntry> {
		const full: AuditEntry = {
			id: `audit_${this.nextId++}`,
			ts: new Date().toISOString(),
			...entry,
		}
		this.rows.push(full)
		return full
	}

	async queryByRun(run_id: RunId, opts: { limit?: number } = {}): Promise<readonly AuditEntry[]> {
		return limit(this.rows.filter((r) => r.run_id === run_id), opts.limit)
	}

	async queryByUser(user_id: UserId, opts: { limit?: number } = {}): Promise<readonly AuditEntry[]> {
		return limit(this.rows.filter((r) => r.actor_user_id === user_id), opts.limit)
	}

	async queryByRoom(room_id: RoomId, opts: { limit?: number } = {}): Promise<readonly AuditEntry[]> {
		return limit(this.rows.filter((r) => r.room_id === room_id), opts.limit)
	}
}

function limit<T>(rows: readonly T[], n: number | undefined): readonly T[] {
	if (n === undefined) return rows
	return rows.slice(0, n)
}
