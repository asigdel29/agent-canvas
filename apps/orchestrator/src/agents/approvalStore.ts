/**
 * ApprovalStore — persistence for pending approvals.
 *
 * Two implementations: InMemory for tests/dev, Postgres for
 * production. The interface is async; the table is the one created
 * by migration 003 (`pending_approvals`).
 *
 * Lifecycle:
 *   - The run loop calls `request(...)` when it hits a destructive
 *     or irreversible tool. The store writes a row, returns the
 *     fresh ApprovalId, and the loop blocks on a future associated
 *     with that id.
 *   - The operator UI calls `resolve(id, decision)` from the
 *     /api/approvals/:id/approve|reject route. The store updates
 *     the row AND fires the waiter so the loop unblocks.
 *   - If the orchestrator restarts mid-wait, the future is lost.
 *     `recoverPending(runId)` returns rows still awaiting decision
 *     so a restart can either re-wire waiters (single-instance) or
 *     surface them to the operator (multi-instance — the operator
 *     re-decides through any instance, and resolve() polls the row
 *     before declaring the wait abandoned).
 * @author asigdel29
 */

import { randomUUID } from 'node:crypto'
import type { UserId } from '@agent-canvas/orchestrator-types'

import type { AgentId, ApprovalId, PendingApproval } from './agentRecord.js'
import type { SqlClient } from '../postgres/client.js'

export interface ApprovalRequestInput {
	readonly agent_id: AgentId
	readonly run_id: string
	readonly tool_name: string
	readonly tool_input: Readonly<Record<string, unknown>>
	readonly tool_description: string
	readonly safety: 'destructive' | 'irreversible'
}

export interface ApprovalStore {
	request(input: ApprovalRequestInput): Promise<PendingApproval>
	get(id: ApprovalId): Promise<PendingApproval | null>
	listPending(): Promise<readonly PendingApproval[]>
	listPendingForRun(run_id: string): Promise<readonly PendingApproval[]>
	resolve(
		id: ApprovalId,
		decision: { resolution: 'approved' | 'rejected'; resolved_by_user_id: UserId }
	): Promise<PendingApproval>
}

/* -------------------------------------------------------------- *
 * In-memory                                                       *
 * -------------------------------------------------------------- */

export class InMemoryApprovalStore implements ApprovalStore {
	private readonly byId = new Map<ApprovalId, PendingApproval>()

	async request(input: ApprovalRequestInput): Promise<PendingApproval> {
		const id = `apv_${randomUUID()}` as ApprovalId
		const row: PendingApproval = {
			id,
			agent_id: input.agent_id,
			run_id: input.run_id,
			tool_name: input.tool_name,
			tool_input: input.tool_input,
			tool_description: input.tool_description,
			safety: input.safety,
			requested_at: new Date().toISOString(),
			resolved_at: null,
			resolved_by_user_id: null,
			resolution: null,
		}
		this.byId.set(id, row)
		return row
	}

	async get(id: ApprovalId): Promise<PendingApproval | null> {
		return this.byId.get(id) ?? null
	}

	async listPending(): Promise<readonly PendingApproval[]> {
		return Array.from(this.byId.values()).filter((r) => r.resolved_at === null)
	}

	async listPendingForRun(run_id: string): Promise<readonly PendingApproval[]> {
		return Array.from(this.byId.values()).filter(
			(r) => r.run_id === run_id && r.resolved_at === null
		)
	}

	async resolve(
		id: ApprovalId,
		decision: { resolution: 'approved' | 'rejected'; resolved_by_user_id: UserId }
	): Promise<PendingApproval> {
		const r = this.byId.get(id)
		if (!r) throw new Error(`approval ${id} not found`)
		if (r.resolved_at !== null) return r // idempotent
		const next: PendingApproval = {
			...r,
			resolved_at: new Date().toISOString(),
			resolved_by_user_id: decision.resolved_by_user_id,
			resolution: decision.resolution,
		}
		this.byId.set(id, next)
		return next
	}
}

/* -------------------------------------------------------------- *
 * Postgres                                                        *
 * -------------------------------------------------------------- */

interface ApprovalRow {
	id: string
	agent_id: string
	run_id: string
	tool_name: string
	tool_input: unknown
	tool_description: string
	safety: 'destructive' | 'irreversible'
	requested_at: Date
	resolved_at: Date | null
	resolved_by_user_id: string | null
	resolution: 'approved' | 'rejected' | null
}

function rowToRecord(row: ApprovalRow): PendingApproval {
	return {
		id: row.id as ApprovalId,
		agent_id: row.agent_id as AgentId,
		run_id: row.run_id,
		tool_name: row.tool_name,
		tool_input: (row.tool_input ?? {}) as Readonly<Record<string, unknown>>,
		tool_description: row.tool_description,
		safety: row.safety,
		requested_at: row.requested_at.toISOString(),
		resolved_at: row.resolved_at ? row.resolved_at.toISOString() : null,
		resolved_by_user_id: row.resolved_by_user_id as UserId | null,
		resolution: row.resolution,
	}
}

export class PostgresApprovalStore implements ApprovalStore {
	constructor(private readonly sql: SqlClient) {}

	async request(input: ApprovalRequestInput): Promise<PendingApproval> {
		const id = `apv_${randomUUID()}`
		const rows = await this.sql<ApprovalRow[]>`
			INSERT INTO pending_approvals (
				id, agent_id, run_id, tool_name, tool_input, tool_description, safety
			) VALUES (
				${id},
				${input.agent_id},
				${input.run_id},
				${input.tool_name},
				${this.sql.json(input.tool_input as never)},
				${input.tool_description},
				${input.safety}
			)
			RETURNING *
		`
		return rowToRecord(rows[0]!)
	}

	async get(id: ApprovalId): Promise<PendingApproval | null> {
		const rows = await this.sql<ApprovalRow[]>`
			SELECT * FROM pending_approvals WHERE id = ${id} LIMIT 1
		`
		return rows[0] ? rowToRecord(rows[0]) : null
	}

	async listPending(): Promise<readonly PendingApproval[]> {
		const rows = await this.sql<ApprovalRow[]>`
			SELECT * FROM pending_approvals
			WHERE resolved_at IS NULL
			ORDER BY requested_at ASC
		`
		return rows.map(rowToRecord)
	}

	async listPendingForRun(run_id: string): Promise<readonly PendingApproval[]> {
		const rows = await this.sql<ApprovalRow[]>`
			SELECT * FROM pending_approvals
			WHERE run_id = ${run_id} AND resolved_at IS NULL
			ORDER BY requested_at ASC
		`
		return rows.map(rowToRecord)
	}

	async resolve(
		id: ApprovalId,
		decision: { resolution: 'approved' | 'rejected'; resolved_by_user_id: UserId }
	): Promise<PendingApproval> {
		// Idempotent: a second resolve on a row that is already resolved
		// returns the existing row unchanged. The WHERE filters on
		// resolved_at IS NULL so a race between two operators only
		// records the first decision.
		const rows = await this.sql<ApprovalRow[]>`
			UPDATE pending_approvals SET
				resolved_at         = now(),
				resolution          = ${decision.resolution},
				resolved_by_user_id = ${decision.resolved_by_user_id}
			WHERE id = ${id} AND resolved_at IS NULL
			RETURNING *
		`
		if (rows.length > 0) return rowToRecord(rows[0]!)
		// Already resolved or missing — return the current row so the
		// caller can confirm what won the race.
		const current = await this.get(id)
		if (!current) throw new Error(`approval ${id} not found`)
		return current
	}
}
