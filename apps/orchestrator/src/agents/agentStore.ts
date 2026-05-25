/**
 * AgentStore — persistence layer for AgentRecord.
 *
 * Two implementations:
 *
 *   InMemoryAgentStore   single-process Map. Tests and local dev.
 *   PostgresAgentStore   the `agents` table from migration 003.
 *
 * The interface is async on both so callers do not need to branch
 * by backend. Pure CRUD; no business logic. Validation lives in
 * `agentRecord.validateCreateInput` and runs at the API layer before
 * the store is touched, so the store never sees a malformed record.
 *
 * Soft delete: `archive(id)` flips `archived_at` and the list /
 * fetch methods filter archived rows out by default. `unarchive(id)`
 * brings one back. We never hard-delete because audit_log references
 * the id forever.
 */

import { randomUUID } from 'node:crypto'
import type { SqlClient } from '../postgres/client.js'
import {
	type AgentId,
	type AgentRecord,
	AgentNotFoundError,
	type CreateAgentInput,
	type UpdateAgentInput,
	type WorkspaceId,
} from './agentRecord.js'

export interface AgentStore {
	create(input: CreateAgentInput): Promise<AgentRecord>
	get(id: AgentId): Promise<AgentRecord | null>
	listByWorkspace(workspace_id: WorkspaceId): Promise<readonly AgentRecord[]>
	update(id: AgentId, patch: UpdateAgentInput): Promise<AgentRecord>
	archive(id: AgentId): Promise<void>
	unarchive(id: AgentId): Promise<void>
}

/* -------------------------------------------------------------- *
 * In-memory implementation                                       *
 * -------------------------------------------------------------- */

export class InMemoryAgentStore implements AgentStore {
	private readonly byId = new Map<AgentId, AgentRecord>()

	async create(input: CreateAgentInput): Promise<AgentRecord> {
		const now = new Date().toISOString()
		const id = `ag_${randomUUID()}` as AgentId
		const record: AgentRecord = {
			id,
			workspace_id: input.workspace_id,
			owner_user_id: input.owner_user_id,
			name: input.name,
			purpose: input.purpose,
			model: input.model,
			system_prompt: input.system_prompt,
			capabilities: input.capabilities,
			created_at: now,
			updated_at: now,
			archived_at: null,
		}
		this.byId.set(id, record)
		return record
	}

	async get(id: AgentId): Promise<AgentRecord | null> {
		const r = this.byId.get(id)
		return r && r.archived_at === null ? r : null
	}

	async listByWorkspace(workspace_id: WorkspaceId): Promise<readonly AgentRecord[]> {
		const out: AgentRecord[] = []
		for (const r of this.byId.values()) {
			if (r.workspace_id === workspace_id && r.archived_at === null) {
				out.push(r)
			}
		}
		// Newest first so the canvas LeftRail shows recent work at the top.
		out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
		return out
	}

	async update(id: AgentId, patch: UpdateAgentInput): Promise<AgentRecord> {
		const r = this.byId.get(id)
		if (!r || r.archived_at !== null) throw new AgentNotFoundError(id)
		const next: AgentRecord = {
			...r,
			...patch,
			updated_at: new Date().toISOString(),
		}
		this.byId.set(id, next)
		return next
	}

	async archive(id: AgentId): Promise<void> {
		const r = this.byId.get(id)
		if (!r) throw new AgentNotFoundError(id)
		this.byId.set(id, { ...r, archived_at: new Date().toISOString() })
	}

	async unarchive(id: AgentId): Promise<void> {
		const r = this.byId.get(id)
		if (!r) throw new AgentNotFoundError(id)
		this.byId.set(id, { ...r, archived_at: null })
	}
}

/* -------------------------------------------------------------- *
 * Postgres implementation                                        *
 * -------------------------------------------------------------- */

interface AgentRow {
	id: string
	workspace_id: string
	owner_user_id: string
	name: string
	purpose: string
	model: string
	system_prompt: string
	cap_computer_use: boolean
	cap_computer_use_provider: string
	cap_browser_use: boolean
	cap_browser_use_persist: boolean
	cap_mcp_servers: unknown
	created_at: Date
	updated_at: Date
	archived_at: Date | null
}

function rowToRecord(row: AgentRow): AgentRecord {
	return {
		id: row.id as AgentId,
		workspace_id: row.workspace_id as WorkspaceId,
		owner_user_id: row.owner_user_id as AgentRecord['owner_user_id'],
		name: row.name,
		purpose: row.purpose,
		model: row.model as AgentRecord['model'],
		system_prompt: row.system_prompt,
		capabilities: {
			computer_use: {
				enabled: row.cap_computer_use,
				provider: row.cap_computer_use_provider as 'e2b' | 'browserbase' | 'none',
			},
			browser_use: {
				enabled: row.cap_browser_use,
				persist_cookies: row.cap_browser_use_persist,
			},
			mcp_servers: (Array.isArray(row.cap_mcp_servers)
				? (row.cap_mcp_servers as AgentRecord['capabilities']['mcp_servers'])
				: []),
		},
		created_at: row.created_at.toISOString(),
		updated_at: row.updated_at.toISOString(),
		archived_at: row.archived_at ? row.archived_at.toISOString() : null,
	}
}

export class PostgresAgentStore implements AgentStore {
	constructor(private readonly sql: SqlClient) {}

	async create(input: CreateAgentInput): Promise<AgentRecord> {
		const id = `ag_${randomUUID()}`
		const rows = await this.sql<AgentRow[]>`
			INSERT INTO agents (
				id, workspace_id, owner_user_id, name, purpose, model, system_prompt,
				cap_computer_use, cap_computer_use_provider,
				cap_browser_use, cap_browser_use_persist,
				cap_mcp_servers
			) VALUES (
				${id},
				${input.workspace_id},
				${input.owner_user_id},
				${input.name},
				${input.purpose},
				${input.model},
				${input.system_prompt},
				${input.capabilities.computer_use.enabled},
				${input.capabilities.computer_use.provider},
				${input.capabilities.browser_use.enabled},
				${input.capabilities.browser_use.persist_cookies},
				${this.sql.json(input.capabilities.mcp_servers as never)}
			)
			RETURNING *
		`
		return rowToRecord(rows[0]!)
	}

	async get(id: AgentId): Promise<AgentRecord | null> {
		const rows = await this.sql<AgentRow[]>`
			SELECT * FROM agents WHERE id = ${id} AND archived_at IS NULL LIMIT 1
		`
		return rows[0] ? rowToRecord(rows[0]) : null
	}

	async listByWorkspace(workspace_id: WorkspaceId): Promise<readonly AgentRecord[]> {
		const rows = await this.sql<AgentRow[]>`
			SELECT * FROM agents
			WHERE workspace_id = ${workspace_id} AND archived_at IS NULL
			ORDER BY created_at DESC
		`
		return rows.map(rowToRecord)
	}

	async update(id: AgentId, patch: UpdateAgentInput): Promise<AgentRecord> {
		// Build the SET clause dynamically. Each field can be present
		// individually so we cannot use a single VALUES tuple. The
		// tagged-template `sql` API supports per-call interpolation;
		// we issue a single UPDATE with every field in the patch.
		const caps = patch.capabilities
		const rows = await this.sql<AgentRow[]>`
			UPDATE agents SET
				name           = COALESCE(${patch.name ?? null}, name),
				purpose        = COALESCE(${patch.purpose ?? null}, purpose),
				model          = COALESCE(${patch.model ?? null}, model),
				system_prompt  = COALESCE(${patch.system_prompt ?? null}, system_prompt),
				cap_computer_use          = COALESCE(${caps?.computer_use.enabled ?? null}, cap_computer_use),
				cap_computer_use_provider = COALESCE(${caps?.computer_use.provider ?? null}, cap_computer_use_provider),
				cap_browser_use           = COALESCE(${caps?.browser_use.enabled ?? null}, cap_browser_use),
				cap_browser_use_persist   = COALESCE(${caps?.browser_use.persist_cookies ?? null}, cap_browser_use_persist),
				cap_mcp_servers           = COALESCE(${caps ? this.sql.json(caps.mcp_servers as never) : null}, cap_mcp_servers),
				updated_at     = now()
			WHERE id = ${id} AND archived_at IS NULL
			RETURNING *
		`
		if (rows.length === 0) throw new AgentNotFoundError(id)
		return rowToRecord(rows[0]!)
	}

	async archive(id: AgentId): Promise<void> {
		const res = await this.sql`
			UPDATE agents SET archived_at = now() WHERE id = ${id} AND archived_at IS NULL
		`
		if (res.count === 0) throw new AgentNotFoundError(id)
	}

	async unarchive(id: AgentId): Promise<void> {
		const res = await this.sql`
			UPDATE agents SET archived_at = NULL WHERE id = ${id}
		`
		if (res.count === 0) throw new AgentNotFoundError(id)
	}
}
