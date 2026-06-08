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
 * @author asigdel29
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { UserId } from '@agent-canvas/orchestrator-types'

import type { SqlClient } from '../postgres/client.js'
import {
	type GitHubUserUpsert,
	type MembershipRecord,
	ROLE_RANK,
	roleAtLeast,
	type ShareLinkRecord,
	type ShareRedemption,
	type ShareRole,
	type UserRecord,
	type WorkspaceId,
	type WorkspaceRecord,
	type WorkspaceRole,
	TenancyForbiddenError,
	TenancyNotFoundError,
} from './tenancyTypes.js'

/** Display name carried by the synthetic principal a share link mints. */
const SHARE_PRINCIPAL_NAME = 'Shared access'

/** Mint a high-entropy, URL-safe share token (32 bytes → 43 chars). */
function generateShareToken(): string {
	return randomBytes(32).toString('base64url')
}

/** The stored fingerprint of a share token: hex SHA-256. */
function hashShareToken(token: string): string {
	return createHash('sha256').update(token).digest('hex')
}

/** The synthetic user id a share link grants access through. */
function sharePrincipalId(link_id: string): UserId {
	return `share:${link_id}` as UserId
}

/**
 * Synthetic membership for AUTH_MODE=open deployments.
 *
 * Open mode targets a single trusted internal team behind its own
 * network boundary, so there is no per-workspace tenant isolation: every
 * authenticated session is treated as an owner of every workspace. When
 * open mode is off this returns null and `requireMembership` falls
 * through to the real membership check.
 *
 * @param user_id      the requesting user.
 * @param workspace_id the workspace being accessed.
 * @returns an owner `MembershipRecord` in open mode, otherwise null.
 */
function openModeMembership(
	user_id: UserId,
	workspace_id: WorkspaceId
): MembershipRecord | null {
	if (process.env['AUTH_MODE'] !== 'open') return null
	return { workspace_id, user_id, role: 'owner', joined_at: new Date().toISOString() }
}

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
	 * List all live (non-archived) members of a workspace, joined with
	 * the user record so the caller can render display name + github
	 * login without a separate fetch.
	 */
	listMembers(workspace_id: WorkspaceId): Promise<readonly MemberListEntry[]>
	/**
	 * Change a member's role. Returns the updated record, or null when
	 * the member doesn't exist in this workspace. Refuses to demote
	 * the last remaining owner (throws TenancyForbiddenError); a
	 * workspace must always have at least one owner.
	 */
	setMemberRole(
		workspace_id: WorkspaceId,
		user_id: UserId,
		role: WorkspaceRole
	): Promise<MembershipRecord | null>
	/**
	 * Remove a member. Returns the prior membership on success, null
	 * on no-op. Refuses to remove the last owner (same rule as
	 * setMemberRole demote).
	 */
	removeMember(
		workspace_id: WorkspaceId,
		user_id: UserId
	): Promise<MembershipRecord | null>
	/**
	 * Resolve a github login to the local user_id for invites. Returns
	 * null when no local user matches; the invite route surfaces a
	 * 'user_not_found' so the caller knows to ask the invitee to sign
	 * in first. (We do not pre-create user rows from a free-text
	 * github handle; the OAuth callback is the only path that creates
	 * user records, so claims stay verifiable.)
	 */
	findUserByGithubLogin(login: string): Promise<UserRecord | null>

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

	/**
	 * Mint a share link for a workspace. Returns the stored record and
	 * the raw token, which is surfaced to the creator exactly once —
	 * only its hash is persisted. `ttl_seconds` of null means the link
	 * never expires.
	 */
	createShareLink(
		workspace_id: WorkspaceId,
		created_by_user_id: UserId,
		role: ShareRole,
		ttl_seconds: number | null
	): Promise<{ readonly record: ShareLinkRecord; readonly token: string }>

	/** Active (non-revoked) share links for a workspace, newest first. */
	listShareLinks(workspace_id: WorkspaceId): Promise<readonly ShareLinkRecord[]>

	/**
	 * Revoke a link and sever the access it granted: the synthetic
	 * principal's membership is removed, so any session minted from the
	 * link loses access immediately even if its JWT has not expired.
	 * Returns false when no matching live link exists.
	 */
	revokeShareLink(workspace_id: WorkspaceId, id: string): Promise<boolean>

	/**
	 * Validate a raw share token and, on success, provision the
	 * synthetic principal + membership the caller mints a session for.
	 * Returns null when the token is unknown, revoked, or expired.
	 */
	redeemShareToken(token: string): Promise<ShareRedemption | null>
}

export interface MemberListEntry {
	readonly user: UserRecord
	readonly membership: MembershipRecord
}

/* -------------------------------------------------------------- *
 * In-memory                                                       *
 * -------------------------------------------------------------- */

export class InMemoryTenancyStore implements TenancyStore {
	private readonly users = new Map<UserId, UserRecord>()
	private readonly usersByGithubId = new Map<string, UserId>()
	private readonly workspaces = new Map<WorkspaceId, WorkspaceRecord>()
	private readonly memberships = new Map<string, MembershipRecord>()
	private readonly shareLinks = new Map<
		string,
		{ readonly record: ShareLinkRecord; readonly token_hash: string }
	>()

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
		const open = openModeMembership(user_id, workspace_id)
		if (open) return open
		const m = await this.getMembership(user_id, workspace_id)
		if (!m) throw new TenancyForbiddenError(user_id, workspace_id, minRole)
		if (!roleAtLeast(m.role, minRole)) {
			throw new TenancyForbiddenError(user_id, workspace_id, minRole)
		}
		return m
	}

	async listMembers(workspace_id: WorkspaceId): Promise<readonly MemberListEntry[]> {
		const out: MemberListEntry[] = []
		for (const m of this.memberships.values()) {
			if (m.workspace_id !== workspace_id) continue
			// Synthetic share principals are an access mechanism, not
			// people; they never appear in the members roster.
			if (m.user_id.startsWith('share:')) continue
			const user = this.users.get(m.user_id)
			if (!user) continue
			out.push({ user, membership: m })
		}
		// owner first, then admin, then member, then viewer; tie-break by joined_at.
		out.sort((a, b) => {
			const diff = ROLE_RANK[b.membership.role] - ROLE_RANK[a.membership.role]
			if (diff !== 0) return diff
			return a.membership.joined_at < b.membership.joined_at ? -1 : 1
		})
		return out
	}

	async setMemberRole(
		workspace_id: WorkspaceId,
		user_id: UserId,
		role: WorkspaceRole
	): Promise<MembershipRecord | null> {
		const existing = this.memberships.get(this.membershipKey(user_id, workspace_id))
		if (!existing) return null
		if (existing.role === 'owner' && role !== 'owner') {
			// Demoting an owner — refuse if this is the last one.
			let owners = 0
			for (const m of this.memberships.values()) {
				if (m.workspace_id === workspace_id && m.role === 'owner') owners += 1
			}
			if (owners <= 1) {
				throw new TenancyForbiddenError(user_id, workspace_id, 'owner')
			}
		}
		const next: MembershipRecord = { ...existing, role }
		this.memberships.set(this.membershipKey(user_id, workspace_id), next)
		return next
	}

	async removeMember(
		workspace_id: WorkspaceId,
		user_id: UserId
	): Promise<MembershipRecord | null> {
		const existing = this.memberships.get(this.membershipKey(user_id, workspace_id))
		if (!existing) return null
		if (existing.role === 'owner') {
			let owners = 0
			for (const m of this.memberships.values()) {
				if (m.workspace_id === workspace_id && m.role === 'owner') owners += 1
			}
			if (owners <= 1) {
				throw new TenancyForbiddenError(user_id, workspace_id, 'owner')
			}
		}
		this.memberships.delete(this.membershipKey(user_id, workspace_id))
		return existing
	}

	async findUserByGithubLogin(login: string): Promise<UserRecord | null> {
		const trimmed = login.trim().toLowerCase()
		for (const u of this.users.values()) {
			if ((u.github_login ?? '').toLowerCase() === trimmed) return u
		}
		return null
	}

	async createShareLink(
		workspace_id: WorkspaceId,
		created_by_user_id: UserId,
		role: ShareRole,
		ttl_seconds: number | null
	): Promise<{ readonly record: ShareLinkRecord; readonly token: string }> {
		if (!(await this.getWorkspace(workspace_id))) {
			throw new TenancyNotFoundError(`workspace ${workspace_id}`)
		}
		const token = generateShareToken()
		const now = Date.now()
		const record: ShareLinkRecord = {
			id: `shl_${randomUUID()}`,
			workspace_id,
			created_by_user_id,
			role,
			expires_at: ttl_seconds != null ? new Date(now + ttl_seconds * 1000).toISOString() : null,
			revoked_at: null,
			created_at: new Date(now).toISOString(),
		}
		this.shareLinks.set(record.id, { record, token_hash: hashShareToken(token) })
		return { record, token }
	}

	async listShareLinks(workspace_id: WorkspaceId): Promise<readonly ShareLinkRecord[]> {
		return [...this.shareLinks.values()]
			.map((v) => v.record)
			.filter((r) => r.workspace_id === workspace_id && r.revoked_at === null)
			.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
	}

	async revokeShareLink(workspace_id: WorkspaceId, id: string): Promise<boolean> {
		const entry = this.shareLinks.get(id)
		if (!entry || entry.record.workspace_id !== workspace_id || entry.record.revoked_at !== null) {
			return false
		}
		this.shareLinks.set(id, {
			...entry,
			record: { ...entry.record, revoked_at: new Date().toISOString() },
		})
		// Cut access immediately, regardless of any still-valid JWT.
		await this.removeMember(workspace_id, sharePrincipalId(id))
		return true
	}

	async redeemShareToken(token: string): Promise<ShareRedemption | null> {
		const hash = hashShareToken(token)
		const entry = [...this.shareLinks.values()].find((v) => v.token_hash === hash)
		if (!entry) return null
		const r = entry.record
		if (r.revoked_at !== null) return null
		if (r.expires_at !== null && new Date(r.expires_at).getTime() <= Date.now()) return null
		const share_user_id = await this.ensureSharePrincipal(r)
		return { link_id: r.id, workspace_id: r.workspace_id, role: r.role, share_user_id }
	}

	/** Lazily create the synthetic user + membership a link grants through. */
	private async ensureSharePrincipal(record: ShareLinkRecord): Promise<UserId> {
		const id = sharePrincipalId(record.id)
		if (!this.users.has(id)) {
			const now = new Date().toISOString()
			this.users.set(id, {
				id,
				github_id: null,
				github_login: null,
				email: null,
				name: SHARE_PRINCIPAL_NAME,
				created_at: now,
				last_seen_at: now,
			})
		}
		await this.addMember(record.workspace_id, id, record.role)
		return id
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
interface ShareLinkRow {
	id: string
	workspace_id: string
	created_by_user_id: string
	role: ShareRole
	expires_at: Date | null
	revoked_at: Date | null
	created_at: Date
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
function shareLinkRowToRecord(row: ShareLinkRow): ShareLinkRecord {
	return {
		id: row.id,
		workspace_id: row.workspace_id as WorkspaceId,
		created_by_user_id: row.created_by_user_id as UserId,
		role: row.role,
		expires_at: row.expires_at ? row.expires_at.toISOString() : null,
		revoked_at: row.revoked_at ? row.revoked_at.toISOString() : null,
		created_at: row.created_at.toISOString(),
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
		const open = openModeMembership(user_id, workspace_id)
		if (open) return open
		const m = await this.getMembership(user_id, workspace_id)
		if (!m) throw new TenancyForbiddenError(user_id, workspace_id, minRole)
		if (!roleAtLeast(m.role, minRole)) {
			throw new TenancyForbiddenError(user_id, workspace_id, minRole)
		}
		return m
	}

	async listMembers(workspace_id: WorkspaceId): Promise<readonly MemberListEntry[]> {
		// One join, ordered by role rank then joined_at. The ORDER BY
		// CASE replicates the in-memory sort order so consumers see a
		// consistent shape regardless of adapter.
		const rows = await this.sql<Array<UserRow & MembershipRow>>`
			SELECT u.*, m.workspace_id, m.user_id, m.role, m.joined_at
			FROM workspace_members m
			JOIN users u ON u.id = m.user_id
			WHERE m.workspace_id = ${workspace_id}
			  AND u.id NOT LIKE 'share:%'
			ORDER BY
				CASE m.role
					WHEN 'owner'  THEN 0
					WHEN 'admin'  THEN 1
					WHEN 'member' THEN 2
					WHEN 'viewer' THEN 3
					ELSE 4
				END,
				m.joined_at ASC
		`
		return rows.map((row) => ({
			user: userRowToRecord({
				id: row.id,
				github_id: row.github_id,
				github_login: row.github_login,
				email: row.email,
				name: row.name,
				created_at: row.created_at,
				last_seen_at: row.last_seen_at,
			}),
			membership: membershipRowToRecord({
				workspace_id: row.workspace_id,
				user_id: row.user_id,
				role: row.role,
				joined_at: row.joined_at,
			}),
		}))
	}

	async setMemberRole(
		workspace_id: WorkspaceId,
		user_id: UserId,
		role: WorkspaceRole
	): Promise<MembershipRecord | null> {
		// Single SQL guard against demoting the last owner: the UPDATE
		// runs only when the new role is owner OR another owner exists.
		// COALESCE wraps the count so a missing row produces 0, not null.
		const rows = await this.sql<MembershipRow[]>`
			UPDATE workspace_members SET role = ${role}
			WHERE workspace_id = ${workspace_id}
			  AND user_id = ${user_id}
			  AND (
				${role}::text = 'owner'
				OR role <> 'owner'
				OR (
					SELECT count(*) FROM workspace_members
					WHERE workspace_id = ${workspace_id} AND role = 'owner'
				) > 1
			  )
			RETURNING *
		`
		if (rows[0]) return membershipRowToRecord(rows[0])
		// Distinguish "no such row" from "last-owner refused".
		const existing = await this.getMembership(user_id, workspace_id)
		if (!existing) return null
		if (existing.role === 'owner' && role !== 'owner') {
			throw new TenancyForbiddenError(user_id, workspace_id, 'owner')
		}
		return null
	}

	async removeMember(
		workspace_id: WorkspaceId,
		user_id: UserId
	): Promise<MembershipRecord | null> {
		const rows = await this.sql<MembershipRow[]>`
			DELETE FROM workspace_members
			WHERE workspace_id = ${workspace_id}
			  AND user_id = ${user_id}
			  AND (
				role <> 'owner'
				OR (
					SELECT count(*) FROM workspace_members
					WHERE workspace_id = ${workspace_id} AND role = 'owner'
				) > 1
			  )
			RETURNING *
		`
		if (rows[0]) return membershipRowToRecord(rows[0])
		const existing = await this.getMembership(user_id, workspace_id)
		if (!existing) return null
		if (existing.role === 'owner') {
			throw new TenancyForbiddenError(user_id, workspace_id, 'owner')
		}
		return null
	}

	async findUserByGithubLogin(login: string): Promise<UserRecord | null> {
		const rows = await this.sql<UserRow[]>`
			SELECT * FROM users
			WHERE LOWER(github_login) = LOWER(${login})
			LIMIT 1
		`
		return rows[0] ? userRowToRecord(rows[0]) : null
	}

	async createShareLink(
		workspace_id: WorkspaceId,
		created_by_user_id: UserId,
		role: ShareRole,
		ttl_seconds: number | null
	): Promise<{ readonly record: ShareLinkRecord; readonly token: string }> {
		const token = generateShareToken()
		const id = `shl_${randomUUID()}`
		const expires = ttl_seconds != null ? new Date(Date.now() + ttl_seconds * 1000) : null
		const rows = await this.sql<ShareLinkRow[]>`
			INSERT INTO share_links (id, workspace_id, created_by_user_id, role, token_hash, expires_at)
			VALUES (${id}, ${workspace_id}, ${created_by_user_id}, ${role}, ${hashShareToken(token)}, ${expires})
			RETURNING *
		`
		return { record: shareLinkRowToRecord(rows[0]!), token }
	}

	async listShareLinks(workspace_id: WorkspaceId): Promise<readonly ShareLinkRecord[]> {
		const rows = await this.sql<ShareLinkRow[]>`
			SELECT * FROM share_links
			WHERE workspace_id = ${workspace_id} AND revoked_at IS NULL
			ORDER BY created_at DESC
		`
		return rows.map(shareLinkRowToRecord)
	}

	async revokeShareLink(workspace_id: WorkspaceId, id: string): Promise<boolean> {
		const rows = await this.sql<{ id: string }[]>`
			UPDATE share_links SET revoked_at = now()
			WHERE id = ${id} AND workspace_id = ${workspace_id} AND revoked_at IS NULL
			RETURNING id
		`
		if (!rows[0]) return false
		// Cut access immediately, regardless of any still-valid JWT.
		await this.removeMember(workspace_id, sharePrincipalId(id))
		return true
	}

	async redeemShareToken(token: string): Promise<ShareRedemption | null> {
		const rows = await this.sql<ShareLinkRow[]>`
			SELECT * FROM share_links
			WHERE token_hash = ${hashShareToken(token)}
			  AND revoked_at IS NULL
			  AND (expires_at IS NULL OR expires_at > now())
			LIMIT 1
		`
		const row = rows[0]
		if (!row) return null
		const record = shareLinkRowToRecord(row)
		const share_user_id = await this.ensureSharePrincipal(record)
		return {
			link_id: record.id,
			workspace_id: record.workspace_id,
			role: record.role,
			share_user_id,
		}
	}

	/** Lazily create the synthetic user + membership a link grants through. */
	private async ensureSharePrincipal(record: ShareLinkRecord): Promise<UserId> {
		const id = sharePrincipalId(record.id)
		await this.sql`
			INSERT INTO users (id, name) VALUES (${id}, ${SHARE_PRINCIPAL_NAME})
			ON CONFLICT (id) DO NOTHING
		`
		await this.addMember(record.workspace_id, id, record.role)
		return id
	}
}
