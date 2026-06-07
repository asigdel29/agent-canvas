/**
 * AgentRecord — the canonical agent definition.
 *
 * One row per user-created agent. Shape mirrors the postgres
 * `agents` table, with capability config rehydrated into the same
 * `AgentCapabilities` type the canvas-side code consumes.
 *
 * The record is the *definition* (what to do); per-execution state
 * lives in the existing event-log + run_current_state machinery
 * keyed on `run_id`. One agent can have many runs.
 *
 * `archived_at` is the soft-delete marker. We never hard-delete
 * because audit_log rows hold the agent id and we want them
 * forensically readable forever.
 * @author asigdel29
 */

import type { UserId } from '@agent-canvas/orchestrator-types'
import { isProvider, type Provider } from './modelClient.js'
import { validateModelBaseUrl } from './modelBaseUrl.js'

export type { Provider } from './modelClient.js'

/**
 * Branded string ids. Same pattern as RunId / RoomId in
 * orchestrator-types so all our identifiers are mutually
 * non-assignable at the type level.
 */
export type AgentId = string & { readonly __brand: 'AgentId' }
export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' }
export type ApprovalId = string & { readonly __brand: 'ApprovalId' }

/**
 * A model identifier. Each {@link Provider} owns its own id namespace
 * (Anthropic uses `claude-*`; an OpenAI-compatible endpoint uses
 * whatever ids that server exposes, e.g. `gpt-4o`, `gemini-2.0-flash`,
 * `llama-3.1-70b`). The orchestrator therefore treats the id as an
 * opaque, bounded-length string rather than a closed enum, and routes
 * by {@link AgentRecord.provider} instead.
 */
export type ModelId = string

/** Upper bound on a model id length, for storage and abuse sanity. */
export const MAX_MODEL_ID_LENGTH = 100

/**
 * Anthropic model presets the canvas offers by default. Advisory only —
 * the orchestrator accepts any non-empty id so newer models work without
 * a server change. Kept loosely in step with the NewAgentModal radios.
 */
export const ANTHROPIC_PRESET_MODELS = [
	'claude-opus-4-7',
	'claude-sonnet-4-6',
	'claude-haiku-4-5-20251001',
] as const

/**
 * Mirror of capabilities.ts on the canvas side. Kept here so the
 * orchestrator does not pull in canvas imports. The two must stay
 * in lockstep; a divergence is a bug.
 */
export type McpAuth =
	| { readonly type: 'bearer'; readonly token: string }
	| { readonly type: 'oauth' }

export interface McpServerRef {
	readonly id: string
	readonly url: string
	readonly auth?: McpAuth
	readonly trust: 'trusted' | 'untrusted'
}

export interface ComputerUseConfig {
	readonly enabled: boolean
	readonly provider: 'e2b' | 'browserbase' | 'none'
}

export interface BrowserUseConfig {
	readonly enabled: boolean
	readonly persist_cookies: boolean
}

export interface AgentCapabilities {
	readonly computer_use: ComputerUseConfig
	readonly browser_use: BrowserUseConfig
	readonly mcp_servers: readonly McpServerRef[]
}

export interface AgentRecord {
	readonly id: AgentId
	readonly workspace_id: WorkspaceId
	readonly owner_user_id: UserId
	readonly name: string
	readonly purpose: string
	/** Which model family the run loop uses; routes client construction. */
	readonly provider: Provider
	readonly model: ModelId
	/**
	 * For `provider === 'openai'`, the OpenAI-compatible API root the
	 * orchestrator posts to (e.g. `https://api.openai.com/v1`). Null for
	 * the native Anthropic provider, which has a fixed endpoint.
	 */
	readonly model_base_url: string | null
	readonly system_prompt: string
	readonly capabilities: AgentCapabilities
	readonly created_at: string // ISO 8601
	readonly updated_at: string
	readonly archived_at: string | null
}

/**
 * Input to create() — everything the caller must supply. The store
 * fills in id / timestamps / archived_at.
 */
export interface CreateAgentInput {
	readonly workspace_id: WorkspaceId
	readonly owner_user_id: UserId
	readonly name: string
	readonly purpose: string
	/** Defaults to `'anthropic'` when omitted, for backward compatibility. */
	readonly provider?: Provider
	readonly model: ModelId
	/** Required when `provider === 'openai'`; ignored otherwise. */
	readonly model_base_url?: string | null
	readonly system_prompt: string
	readonly capabilities: AgentCapabilities
}

/**
 * Patch input for update(). All fields optional; only the supplied
 * fields are written. Note: workspace_id and owner_user_id are NOT
 * patchable — moving an agent across workspaces is a deliberate
 * future migration, not a routine update.
 */
export interface UpdateAgentInput {
	readonly name?: string
	readonly purpose?: string
	readonly provider?: Provider
	readonly model?: ModelId
	readonly model_base_url?: string | null
	readonly system_prompt?: string
	readonly capabilities?: AgentCapabilities
}

/**
 * Pending approval — emitted when the run loop hits a destructive
 * or irreversible tool call. The loop blocks on a future that
 * resolves when ApprovalStore.resolve() flips this row.
 *
 *   tool_input    The exact args the model wants to call the tool
 *                 with. Stored as a typed JSON blob so the UI can
 *                 render them verbatim for human review.
 *   safety        Matches the SafetyClassifier enum. Drives the UI
 *                 treatment (irreversible pulses live-pink).
 */
export interface PendingApproval {
	readonly id: ApprovalId
	readonly agent_id: AgentId
	readonly run_id: string
	readonly tool_name: string
	readonly tool_input: Readonly<Record<string, unknown>>
	readonly tool_description: string
	readonly safety: 'destructive' | 'irreversible'
	readonly requested_at: string
	readonly resolved_at: string | null
	readonly resolved_by_user_id: UserId | null
	readonly resolution: 'approved' | 'rejected' | null
}

export class AgentNotFoundError extends Error {
	constructor(public readonly agent_id: AgentId) {
		super(`Agent ${agent_id} not found`)
		this.name = 'AgentNotFoundError'
	}
}

export class AgentValidationError extends Error {
	constructor(public readonly field: string, message: string) {
		super(`Agent ${field}: ${message}`)
		this.name = 'AgentValidationError'
	}
}

/**
 * Validates a create-input against the basic rules. Returns nothing
 * on success; throws AgentValidationError on the first violation so
 * the API layer can surface a 400 with the field name.
 *
 * Rules:
 *   - name      non-empty, ≤ 120 chars
 *   - purpose   ≤ 280 chars (twitter-len; long enough, short enough)
 *   - provider  when present, must be a known {@link Provider}
 *   - model     non-empty, ≤ MAX_MODEL_ID_LENGTH (ids are opaque per
 *               provider, so no closed-set check)
 *   - model_base_url   required for the `openai` provider and must pass
 *               the SSRF guard ({@link validateModelBaseUrl}); rejected
 *               for `anthropic`, which has a fixed endpoint
 *   - system_prompt   ≤ 32 KiB (storage sanity; tokenizers cap higher)
 *   - capabilities.mcp_servers each must have a non-empty id and a
 *     parseable https/http URL
 */
export function validateCreateInput(input: CreateAgentInput): void {
	if (!input.name.trim()) throw new AgentValidationError('name', 'must not be empty')
	if (input.name.length > 120) throw new AgentValidationError('name', 'max 120 characters')
	if (input.purpose.length > 280) {
		throw new AgentValidationError('purpose', 'max 280 characters')
	}
	if (input.provider !== undefined && !isProvider(input.provider)) {
		throw new AgentValidationError('provider', "must be 'anthropic' or 'openai'")
	}
	const provider: Provider = input.provider ?? 'anthropic'
	if (!input.model.trim()) throw new AgentValidationError('model', 'must not be empty')
	if (input.model.length > MAX_MODEL_ID_LENGTH) {
		throw new AgentValidationError('model', `max ${MAX_MODEL_ID_LENGTH} characters`)
	}
	if (provider === 'openai') {
		const baseUrl = input.model_base_url?.trim()
		if (!baseUrl) {
			throw new AgentValidationError(
				'model_base_url',
				'required for the openai provider'
			)
		}
		const check = validateModelBaseUrl(baseUrl)
		if (!check.ok) {
			throw new AgentValidationError('model_base_url', `rejected: ${check.reason}`)
		}
	}
	if (input.system_prompt.length > 32 * 1024) {
		throw new AgentValidationError('system_prompt', 'max 32 KiB')
	}
	for (const [i, s] of input.capabilities.mcp_servers.entries()) {
		if (!s.id.trim()) {
			throw new AgentValidationError(`mcp_servers[${i}].id`, 'must not be empty')
		}
		try {
			const u = new URL(s.url)
			if (u.protocol !== 'https:' && u.protocol !== 'http:') {
				throw new Error('not http(s)')
			}
		} catch {
			throw new AgentValidationError(
				`mcp_servers[${i}].url`,
				'must be a valid http(s) URL'
			)
		}
	}
}
