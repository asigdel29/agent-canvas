/**
 * Provider-agnostic model-client contract.
 *
 * The run loop drives an agent by repeatedly calling one method:
 * `createMessage(req) → response`. The request/response shapes are the
 * Anthropic content-block format defined in `anthropicClient.ts`; this
 * module promotes that format to the orchestrator's *internal canonical
 * contract* so the loop can talk to any provider through a single
 * interface.
 *
 * Two implementations satisfy `ModelClient`:
 *
 *   AnthropicClient          native Anthropic Messages API.
 *   OpenAiCompatibleClient   any OpenAI-compatible `/chat/completions`
 *                            endpoint (OpenAI, Gemini's OpenAI surface,
 *                            Groq, OpenRouter, Together, local servers).
 *
 * The run loop neither knows nor cares which one it holds.
 *
 * Errors are normalized to the {@link ModelError} hierarchy so callers
 * can branch on auth / rate-limit / server / request failures without
 * importing a provider-specific error type. An implementation MUST NOT
 * embed the API key or the full request body in any error message.
 *
 * @author asigdel29
 */

import type {
	CreateMessageRequest,
	CreateMessageResponse,
} from './anthropicClient.js'

// Re-export the canonical message types so downstream modules can treat
// `modelClient.js` as the single source of truth for the contract.
export type {
	ContentBlock,
	CreateMessageRequest,
	CreateMessageResponse,
	Message,
	Role,
	StandardToolSchema,
	ComputerToolSchema,
	ToolSchema,
} from './anthropicClient.js'

/**
 * The set of supported model providers.
 *
 *   'anthropic'   native Anthropic Messages API.
 *   'openai'      any OpenAI-compatible `/chat/completions` endpoint,
 *                 selected by a per-agent base URL.
 */
export type Provider = 'anthropic' | 'openai'

/** Type guard: true when `value` is a known {@link Provider}. */
export function isProvider(value: unknown): value is Provider {
	return value === 'anthropic' || value === 'openai'
}

/**
 * The single method the run loop depends on. Implementations issue one
 * non-streaming model turn and return the full assistant response.
 */
export interface ModelClient {
	/**
	 * Run one model turn.
	 *
	 * @param req the canonical request (model id, system prompt,
	 *   message history, tool schemas, token cap).
	 * @return the assistant turn, including any `tool_use` blocks.
	 * @throws ModelError on any non-2xx response, normalized by class.
	 */
	createMessage(req: CreateMessageRequest): Promise<CreateMessageResponse>
}

/* -------------------------------------------------------------- *
 * Error hierarchy                                                *
 * -------------------------------------------------------------- */

/**
 * Base class for every model-client failure. Carries the upstream HTTP
 * status and a short machine code so callers can map to a remediation
 * message without parsing prose.
 */
export class ModelError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string
	) {
		super(`[model ${status} ${code}] ${message}`)
		this.name = 'ModelError'
	}
}

/** 401 / 403 — the supplied key is missing, invalid, or unauthorized. */
export class ModelAuthError extends ModelError {
	constructor(code: string, message: string) {
		super(401, code, message)
		this.name = 'ModelAuthError'
	}
}

/** 429 — the provider is rate-limiting; `retry_after_seconds` when known. */
export class ModelRateLimitError extends ModelError {
	constructor(
		code: string,
		message: string,
		public readonly retry_after_seconds?: number
	) {
		super(429, code, message)
		this.name = 'ModelRateLimitError'
	}
}

/** 5xx — a transient upstream failure; a retry candidate. */
export class ModelServerError extends ModelError {
	constructor(status: number, code: string, message: string) {
		super(status, code, message)
		this.name = 'ModelServerError'
	}
}

/** Other 4xx — a caller-side fault that must not be retried verbatim. */
export class ModelRequestError extends ModelError {
	constructor(status: number, code: string, message: string) {
		super(status, code, message)
		this.name = 'ModelRequestError'
	}
}
