/**
 * Wire-shape types for the public REST API.
 *
 * These are duplicated (not imported from the orchestrator) on
 * purpose. The SDK is shipped to customers; importing from a private
 * workspace package would either drag a dist tree into the public
 * bundle or break the dependency at install time. The cost is one
 * file to update when an API contract changes; the api-check workflow
 * already enforces deliberate changes.
 *
 * Every field shape matches the JSON the orchestrator returns.
 */

export type ApiTokenScope = 'read' | 'write'

export interface ApiTokenSummary {
	readonly id: string
	readonly user_id: string
	readonly workspace_id: string
	readonly name: string
	readonly token_prefix: string
	readonly scope: ApiTokenScope
	readonly created_at: string
	readonly last_used_at: string | null
	readonly expires_at: string | null
	readonly revoked_at: string | null
}

export interface IssuedToken {
	readonly record: ApiTokenSummary
	/** Returned exactly once on creation. Cannot be recovered later. */
	readonly raw_token: string
}

export interface WebhookEndpointSummary {
	readonly id: string
	readonly workspace_id: string
	readonly user_id: string
	readonly url: string
	readonly events: readonly string[]
	readonly description: string | null
	readonly created_at: string
	readonly revoked_at: string | null
}

export interface IssuedWebhookEndpoint {
	readonly record: WebhookEndpointSummary
	/** Returned exactly once on creation. The SDK MUST persist this safely. */
	readonly signing_secret: string
}

export interface AuditEvent {
	readonly id: string
	readonly workspace_id: string
	readonly actor_user_id: string
	readonly action: string
	readonly target_type: string
	readonly target_id: string | null
	readonly details: Record<string, unknown>
	readonly created_at: string
}

export interface BillingStatus {
	readonly live: boolean
	readonly status: string
	readonly plan_lookup_key: string | null
	readonly current_period_end: string | null
	readonly cancel_at_period_end: boolean
	readonly gate_enabled: boolean
}

export interface RunStartInput {
	readonly agent_id: string
	readonly room_id: string
	readonly initial_message: string
}

export interface RunStartResult {
	readonly run_id: string
	readonly agent_id: string
	readonly room_id: string
}
