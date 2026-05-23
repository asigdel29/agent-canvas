/**
 * @agent-canvas/connector-core
 *
 * Strict Connector framework. Every adapter — 8 third-party connectors
 * plus 2 agent vendors — implements the same Connector interface and
 * passes the conformance suite (`./conformance`).
 *
 * Layers in this package:
 *   - Connector interface + ToolDescriptor / TriggerDescriptor / SinkDescriptor
 *   - OAuth framework types
 *   - Webhook framework types
 *   - ProviderAdapter (agent vendor) abstraction
 *   - Safety classification
 *   - ConnectorRegistry (singleton lookup)
 *   - Per-module errors (vendor, webhook, oauth, vault)
 *
 * Dependencies: ONLY @agent-canvas/orchestrator-types. No React, no
 * @tldraw/* deps, no infrastructure SDKs. Adapters depend on this
 * package + their provider SDK; the orchestrator depends on this
 * package + the runtime infrastructure.
 */

import type { ProviderId, RunId, VendorId } from '@agent-canvas/orchestrator-types'

// ─────────────────────────────────────────────────────────────────────
// Safety classification (drives CEO 3.3 approval gate)
// ─────────────────────────────────────────────────────────────────────

export type SafetyClass = 'safe' | 'destructive' | 'irreversible'

/**
 * Default safety for tools whose inputs are arbitrary (shell, SQL,
 * generic HTTP). Treated as destructive unless an explicit allowlist
 * downgrades them.
 */
export const ARBITRARY_INPUT_DEFAULT_SAFETY: SafetyClass = 'destructive'

// ─────────────────────────────────────────────────────────────────────
// Tool / Trigger / Sink descriptors
// ─────────────────────────────────────────────────────────────────────

export interface ToolDescriptor {
	readonly id: string
	readonly name: string
	readonly description: string
	readonly safety: SafetyClass
	/**
	 * Vendor IDs for which this tool is currently supported. Phase 1 uses
	 * a live `vendor.getSupportedTools()` cache (Eng review decision 39)
	 * to populate this lazily; static values here are the *fallback*.
	 */
	readonly supported_vendors?: readonly VendorId[]
	readonly input_schema: Readonly<Record<string, unknown>> // JSON schema, opaque to the framework
	readonly output_schema: Readonly<Record<string, unknown>>
}

export type TriggerKind = 'webhook' | 'poll' | 'manual'

export interface TriggerDescriptor {
	readonly id: string
	readonly name: string
	readonly description: string
	readonly kind: TriggerKind
}

export interface SinkDescriptor {
	readonly id: string
	readonly name: string
	readonly description: string
	readonly safety: SafetyClass
}

// ─────────────────────────────────────────────────────────────────────
// OAuth framework
// ─────────────────────────────────────────────────────────────────────

export interface OAuthAuthorizeRequest {
	readonly state: string
	readonly redirect_uri: string
}

export interface OAuthAuthorizeResult {
	readonly authorize_url: string
}

export interface OAuthCallbackRequest {
	readonly state: string
	readonly code: string
}

/**
 * What an adapter returns after exchanging an OAuth code. The vault
 * encrypts and stores this; the orchestrator never sees long-lived
 * tokens in plaintext outside the vault.
 */
export interface OAuthTokenSet {
	readonly access_token: string
	readonly refresh_token?: string
	readonly expires_at?: string // ISO 8601
	readonly scope?: string
}

export interface OAuthFramework {
	authorize(req: OAuthAuthorizeRequest): Promise<OAuthAuthorizeResult>
	callback(req: OAuthCallbackRequest): Promise<OAuthTokenSet>
	refresh(token_set: OAuthTokenSet): Promise<OAuthTokenSet>
	revoke(token_set: OAuthTokenSet): Promise<void>
}

// ─────────────────────────────────────────────────────────────────────
// Webhook framework (per-provider signature + idempotency derivation)
// ─────────────────────────────────────────────────────────────────────

export interface WebhookRequest {
	readonly headers: Readonly<Record<string, string>>
	readonly body: string
}

export interface NormalizedWebhookEvent {
	readonly provider: ProviderId | VendorId
	readonly event_type: string
	readonly idempotency_key: string
	readonly received_at: string
	readonly payload: Readonly<Record<string, unknown>>
}

export interface WebhookFramework {
	verifySignature(req: WebhookRequest, secret: string): Promise<boolean>
	/** Per-provider derivation; e.g., Slack uses ts+channel+retry_num, GitHub uses X-GitHub-Delivery, etc. */
	idempotencyKey(req: WebhookRequest): string
	normalize(req: WebhookRequest): NormalizedWebhookEvent
}

// ─────────────────────────────────────────────────────────────────────
// Connector — what 8 third-party adapters implement
// ─────────────────────────────────────────────────────────────────────

export interface Connector {
	readonly id: ProviderId
	readonly display_name: string
	readonly oauth: OAuthFramework
	readonly webhook: WebhookFramework
	readonly tools: readonly ToolDescriptor[]
	readonly triggers: readonly TriggerDescriptor[]
	readonly sinks: readonly SinkDescriptor[]
}

// ─────────────────────────────────────────────────────────────────────
// ProviderAdapter — what the 2 managed agent vendors implement
// ─────────────────────────────────────────────────────────────────────

export interface StartRunRequest {
	readonly run_id: RunId
	readonly task_spec: Readonly<Record<string, unknown>>
	readonly required_tool_ids: readonly string[]
	readonly credentials: Readonly<Record<string, string>> // already short-lived, scoped, minted by vault
}

export type VendorRunStatus =
	| 'queued'
	| 'provisioning'
	| 'running'
	| 'succeeded'
	| 'failed'
	| 'cancelled'
	| 'unknown' // vendor doesn't know about this run

export interface VendorRunStatusReport {
	readonly run_id: RunId
	readonly status: VendorRunStatus
	readonly last_observed_at: string
}

export interface ProviderAdapter {
	readonly id: VendorId
	readonly display_name: string

	/** Live capability — refreshed on webhook + cached with TTL. */
	getSupportedTools(): Promise<readonly string[]>

	startRun(req: StartRunRequest): Promise<{ vendor_run_id: string }>
	cancelRun(run_id: RunId): Promise<void>
	getStatus(run_id: RunId): Promise<VendorRunStatusReport>

	/** Webhook framework specific to this vendor's webhook protocol. */
	readonly webhook: WebhookFramework

	/**
	 * Translate a normalized webhook event into a vendor-run signal.
	 * Returns null if the event is not a per-run update (e.g., vendor
	 * health pings, billing notifications). The orchestrator's
	 * ingestion pipeline routes the signal to the corresponding
	 * internal run via the VendorRunMap.
	 */
	extractRunInfo(event: NormalizedWebhookEvent): VendorRunInfo | null
}

/**
 * What an adapter extracts from a per-run webhook event. `vendor_run_id`
 * keys the map back to the orchestrator's internal RunId.
 */
export interface VendorRunInfo {
	readonly vendor_run_id: string
	readonly event_kind:
		| 'queued'
		| 'provisioning'
		| 'running'
		| 'awaiting_input'
		| 'progress'
		| 'tool_call'
		| 'approval_request'
		| 'succeeded'
		| 'failed'
		| 'cancelled'
		| 'unreachable'
	readonly payload: Readonly<Record<string, unknown>>
}

// ─────────────────────────────────────────────────────────────────────
// Connector registry (singleton)
// ─────────────────────────────────────────────────────────────────────

export class ConnectorNotFoundError extends Error {
	constructor(id: string) {
		super(`connector not found: ${id}`)
		this.name = 'ConnectorNotFoundError'
	}
}

export class ConnectorRegistry {
	private readonly connectors = new Map<ProviderId, Connector>()
	private readonly providers = new Map<VendorId, ProviderAdapter>()

	registerConnector(c: Connector): void {
		this.connectors.set(c.id, c)
	}
	registerProvider(p: ProviderAdapter): void {
		this.providers.set(p.id, p)
	}

	getConnector(id: ProviderId): Connector {
		const c = this.connectors.get(id)
		if (!c) throw new ConnectorNotFoundError(id)
		return c
	}
	getProvider(id: VendorId): ProviderAdapter {
		const p = this.providers.get(id)
		if (!p) throw new ConnectorNotFoundError(id)
		return p
	}

	allConnectors(): readonly Connector[] {
		return Array.from(this.connectors.values())
	}
	allProviders(): readonly ProviderAdapter[] {
		return Array.from(this.providers.values())
	}
}

// ─────────────────────────────────────────────────────────────────────
// Errors (per-module — outside voice HIGH on connector-core errors.ts)
// ─────────────────────────────────────────────────────────────────────

/** Vendor errors (managed agent product side). */
export class VendorTimeoutError extends Error {
	constructor(public readonly vendor: VendorId) {
		super(`vendor timeout: ${vendor}`)
		this.name = 'VendorTimeoutError'
	}
}
export class VendorRateLimitError extends Error {
	constructor(
		public readonly vendor: VendorId,
		public readonly retry_after_seconds: number
	) {
		super(`vendor rate-limited: ${vendor} (retry in ${retry_after_seconds}s)`)
		this.name = 'VendorRateLimitError'
	}
}
export class VendorUnavailableError extends Error {
	constructor(
		public readonly vendor: VendorId,
		public readonly status_code: number
	) {
		super(`vendor unavailable: ${vendor} (${status_code})`)
		this.name = 'VendorUnavailableError'
	}
}
export class VendorAuthError extends Error {
	constructor(public readonly vendor: VendorId) {
		super(`vendor auth failed: ${vendor}`)
		this.name = 'VendorAuthError'
	}
}
export class VendorResponseError extends Error {
	constructor(
		public readonly vendor: VendorId,
		message: string
	) {
		super(`vendor malformed response: ${vendor} — ${message}`)
		this.name = 'VendorResponseError'
	}
}

/** Webhook errors. */
export class WebhookSignatureError extends Error {
	constructor(public readonly provider: ProviderId | VendorId) {
		super(`webhook signature verification failed: ${provider}`)
		this.name = 'WebhookSignatureError'
	}
}

/** OAuth / connector errors. */
export class TokenExpiredError extends Error {
	constructor(public readonly provider: ProviderId) {
		super(`token expired: ${provider}`)
		this.name = 'TokenExpiredError'
	}
}
export class TokenRefreshError extends Error {
	constructor(
		public readonly provider: ProviderId,
		message: string
	) {
		super(`token refresh failed: ${provider} — ${message}`)
		this.name = 'TokenRefreshError'
	}
}
export class ConnectorRevokedError extends Error {
	constructor(public readonly provider: ProviderId) {
		super(`connector revoked by user: ${provider}`)
		this.name = 'ConnectorRevokedError'
	}
}

/** Vault errors. */
export class VaultUnavailableError extends Error {
	constructor(message = 'vault / KMS unavailable') {
		super(message)
		this.name = 'VaultUnavailableError'
	}
}
export class VaultMintError extends Error {
	constructor(
		public readonly provider: ProviderId,
		message: string
	) {
		super(`failed to mint scoped credential for ${provider}: ${message}`)
		this.name = 'VaultMintError'
	}
}
