/**
 * workspaceAuditStore — append + query the workspace admin trail.
 *
 * append() is fire-and-forget at the call site: a route handler
 * records the event after the primary write succeeds, but should
 * never have its response blocked by audit-write latency. Callers
 * wrap in void/Promise.resolve as they prefer.
 *
 * query() carries time-range, actor, action, and limit filters. The
 * API surface validates and clamps the limit; the store accepts
 * whatever the caller passes.
 *
 * Ordering: most recent first. Both adapters return the same
 * pre-sorted shape so a paginating client can use the last row's
 * created_at as a cursor (P7 ships keyset pagination as a deferred
 * follow-up; for foundation, limit+offset is fine).
 * @author asigdel29
 */

import { randomUUID } from 'node:crypto'

import type { UserId } from '@agent-canvas/orchestrator-types'
import type { SqlClient } from '../postgres/client.js'
import type { WorkspaceId } from '../tenancy/tenancyTypes.js'
import type { WorkspaceAuditAction, WorkspaceAuditTargetType } from './auditActions.js'

export interface WorkspaceAuditEvent {
	readonly id: string
	readonly workspace_id: WorkspaceId
	readonly actor_user_id: UserId
	readonly action: WorkspaceAuditAction
	readonly target_type: WorkspaceAuditTargetType
	readonly target_id: string | null
	readonly details: Record<string, unknown>
	readonly created_at: string
}

export interface AppendInput {
	readonly workspace_id: WorkspaceId
	readonly actor_user_id: UserId
	readonly action: WorkspaceAuditAction
	readonly target_type: WorkspaceAuditTargetType
	readonly target_id?: string | null
	readonly details?: Record<string, unknown>
}

export interface QueryInput {
	readonly workspace_id: WorkspaceId
	readonly since?: string | null
	readonly until?: string | null
	readonly actor_user_id?: UserId | null
	readonly action?: WorkspaceAuditAction | null
	readonly limit?: number
}

export interface WorkspaceAuditStore {
	append(input: AppendInput): Promise<WorkspaceAuditEvent>
	query(input: QueryInput): Promise<readonly WorkspaceAuditEvent[]>
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

export function clampLimit(n: number | undefined): number {
	if (n === undefined || !Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
	return Math.min(MAX_LIMIT, Math.floor(n))
}

/* -------------------------------------------------------------- *
 * In-memory                                                       *
 * -------------------------------------------------------------- */

export class InMemoryWorkspaceAuditStore implements WorkspaceAuditStore {
	private readonly rows: WorkspaceAuditEvent[] = []

	async append(input: AppendInput): Promise<WorkspaceAuditEvent> {
		const event: WorkspaceAuditEvent = {
			id: `wae_${randomUUID()}`,
			workspace_id: input.workspace_id,
			actor_user_id: input.actor_user_id,
			action: input.action,
			target_type: input.target_type,
			target_id: input.target_id ?? null,
			details: input.details ?? {},
			created_at: new Date().toISOString(),
		}
		this.rows.push(event)
		return event
	}

	async query(input: QueryInput): Promise<readonly WorkspaceAuditEvent[]> {
		const lim = clampLimit(input.limit)
		const sinceMs = input.since ? Date.parse(input.since) : null
		const untilMs = input.until ? Date.parse(input.until) : null
		const out: WorkspaceAuditEvent[] = []
		for (const r of this.rows) {
			if (r.workspace_id !== input.workspace_id) continue
			if (input.actor_user_id && r.actor_user_id !== input.actor_user_id) continue
			if (input.action && r.action !== input.action) continue
			const tsMs = Date.parse(r.created_at)
			if (sinceMs !== null && tsMs < sinceMs) continue
			if (untilMs !== null && tsMs > untilMs) continue
			out.push(r)
		}
		out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
		return out.slice(0, lim)
	}
}

/* -------------------------------------------------------------- *
 * Postgres                                                        *
 * -------------------------------------------------------------- */

interface AuditRow {
	id: string
	workspace_id: string
	actor_user_id: string
	action: string
	target_type: string
	target_id: string | null
	details: Record<string, unknown>
	created_at: Date
}

function rowToEvent(row: AuditRow): WorkspaceAuditEvent {
	return {
		id: row.id,
		workspace_id: row.workspace_id as WorkspaceId,
		actor_user_id: row.actor_user_id as UserId,
		action: row.action as WorkspaceAuditAction,
		target_type: row.target_type as WorkspaceAuditTargetType,
		target_id: row.target_id,
		details: row.details,
		created_at: row.created_at.toISOString(),
	}
}

export class PostgresWorkspaceAuditStore implements WorkspaceAuditStore {
	constructor(private readonly sql: SqlClient) {}

	async append(input: AppendInput): Promise<WorkspaceAuditEvent> {
		const id = `wae_${randomUUID()}`
		const rows = await this.sql<AuditRow[]>`
			INSERT INTO workspace_audit_events (
				id, workspace_id, actor_user_id, action, target_type, target_id, details
			) VALUES (
				${id},
				${input.workspace_id},
				${input.actor_user_id},
				${input.action},
				${input.target_type},
				${input.target_id ?? null},
				${this.sql.json((input.details ?? {}) as never)}
			)
			RETURNING *
		`
		return rowToEvent(rows[0]!)
	}

	async query(input: QueryInput): Promise<readonly WorkspaceAuditEvent[]> {
		const lim = clampLimit(input.limit)
		// One SQL statement; nullable filters collapse to TRUE when the
		// corresponding parameter is null, so the query plan stays
		// stable regardless of which filters the caller supplies.
		const rows = await this.sql<AuditRow[]>`
			SELECT * FROM workspace_audit_events
			WHERE workspace_id = ${input.workspace_id}
			  AND (${input.since ?? null}::timestamptz IS NULL OR created_at >= ${input.since ?? null}::timestamptz)
			  AND (${input.until ?? null}::timestamptz IS NULL OR created_at <= ${input.until ?? null}::timestamptz)
			  AND (${input.actor_user_id ?? null}::text IS NULL OR actor_user_id = ${input.actor_user_id ?? null}::text)
			  AND (${input.action ?? null}::text IS NULL OR action = ${input.action ?? null}::text)
			ORDER BY created_at DESC
			LIMIT ${lim}
		`
		return rows.map(rowToEvent)
	}
}
