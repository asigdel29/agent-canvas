/**
 * Tenancy types — users, workspaces, and the membership join
 * between them. Mirrors the migration-004 tables. Branded ids
 * keep them mutually non-assignable at the type level.
 *
 * Role hierarchy (descending privilege):
 *
 *   owner    can transfer ownership, delete workspace, manage
 *            billing (when billing arrives in P1), invite anyone
 *   admin    can invite + remove members, change roles below
 *            their own, edit any agent, see audit log
 *   member   can create + edit + run agents, see other members'
 *            agents read-only
 *   viewer   read-only. Sees the canvas; cannot mutate.
 *
 * The numeric levels in ROLE_RANK are the source of truth for
 * "is role A at least as privileged as role B" comparisons.
 * @author asigdel29
 */

import type { UserId } from '@agent-canvas/orchestrator-types'

export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' }
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer'

export const ROLE_RANK: Readonly<Record<WorkspaceRole, number>> = {
	owner: 100,
	admin: 80,
	member: 60,
	viewer: 40,
}

/** Returns true if `actor` outranks (or equals) `required`. */
export function roleAtLeast(actor: WorkspaceRole, required: WorkspaceRole): boolean {
	return ROLE_RANK[actor] >= ROLE_RANK[required]
}

export interface UserRecord {
	readonly id: UserId
	readonly github_id: string | null
	readonly github_login: string | null
	readonly email: string | null
	readonly name: string | null
	readonly created_at: string
	readonly last_seen_at: string
}

export interface WorkspaceRecord {
	readonly id: WorkspaceId
	readonly name: string
	readonly owner_user_id: UserId
	readonly created_at: string
	readonly archived_at: string | null
}

export interface MembershipRecord {
	readonly workspace_id: WorkspaceId
	readonly user_id: UserId
	readonly role: WorkspaceRole
	readonly joined_at: string
}

/**
 * Inputs to upsertFromGitHub, the path the OAuth callback uses to
 * land a fresh login. Idempotent: a second call updates
 * last_seen_at + any nullable fields that arrived this time.
 */
export interface GitHubUserUpsert {
	readonly github_id: string
	readonly github_login: string
	readonly email: string | null
	readonly name: string | null
}

export class TenancyNotFoundError extends Error {
	constructor(public readonly what: string) {
		super(`tenancy ${what} not found`)
		this.name = 'TenancyNotFoundError'
	}
}

export class TenancyForbiddenError extends Error {
	constructor(
		public readonly user_id: UserId,
		public readonly workspace_id: WorkspaceId,
		public readonly required: WorkspaceRole
	) {
		super(`user ${user_id} is not a ${required}+ of workspace ${workspace_id}`)
		this.name = 'TenancyForbiddenError'
	}
}
