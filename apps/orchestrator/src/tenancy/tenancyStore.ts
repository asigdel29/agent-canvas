/**
 * TenancyStore — users + workspaces + memberships, behind a
 * single interface so the API routes don't have to coordinate
 * three separate handles.
 *
 * Two implementations:
 *   InMemoryTenancyStore   tests + dev without DATABASE_URL
 *   PostgresTenancyStore   production
 *
 * Critical operations:
 *   upsertGithubUser(...)            idempotent landing for OAuth
 *   listWorkspacesForUser(user_id)   what the user can see
 *   ensureSoloWorkspace(user_id, name)  first-login auto-create
 *   getMembership(user_id, workspace_id)  the gate the API checks
 *   requireMembership(..., minRole)  throws TenancyForbiddenError
 *
 * Idempotency:
 *   - upsertGithubUser updates an existing row's email/name/
 *     last_seen_at when the github_id already exists
 *   - ensureSoloWorkspace is no-op when the user already has any
 *     workspace where they are owner
 *   - all three are safe to call on every login
 */

import { randomUUID } from 'node:crypto'
import type { UserId } from '@agent-canvas/orchestrator-types'

import type { SqlClient } from '../postgres/client.js'
import {
	type GitHubUserUpsert,
	type MembershipRecord,
	roleAtLeast,
	type UserRecord,
	type WorkspaceId,
	type WorkspaceRecord,
	type WorkspaceRole,
	TenancyForbiddenError,
	TenancyNotFoundError,
} from './tenancyTypes.js'

export interface WorkspaceListEntry {
	readonly workspace: WorkspaceRecord
	readonly role: WorkspaceRole
}

export interface TenancyStore {
	upsertGithubUser(input: GitHubUserUpsert): Promise<UserRecord>
	getUser(id: UserId): Promise<UserRecord | null>

	createWorkspace(name: string, owner_user_id: UserId): Promise<WorkspaceRecord>
	getWorkspace(id: WorkspaceId): Promise<WorkspaceRecord | null>
	listWorkspacesForUser(user_id: UserId): Promise<readonly WorkspaceListEntry[]>
	ensureSoloWorkspace(
		user_id: UserId,
		name: string
	): Promise<WorkspaceRecord>

	getMembership(
		user_id: UserId,
		workspace_id: WorkspaceId
	): Promise<MembershipRecord | null>
	addMember(
		workspace_id: WorkspaceId,
		user_id: UserId,
		role: WorkspaceRole
	): Promise<MembershipRecord>

	/**
	 * Throws TenancyForbiddenError when the user is not a member at
	 * or above the required role. Used by every workspace-scoped
	 * route to enforce membership in one line.
	 */
	requireMembership(
		user_id: UserId,
		workspace_id: WorkspaceId,
		minRole: WorkspaceRole
	): Promise<MembershipRecord>
}

/* -------------------------------------------------------------- *
 * In-memory                                                       *
 * -------------------------------------------------------------- */

export class InMemoryTenancyStore implements TenancyStore {
	private readonly users = new Map<UserId, UserRecord>()
	private readonly usersByGithubId = new Map<string, UserId>()
	private readonly workspaces = new Map<WorkspaceId, WorkspaceRecord>()
	private readonly memberships = new Map<string, MembershipRecord>()

	private membershipKey(u: UserId, w: WorkspaceId): string {
		return `${w}:${u}`
	}

	async upsertGithubUser(input: GitHubUserUpsert): Promise<UserRecord> {
		const existingId = this.usersByGithubId.get(input.github_id)
		const now = new Date().toISOString()
		if (existingId) {
			const existing = this.users.get(existingId)!
			const next: UserRecord = {
				...existing,
				email: input.email ?? existing.email,
				name: input.name ?? existing.name,
				github_login: input.github_login,
				last_seen_at: now,
			}
			this.users.set(existingId, next)
			return next
		}
		const id = `gh:${input.github_id}` as UserId
		const record: UserRecord = {
			id,
			github_id: input.github_id,
			github_login: input.github_login,
			email: input.email,
			name: input.name,
			created_at: now,
			last_seen_at: now,
		}
		this.users.set(id, record)
		this.usersByGithubId.set(input.github_id, id)
		return record
	}

	async getUser(id: UserId): Promise<UserRecord | null> {
		return this.users.get(id) ?? null
	}

	async createWorkspace(name: string, owner_user_id: UserId): Promise<WorkspaceRecord> {
		if (!(await this.getUser(owner_user_id))) {
			throw new TenancyNotFoundError(`user ${owner_user_id}`)
		}
		const id = `ws_${randomUUID()}` as WorkspaceId
		const now = new Date().toISOString()
		const ws: WorkspaceRecord = {
			id,
			name,
			owner_user_id,
			created_at: now,
			archived_at: null,
		}
		this.workspaces.set(id, ws)
		await this.addMember(id, owner_user_id, 'owner')
		return ws
	}

	async getWorkspace(id: WorkspaceId): Promise<WorkspaceRecord | null> {
		const w = this.workspaces.get(id)
		if (!w || w.archived_at !== null) return null
		return w
	}

	async listWorkspacesForUser(user_id: UserId): Promise<readonly WorkspaceListEntry[]> {
		const out: WorkspaceListEntry[] = []
		for (const m of this.memberships.values()) {
			if (m.user_id !== user_id) continue
			const w = this.workspaces.get(m.workspace_id)
			if (!w || w.archived_at !== null) continue
			out.push({ workspace: w, role: m.role })
		}
		out.sort((a, b) =>
			a.workspace.created_at < b.workspace.created_at ? 1 : -1
		)
		return out
	}

	async ensureSoloWorkspace(
		user_id: UserId,
		name: string
	): Promise<WorkspaceRecord> {
		const list = await this.listWorkspacesForUser(user_id)
		const owned = list.find((e) => e.role === 'owner')
		if (owned) return owned.workspace
		return this.createWorkspace(name, user_id)
	}

	async getMembership(
		user_id: UserId,
		workspace_id: WorkspaceId
	): Promise<MembershipRecord | null> {
		return this.memberships.get(this.membershipKey(user_id, workspace_id)) ?? null
	}

	async addMember(
		workspace_id: WorkspaceId,
		user_id: UserId,
		role: WorkspaceRole
	): Promise<MembershipRecord> {
		if (!(await this.getWorkspace(workspace_id))) {
			throw new TenancyNotFoundError(`workspace ${workspace_id}`)
		}
		if (!(await this.getUser(user_id))) {
			throw new TenancyNotFoundError(`user ${user_id}`)
		}
		const m: MembershipRecord = {
			workspace_id,
			user_id,
			role,
			joined_at: new Date().toISOString(),
		}
		this.memberships.set(this.membershipKey(user_id, workspace_id), m)
		return m
	}

	async requireMembership(
		user_id: UserId,
		workspace_id: WorkspaceId,
		minRole: WorkspaceRole
	): Promise<MembershipRecord> {
		const m = await this.getMembership(user_id, workspace_id)
		if (!m) throw new TenancyForbiddenError(user_id, workspace_id, minRole)
		if (!roleAtLeast(m.role, minRole)) {
			throw new TenancyForbiddenError(user_id, workspace_id, minRole)
		}
		return m
	}
}

/* -------------------------------------------------------------- *
 * Postgres                                                        *
 * -------------------------------------------------------------- */

interface UserRow {
	id: string
	github_id: string | null
	github_login: string | null
	email: string | null
	name: string | null
	created_at: Date
	last_seen_at: Date
}
interface WorkspaceRow {
	id: string
	name: string
	owner_user_id: string
	created_at: Date
	archived_at: Date | null
}
interface MembershipRow {
	workspace_id: string
	user_id: string
	role: WorkspaceRole
	joined_at: Date
}

function userRowToRecord(row: UserRow): UserRecord {
	return {
		id: row.id as UserId,
		github_id: row.github_id,
		github_login: row.github_login,
		email: row.email,
		name: row.name,
		created_at: row.created_at.toISOString(),
		last_seen_at: row.last_seen_at.toISOString(),
	}
}
function workspaceRowToRecord(row: WorkspaceRow): WorkspaceRecord {
	return {
		id: row.id as WorkspaceId,
		name: row.name,
		owner_user_id: row.owner_user_id as UserId,
		created_at: row.created_at.toISOString(),
		archived_at: row.archived_at ? row.archived_at.toISOString() : null,
	}
}
function membershipRowToRecord(row: MembershipRow): MembershipRecord {
	return {
		workspace_id: row.workspace_id as WorkspaceId,
		user_id: row.user_id as UserId,
		role: row.role,
		joined_at: row.joined_at.toISOString(),
	}
}

export class PostgresTenancyStore implements TenancyStore {
	constructor(private readonly sql: SqlClient) {}

	async upsertGithubUser(input: GitHubUserUpsert): Promise<UserRecord> {
		const id = `gh:${input.github_id}`
		const rows = await this.sql<UserRow[]>`
			INSERT INTO users (id, github_id, github_login, email, name)
			VALUES (${id}, ${input.github_id}, ${input.github_login}, ${input.email}, ${input.name})
			ON CONFLICT (id) DO UPDATE SET
				github_login = EXCLUDED.github_login,
				email        = COALESCE(EXCLUDED.email, users.email),
				name         = COALESCE(EXCLUDED.name,  users.name),
				last_seen_at = now()
			RETURNING *
		`
		return userRowToRecord(rows[0]!)
	}

	async getUser(id: UserId): Promise<UserRecord | null> {
		const rows = await this.sql<UserRow[]>`
			SELECT * FROM users WHERE id = ${id} LIMIT 1
		`
		return rows[0] ? userRowToRecord(rows[0]) : null
	}

	async createWorkspace(name: string, owner_user_id: UserId): Promise<WorkspaceRecord> {
		const id = `ws_${randomUUID()}`
		const result = await this.sql.begin(async (tx) => {
			const ws = await tx<WorkspaceRow[]>`
				INSERT INTO workspaces (id, name, owner_user_id)
				VALUES (${id}, ${name}, ${owner_user_id})
				RETURNING *
			`
			await tx`
				INSERT INTO workspace_members (workspace_id, user_id, role)
				VALUES (${id}, ${owner_user_id}, 'owner')
			`
			return ws[0]!
		})
		return workspaceRowToRecord(result)
	}

	async getWorkspace(id: WorkspaceId): Promise<WorkspaceRecord | null> {
		const rows = await this.sql<WorkspaceRow[]>`
			SELECT * FROM workspaces WHERE id = ${id} AND archived_at IS NULL LIMIT 1
		`
		return rows[0] ? workspaceRowToRecord(rows[0]) : null
	}

	async listWorkspacesForUser(user_id: UserId): Promise<readonly WorkspaceListEntry[]> {
		const rows = await this.sql<(WorkspaceRow & { role: WorkspaceRole })[]>`
			SELECT w.*, m.role
			FROM workspaces w
			JOIN workspace_members m ON m.workspace_id = w.id
			WHERE m.user_id = ${user_id} AND w.archived_at IS NULL
			ORDER BY w.created_at DESC
		`
		return rows.map((r) => ({
			workspace: workspaceRowToRecord(r),
			role: r.role,
		}))
	}

	async ensureSoloWorkspace(
		user_id: UserId,
		name: string
	): Promise<WorkspaceRecord> {
		const list = await this.listWorkspacesForUser(user_id)
		const owned = list.find((e) => e.role === 'owner')
		if (owned) return owned.workspace
		return this.createWorkspace(name, user_id)
	}

	async getMembership(
		user_id: UserId,
		workspace_id: WorkspaceId
	): Promise<MembershipRecord | null> {
		const rows = await this.sql<MembershipRow[]>`
			SELECT * FROM workspace_members
			WHERE user_id = ${user_id} AND workspace_id = ${workspace_id}
			LIMIT 1
		`
		return rows[0] ? membershipRowToRecord(rows[0]) : null
	}

	async addMember(
		workspace_id: WorkspaceId,
		user_id: UserId,
		role: WorkspaceRole
	): Promise<MembershipRecord> {
		const rows = await this.sql<MembershipRow[]>`
			INSERT INTO workspace_members (workspace_id, user_id, role)
			VALUES (${workspace_id}, ${user_id}, ${role})
			ON CONFLICT (workspace_id, user_id) DO UPDATE
				SET role = EXCLUDED.role
			RETURNING *
		`
		return membershipRowToRecord(rows[0]!)
	}

	async requireMembership(
		user_id: UserId,
		workspace_id: WorkspaceId,
		minRole: WorkspaceRole
	): Promise<MembershipRecord> {
		const m = await this.getMembership(user_id, workspace_id)
		if (!m) throw new TenancyForbiddenError(user_id, workspace_id, minRole)
		if (!roleAtLeast(m.role, minRole)) {
			throw new TenancyForbiddenError(user_id, workspace_id, minRole)
		}
		return m
	}
}
