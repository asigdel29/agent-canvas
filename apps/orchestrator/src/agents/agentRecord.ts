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
 */

import type { UserId } from '@agent-canvas/orchestrator-types'

/**
 * Branded string ids. Same pattern as RunId / RoomId in
 * orchestrator-types so all our identifiers are mutually
 * non-assignable at the type level.
 */
export type AgentId = string & { readonly __brand: 'AgentId' }
export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' }
export type ApprovalId = string & { readonly __brand: 'ApprovalId' }

/**
 * The set of supported model ids. Kept in sync with the NewAgentModal
 * radio list in apps/canvas/src/agent/NewAgentModal.tsx. Adding a
 * model requires updating both the modal and this enum so the
 * orchestrator can validate.
 */
export type ModelId =
	| 'claude-opus-4-7'
	| 'claude-sonnet-4-6'
	| 'claude-haiku-4-5-20251001'

export const SUPPORTED_MODELS = [
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
	readonly model: ModelId
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
	readonly model: ModelId
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
	readonly model?: ModelId
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
 *   - model     must be in SUPPORTED_MODELS
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
	if (!SUPPORTED_MODELS.includes(input.model as ModelId)) {
		throw new AgentValidationError('model', `must be one of: ${SUPPORTED_MODELS.join(', ')}`)
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
