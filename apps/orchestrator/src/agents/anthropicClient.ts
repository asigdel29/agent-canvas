/**
 * Minimal Anthropic Messages client.
 *
 * No SDK dependency. Speaks the HTTP API directly so the orchestrator
 * bundle stays small and our retry / timeout / error-surface logic
 * stays under our control.
 *
 * Implements only what the run loop needs:
 *
 *   createMessage(req)   POST /v1/messages, single-shot (non-streaming).
 *                        Returns the full response after the model
 *                        finishes the turn — either with text or with
 *                        a tool-use block. Streaming lands in a
 *                        follow-up; non-streaming is enough to drive
 *                        the loop and keeps the first cut simple.
 *
 * Error model:
 *
 *   AnthropicAuthError      401 or 403 — caller surfaces "check key"
 *   AnthropicRateLimitError 429 with optional retry-after seconds
 *   AnthropicServerError    5xx — retry candidate
 *   AnthropicRequestError   4xx other — caller's fault, do not retry
 *
 * All four extend a single AnthropicError so callers can catch broad.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_TIMEOUT_MS = 60_000

/* -------------------------------------------------------------- *
 * Message + content types                                        *
 * -------------------------------------------------------------- */

export type Role = 'user' | 'assistant'

export type ContentBlock =
	| { type: 'text'; text: string }
	| {
			type: 'tool_use'
			id: string
			name: string
			input: Readonly<Record<string, unknown>>
	  }
	| {
			type: 'tool_result'
			tool_use_id: string
			content: string | Array<{ type: 'text'; text: string }>
			is_error?: boolean
	  }

export interface Message {
	readonly role: Role
	readonly content: string | readonly ContentBlock[]
}

/**
 * One tool the model can call. Two shapes:
 *
 *   StandardToolSchema   the JSON-Schema-described custom tool
 *                        used by MCP and browser providers. The
 *                        model validates input against
 *                        input_schema before emitting tool_use.
 *
 *   ComputerToolSchema   Anthropic's built-in computer-use tool
 *                        (`computer_20241022`). The schema is
 *                        implicit on the model side; we just
 *                        declare the display dimensions. The model
 *                        sends tool_use with an `action` field
 *                        plus action-specific args.
 *
 * Both are flat objects so JSON serialization stays identical to
 * the Anthropic API contract.
 */
export type ToolSchema = StandardToolSchema | ComputerToolSchema

export interface StandardToolSchema {
	readonly name: string
	readonly description: string
	readonly input_schema: {
		readonly type: 'object'
		readonly properties: Readonly<Record<string, unknown>>
		readonly required?: readonly string[]
	}
}

export interface ComputerToolSchema {
	readonly type: 'computer_20241022'
	readonly name: 'computer'
	readonly display_width_px: number
	readonly display_height_px: number
	readonly display_number?: number
}

/** Type guard: cheap discriminator between the two shapes. */
export function isComputerToolSchema(t: ToolSchema): t is ComputerToolSchema {
	return (t as ComputerToolSchema).type === 'computer_20241022'
}

export interface CreateMessageRequest {
	readonly model: string
	readonly system?: string
	readonly messages: readonly Message[]
	readonly tools?: readonly ToolSchema[]
	readonly max_tokens: number
	readonly temperature?: number
	readonly tool_choice?: { type: 'auto' } | { type: 'any' } | { type: 'none' }
}

export interface CreateMessageResponse {
	readonly id: string
	readonly model: string
	readonly role: 'assistant'
	readonly content: ContentBlock[]
	readonly stop_reason:
		| 'end_turn'
		| 'max_tokens'
		| 'stop_sequence'
		| 'tool_use'
		| 'pause_turn'
		| 'refusal'
	readonly stop_sequence: string | null
	readonly usage: {
		readonly input_tokens: number
		readonly output_tokens: number
		readonly cache_creation_input_tokens?: number
		readonly cache_read_input_tokens?: number
	}
}

/* -------------------------------------------------------------- *
 * Error hierarchy                                                *
 * -------------------------------------------------------------- */

export class AnthropicError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string
	) {
		super(`[anthropic ${status} ${code}] ${message}`)
		this.name = 'AnthropicError'
	}
}
export class AnthropicAuthError extends AnthropicError {
	constructor(code: string, message: string) {
		super(401, code, message)
		this.name = 'AnthropicAuthError'
	}
}
export class AnthropicRateLimitError extends AnthropicError {
	constructor(
		code: string,
		message: string,
		public readonly retry_after_seconds?: number
	) {
		super(429, code, message)
		this.name = 'AnthropicRateLimitError'
	}
}
export class AnthropicServerError extends AnthropicError {
	constructor(status: number, code: string, message: string) {
		super(status, code, message)
		this.name = 'AnthropicServerError'
	}
}
export class AnthropicRequestError extends AnthropicError {
	constructor(status: number, code: string, message: string) {
		super(status, code, message)
		this.name = 'AnthropicRequestError'
	}
}

/* -------------------------------------------------------------- *
 * Client                                                         *
 * -------------------------------------------------------------- */

export interface AnthropicClientOptions {
	readonly apiKey: string
	/** Test seam — defaults to globalThis.fetch. */
	readonly fetchImpl?: typeof fetch
	/** Per-request timeout. Defaults to 60s. */
	readonly timeoutMs?: number
}

export class AnthropicClient {
	private readonly apiKey: string
	private readonly fetchImpl: typeof fetch
	private readonly timeoutMs: number

	constructor(opts: AnthropicClientOptions) {
		if (!opts.apiKey) throw new Error('AnthropicClient: apiKey is required')
		this.apiKey = opts.apiKey
		this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
	}

	async createMessage(req: CreateMessageRequest): Promise<CreateMessageResponse> {
		const res = await this.fetchImpl(ANTHROPIC_API_URL, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-api-key': this.apiKey,
				'anthropic-version': ANTHROPIC_VERSION,
			},
			body: JSON.stringify(req),
			signal: AbortSignal.timeout(this.timeoutMs),
		})
		if (!res.ok) await this.throwError(res)
		const json = (await res.json()) as CreateMessageResponse
		return json
	}

	private async throwError(res: Response): Promise<never> {
		let code = 'unknown'
		let message = `HTTP ${res.status}`
		try {
			const body = (await res.json()) as { error?: { type?: string; message?: string } }
			code = body.error?.type ?? code
			message = body.error?.message ?? message
		} catch {
			// non-JSON error body; keep defaults
		}
		if (res.status === 401 || res.status === 403) {
			throw new AnthropicAuthError(code, message)
		}
		if (res.status === 429) {
			const retryAfter = res.headers.get('retry-after')
			const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : undefined
			throw new AnthropicRateLimitError(
				code,
				message,
				Number.isFinite(seconds) ? (seconds as number) : undefined
			)
		}
		if (res.status >= 500) throw new AnthropicServerError(res.status, code, message)
		throw new AnthropicRequestError(res.status, code, message)
	}
}

/**
 * Construct a client from the standard env var. Returns null if
 * unset so callers can fall back to a stub or surface a clear
 * "key not configured" error.
 */
export function tryCreateAnthropicClient(): AnthropicClient | null {
	const apiKey = process.env['ANTHROPIC_API_KEY']
	if (!apiKey) return null
	return new AnthropicClient({ apiKey })
}
