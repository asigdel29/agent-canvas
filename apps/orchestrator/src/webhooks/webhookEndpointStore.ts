/**
 * webhookEndpointStore — register / list / revoke outbound webhook
 * endpoints scoped to a workspace.
 *
 * Endpoint id format: `whe_<uuid>`. The signing secret is 32 random
 * bytes hex-encoded; it is returned exactly once on create and
 * never surfaced again by list / get.
 *
 * Why we keep the secret plaintext at rest (for now): we need it on
 * every outbound delivery to sign the body. A KMS-backed encrypt-at-
 * rest lives behind the existing src/orchestration/vault.ts seam,
 * but bolting that in is its own PR; foundations first.
 *
 * URL validation lives at the API layer, not here. The store
 * accepts any text; the route enforces https + non-loopback +
 * non-private. That keeps tests for the store unit-pure.
 *
 * Soft-delete via revoked_at so the foreign-key references from
 * the future deliveries table survive after revocation. listLive
 * filters on revoked_at IS NULL.
 */

import { randomBytes, randomUUID } from 'node:crypto'

import type { UserId } from '@agent-canvas/orchestrator-types'
import type { SqlClient } from '../postgres/client.js'
import type { WorkspaceId } from '../tenancy/tenancyTypes.js'

/** Subscription wildcard meaning "every event type". */
export const EVENT_TYPE_WILDCARD = '*'

export interface WebhookEndpointRecord {
	readonly id: string
	readonly workspace_id: WorkspaceId
	readonly user_id: UserId
	readonly url: string
	readonly events: readonly string[]
	readonly description: string | null
	readonly created_at: string
	readonly revoked_at: string | null
}

export interface CreateEndpointInput {
	readonly workspace_id: WorkspaceId
	readonly user_id: UserId
	readonly url: string
	readonly events?: readonly string[]
	readonly description?: string | null
}

export interface CreateEndpointResult {
	readonly record: WebhookEndpointRecord
	/** Returned exactly once on create. Subsequent fetches do not include it. */
	readonly signing_secret: string
}

export interface WebhookEndpointStore {
	create(input: CreateEndpointInput): Promise<CreateEndpointResult>
	listForWorkspace(workspace_id: WorkspaceId): Promise<readonly WebhookEndpointRecord[]>
	getSigningSecret(id: string): Promise<string | null>
	revoke(id: string, user_id: UserId): Promise<void>
	/** Match all live endpoints in a workspace that subscribe to event_type. */
	matchSubscribers(
		workspace_id: WorkspaceId,
		event_type: string
	): Promise<readonly { record: WebhookEndpointRecord; signing_secret: string }[]>
}

/** 32-byte secret, hex-encoded. */
export function mintSigningSecret(): string {
	return randomBytes(32).toString('hex')
}

function eventsMatch(subscribed: readonly string[], event_type: string): boolean {
	for (const e of subscribed) {
		if (e === EVENT_TYPE_WILDCARD || e === event_type) return true
	}
	return false
}

/* -------------------------------------------------------------- *
 * In-memory                                                       *
 * -------------------------------------------------------------- */

interface InternalEndpoint {
	rec: WebhookEndpointRecord
	signing_secret: string
}

export class InMemoryWebhookEndpointStore implements WebhookEndpointStore {
	private readonly rows = new Map<string, InternalEndpoint>()

	async create(input: CreateEndpointInput): Promise<CreateEndpointResult> {
		const id = `whe_${randomUUID()}`
		const signing_secret = mintSigningSecret()
		const rec: WebhookEndpointRecord = {
			id,
			workspace_id: input.workspace_id,
			user_id: input.user_id,
			url: input.url,
			events: input.events && input.events.length > 0 ? [...input.events] : [EVENT_TYPE_WILDCARD],
			description: input.description ?? null,
			created_at: new Date().toISOString(),
			revoked_at: null,
		}
		this.rows.set(id, { rec, signing_secret })
		return { record: rec, signing_secret }
	}

	async listForWorkspace(
		workspace_id: WorkspaceId
	): Promise<readonly WebhookEndpointRecord[]> {
		const out: WebhookEndpointRecord[] = []
		for (const r of this.rows.values()) {
			if (r.rec.workspace_id === workspace_id && r.rec.revoked_at === null) {
				out.push(r.rec)
			}
		}
		out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
		return out
	}

	async getSigningSecret(id: string): Promise<string | null> {
		const r = this.rows.get(id)
		if (!r || r.rec.revoked_at !== null) return null
		return r.signing_secret
	}

	async revoke(id: string, user_id: UserId): Promise<void> {
		const r = this.rows.get(id)
		if (!r || r.rec.user_id !== user_id) return // silent no-op
		if (r.rec.revoked_at !== null) return
		this.rows.set(id, {
			...r,
			rec: { ...r.rec, revoked_at: new Date().toISOString() },
		})
	}

	async matchSubscribers(
		workspace_id: WorkspaceId,
		event_type: string
	): Promise<readonly { record: WebhookEndpointRecord; signing_secret: string }[]> {
		const out: { record: WebhookEndpointRecord; signing_secret: string }[] = []
		for (const r of this.rows.values()) {
			if (r.rec.workspace_id !== workspace_id) continue
			if (r.rec.revoked_at !== null) continue
			if (!eventsMatch(r.rec.events, event_type)) continue
			out.push({ record: r.rec, signing_secret: r.signing_secret })
		}
		return out
	}
}

/* -------------------------------------------------------------- *
 * Postgres                                                        *
 * -------------------------------------------------------------- */

interface EndpointRow {
	id: string
	workspace_id: string
	user_id: string
	url: string
	signing_secret: string
	events: string[]
	description: string | null
	created_at: Date
	revoked_at: Date | null
}

function rowToRecord(row: EndpointRow): WebhookEndpointRecord {
	return {
		id: row.id,
		workspace_id: row.workspace_id as WorkspaceId,
		user_id: row.user_id as UserId,
		url: row.url,
		events: row.events,
		description: row.description,
		created_at: row.created_at.toISOString(),
		revoked_at: row.revoked_at ? row.revoked_at.toISOString() : null,
	}
}

export class PostgresWebhookEndpointStore implements WebhookEndpointStore {
	constructor(private readonly sql: SqlClient) {}

	async create(input: CreateEndpointInput): Promise<CreateEndpointResult> {
		const id = `whe_${randomUUID()}`
		const signing_secret = mintSigningSecret()
		const events = input.events && input.events.length > 0 ? [...input.events] : [EVENT_TYPE_WILDCARD]
		const rows = await this.sql<EndpointRow[]>`
			INSERT INTO webhook_endpoints (
				id, workspace_id, user_id, url, signing_secret, events, description
			) VALUES (
				${id},
				${input.workspace_id},
				${input.user_id},
				${input.url},
				${signing_secret},
				${events},
				${input.description ?? null}
			)
			RETURNING *
		`
		return { record: rowToRecord(rows[0]!), signing_secret }
	}

	async listForWorkspace(
		workspace_id: WorkspaceId
	): Promise<readonly WebhookEndpointRecord[]> {
		const rows = await this.sql<EndpointRow[]>`
			SELECT * FROM webhook_endpoints
			WHERE workspace_id = ${workspace_id} AND revoked_at IS NULL
			ORDER BY created_at DESC
		`
		return rows.map(rowToRecord)
	}

	async getSigningSecret(id: string): Promise<string | null> {
		const rows = await this.sql<{ signing_secret: string }[]>`
			SELECT signing_secret FROM webhook_endpoints
			WHERE id = ${id} AND revoked_at IS NULL
			LIMIT 1
		`
		return rows[0]?.signing_secret ?? null
	}

	async revoke(id: string, user_id: UserId): Promise<void> {
		// Match on id AND user_id — a delete that targets another user's
		// endpoint is a silent no-op, same oracle defense as api tokens.
		await this.sql`
			UPDATE webhook_endpoints
			SET revoked_at = now()
			WHERE id = ${id}
			  AND user_id = ${user_id}
			  AND revoked_at IS NULL
		`
	}

	async matchSubscribers(
		workspace_id: WorkspaceId,
		event_type: string
	): Promise<readonly { record: WebhookEndpointRecord; signing_secret: string }[]> {
		// '*' OR exact-match using the @> array contains operator.
		const rows = await this.sql<EndpointRow[]>`
			SELECT * FROM webhook_endpoints
			WHERE workspace_id = ${workspace_id}
			  AND revoked_at IS NULL
			  AND (events @> ARRAY['*'] OR events @> ARRAY[${event_type}])
		`
		return rows.map((r) => ({ record: rowToRecord(r), signing_secret: r.signing_secret }))
	}
}
