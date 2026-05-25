/**
 * apiTokenStore — issue, list, verify, revoke programmatic API
 * tokens.
 *
 * Token format: `ack_<43-char-base64url>` (256 bits of entropy).
 * The raw token is returned ONCE on issue; we store only the
 * SHA-256 hash. A leaked database row cannot be replayed against
 * the API — the hash is one-way and the lookup index is on the
 * hash, not the raw secret.
 *
 * Scopes:
 *   read    accepts viewer+ routes
 *   write   accepts member+ routes
 *
 * verify(rawToken) returns the matching unrevoked record or null.
 * Side-effect: when the token verifies, we bump last_used_at to
 * now() so dead keys can be triaged. The write is best-effort —
 * a transient DB outage on the read path never blocks the request.
 *
 * Tokens are workspace-scoped at issue time. The verify() result
 * carries the workspace_id so the API route can call
 * TenancyStore.requireMembership directly with no extra lookup.
 */

import { createHash, randomBytes } from 'node:crypto'
import { randomUUID } from 'node:crypto'

import type { UserId } from '@agent-canvas/orchestrator-types'
import type { SqlClient } from '../postgres/client.js'
import type { WorkspaceId } from '../tenancy/tenancyTypes.js'

export type ApiTokenScope = 'read' | 'write'

export interface ApiTokenRecord {
	readonly id: string
	readonly user_id: UserId
	readonly workspace_id: WorkspaceId
	readonly name: string
	readonly token_prefix: string
	readonly scope: ApiTokenScope
	readonly created_at: string
	readonly last_used_at: string | null
	readonly expires_at: string | null
	readonly revoked_at: string | null
}

export interface IssueInput {
	readonly user_id: UserId
	readonly workspace_id: WorkspaceId
	readonly name: string
	readonly scope: ApiTokenScope
	/** Optional ISO 8601 expiry. Null = no expiry. */
	readonly expires_at?: string | null
}

export interface IssueResult {
	readonly record: ApiTokenRecord
	/** Raw token returned exactly once; the store never persists it. */
	readonly raw_token: string
}

export interface ApiTokenStore {
	issue(input: IssueInput): Promise<IssueResult>
	listForUser(user_id: UserId): Promise<readonly ApiTokenRecord[]>
	verify(raw_token: string): Promise<ApiTokenRecord | null>
	/**
	 * Soft-revoke the token identified by id when the caller owns it.
	 * Returns the post-revoke record on success, null when the id is
	 * unknown, owned by another user, or already revoked. The API
	 * layer returns the same 204 regardless so the null branch does
	 * NOT leak existence; the return value exists so callers (audit
	 * logging, metrics) can act on a successful revoke.
	 */
	revoke(id: string, user_id: UserId): Promise<ApiTokenRecord | null>
}

const PREFIX = 'ack_'
const PREVIEW_LEN = 12

export function mintRawToken(): { raw: string; hash: string; prefix: string } {
	const body = randomBytes(32).toString('base64url')
	const raw = `${PREFIX}${body}`
	const hash = createHash('sha256').update(raw).digest('hex')
	const prefix = `${raw.slice(0, PREVIEW_LEN)}…`
	return { raw, hash, prefix }
}

/* -------------------------------------------------------------- *
 * In-memory                                                       *
 * -------------------------------------------------------------- */

interface InternalRecord {
	rec: ApiTokenRecord
	hash: string
}

export class InMemoryApiTokenStore implements ApiTokenStore {
	private readonly rows = new Map<string, InternalRecord>()

	async issue(input: IssueInput): Promise<IssueResult> {
		const { raw, hash, prefix } = mintRawToken()
		const id = `tok_${randomUUID()}`
		const rec: ApiTokenRecord = {
			id,
			user_id: input.user_id,
			workspace_id: input.workspace_id,
			name: input.name,
			token_prefix: prefix,
			scope: input.scope,
			created_at: new Date().toISOString(),
			last_used_at: null,
			expires_at: input.expires_at ?? null,
			revoked_at: null,
		}
		this.rows.set(id, { rec, hash })
		return { record: rec, raw_token: raw }
	}

	async listForUser(user_id: UserId): Promise<readonly ApiTokenRecord[]> {
		const out: ApiTokenRecord[] = []
		for (const r of this.rows.values()) {
			if (r.rec.user_id === user_id && r.rec.revoked_at === null) {
				out.push(r.rec)
			}
		}
		out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
		return out
	}

	async verify(raw_token: string): Promise<ApiTokenRecord | null> {
		if (!raw_token.startsWith(PREFIX)) return null
		const hash = createHash('sha256').update(raw_token).digest('hex')
		const now = Date.now()
		for (const r of this.rows.values()) {
			if (r.hash !== hash) continue
			if (r.rec.revoked_at !== null) return null
			if (r.rec.expires_at !== null && Date.parse(r.rec.expires_at) <= now) return null
			// Bump last_used_at.
			const bumped: ApiTokenRecord = {
				...r.rec,
				last_used_at: new Date().toISOString(),
			}
			this.rows.set(r.rec.id, { rec: bumped, hash: r.hash })
			return bumped
		}
		return null
	}

	async revoke(id: string, user_id: UserId): Promise<ApiTokenRecord | null> {
		const r = this.rows.get(id)
		if (!r || r.rec.user_id !== user_id) return null // silent no-op (don't leak existence)
		if (r.rec.revoked_at !== null) return null
		const revoked: ApiTokenRecord = { ...r.rec, revoked_at: new Date().toISOString() }
		this.rows.set(id, { ...r, rec: revoked })
		return revoked
	}
}

/* -------------------------------------------------------------- *
 * Postgres                                                        *
 * -------------------------------------------------------------- */

interface ApiTokenRow {
	id: string
	user_id: string
	workspace_id: string
	name: string
	token_prefix: string
	scope: ApiTokenScope
	created_at: Date
	last_used_at: Date | null
	expires_at: Date | null
	revoked_at: Date | null
}

function rowToRecord(row: ApiTokenRow): ApiTokenRecord {
	return {
		id: row.id,
		user_id: row.user_id as UserId,
		workspace_id: row.workspace_id as WorkspaceId,
		name: row.name,
		token_prefix: row.token_prefix,
		scope: row.scope,
		created_at: row.created_at.toISOString(),
		last_used_at: row.last_used_at ? row.last_used_at.toISOString() : null,
		expires_at: row.expires_at ? row.expires_at.toISOString() : null,
		revoked_at: row.revoked_at ? row.revoked_at.toISOString() : null,
	}
}

export class PostgresApiTokenStore implements ApiTokenStore {
	constructor(private readonly sql: SqlClient) {}

	async issue(input: IssueInput): Promise<IssueResult> {
		const { raw, hash, prefix } = mintRawToken()
		const id = `tok_${randomUUID()}`
		const rows = await this.sql<ApiTokenRow[]>`
			INSERT INTO api_tokens (
				id, user_id, workspace_id, name, token_hash, token_prefix,
				scope, expires_at
			) VALUES (
				${id},
				${input.user_id},
				${input.workspace_id},
				${input.name},
				${hash},
				${prefix},
				${input.scope},
				${input.expires_at ?? null}
			)
			RETURNING *
		`
		return { record: rowToRecord(rows[0]!), raw_token: raw }
	}

	async listForUser(user_id: UserId): Promise<readonly ApiTokenRecord[]> {
		const rows = await this.sql<ApiTokenRow[]>`
			SELECT * FROM api_tokens
			WHERE user_id = ${user_id} AND revoked_at IS NULL
			ORDER BY created_at DESC
		`
		return rows.map(rowToRecord)
	}

	async verify(raw_token: string): Promise<ApiTokenRecord | null> {
		if (!raw_token.startsWith(PREFIX)) return null
		const hash = createHash('sha256').update(raw_token).digest('hex')
		const rows = await this.sql<ApiTokenRow[]>`
			SELECT * FROM api_tokens
			WHERE token_hash = ${hash}
			  AND revoked_at IS NULL
			  AND (expires_at IS NULL OR expires_at > now())
			LIMIT 1
		`
		if (rows.length === 0) return null
		const rec = rowToRecord(rows[0]!)
		// Bump last_used_at. Best-effort: a transient write failure
		// must NEVER block a successful verify.
		void (async () => {
			try {
				await this.sql`
					UPDATE api_tokens SET last_used_at = now() WHERE id = ${rec.id}
				`
			} catch {
				/* ignore */
			}
		})()
		return rec
	}

	async revoke(id: string, user_id: UserId): Promise<ApiTokenRecord | null> {
		// The user_id gate makes this safe even if a request supplies
		// someone else's token id. We don't surface a 404 vs 403
		// distinction — both look like 'silently nothing happened'
		// to avoid existence-oracle attacks. The RETURNING clause
		// gives the route enough context to emit an audit row when
		// an actual revoke happened (no row updated = no audit).
		const rows = await this.sql<ApiTokenRow[]>`
			UPDATE api_tokens
			SET revoked_at = now()
			WHERE id = ${id} AND user_id = ${user_id} AND revoked_at IS NULL
			RETURNING *
		`
		return rows[0] ? rowToRecord(rows[0]) : null
	}
}
