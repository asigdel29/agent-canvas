/**
 * Minimal client for any OpenAI-compatible `/chat/completions` endpoint.
 *
 * One adapter covers every provider that speaks the OpenAI chat API:
 * OpenAI itself, Gemini's OpenAI-compatible surface, Groq, OpenRouter,
 * Together, Mistral, and local servers (LM Studio, Ollama). The target
 * is selected by the per-agent `baseUrl`; the wire format is identical.
 *
 * The adapter translates in both directions between the orchestrator's
 * canonical Anthropic-style contract ({@link CreateMessageRequest} /
 * {@link CreateMessageResponse}) and the OpenAI chat schema, so the run
 * loop sees a single uniform shape regardless of provider:
 *
 *   request:   system prompt + content-block history + tool schemas
 *              → OpenAI `messages[]` (system/user/assistant/tool),
 *                `tools[]` (function defs), `tool_choice`.
 *   response:  OpenAI `choices[0].message` (+ `tool_calls`) and
 *              `finish_reason` → assistant content blocks and
 *              `stop_reason`.
 *
 * Limitations, by design:
 *   - Non-streaming, matching the Anthropic client and the run loop.
 *   - Anthropic's built-in computer-use tool (`computer_20241022`) has
 *     no OpenAI equivalent and is dropped from the tool list; agents
 *     that need it must run on the Anthropic provider.
 *
 * Security: the API key is sent only as a Bearer header and never
 * appears in any thrown message; error bodies are parsed for a short
 * code/message and nothing else is echoed.
 *
 * @author asigdel29
 */

import {
	ModelAuthError,
	ModelRateLimitError,
	ModelRequestError,
	ModelServerError,
	type ModelClient,
} from './modelClient.js'
import {
	isComputerToolSchema,
	type ContentBlock,
	type CreateMessageRequest,
	type CreateMessageResponse,
	type ToolSchema,
} from './anthropicClient.js'

const DEFAULT_TIMEOUT_MS = 60_000

/* -------------------------------------------------------------- *
 * OpenAI wire types (only the fields this adapter reads/writes)  *
 * -------------------------------------------------------------- */

interface OpenAiToolCall {
	readonly id: string
	readonly type: 'function'
	readonly function: { readonly name: string; readonly arguments: string }
}

type OpenAiMessage =
	| { role: 'system'; content: string }
	| { role: 'user'; content: string }
	| { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
	| { role: 'tool'; tool_call_id: string; content: string }

interface OpenAiResponse {
	readonly id?: string
	readonly model?: string
	readonly choices?: ReadonlyArray<{
		readonly message?: {
			readonly content?: string | null
			readonly tool_calls?: readonly OpenAiToolCall[]
		}
		readonly finish_reason?: string
	}>
	readonly usage?: {
		readonly prompt_tokens?: number
		readonly completion_tokens?: number
	}
}

/* -------------------------------------------------------------- *
 * Client                                                         *
 * -------------------------------------------------------------- */

export interface OpenAiCompatibleClientOptions {
	/** Bearer credential for the endpoint. Required. */
	readonly apiKey: string
	/**
	 * API root, e.g. `https://api.openai.com/v1`. The adapter appends
	 * `/chat/completions`. Required; validated by the caller (factory)
	 * before construction.
	 */
	readonly baseUrl: string
	/** Test seam — defaults to `globalThis.fetch`. */
	readonly fetchImpl?: typeof fetch
	/** Per-request timeout in milliseconds. Defaults to 60s. */
	readonly timeoutMs?: number
}

export class OpenAiCompatibleClient implements ModelClient {
	private readonly apiKey: string
	private readonly endpoint: string
	private readonly fetchImpl: typeof fetch
	private readonly timeoutMs: number

	/**
	 * @param opts the credential, endpoint, and optional seams.
	 * @throws Error when `apiKey` or `baseUrl` is empty.
	 */
	constructor(opts: OpenAiCompatibleClientOptions) {
		if (!opts.apiKey) throw new Error('OpenAiCompatibleClient: apiKey is required')
		if (!opts.baseUrl) throw new Error('OpenAiCompatibleClient: baseUrl is required')
		this.apiKey = opts.apiKey
		this.endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`
		this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
	}

	async createMessage(req: CreateMessageRequest): Promise<CreateMessageResponse> {
		const body: Record<string, unknown> = {
			model: req.model,
			messages: toOpenAiMessages(req),
			max_tokens: req.max_tokens,
		}
		if (typeof req.temperature === 'number') body['temperature'] = req.temperature
		const tools = toOpenAiTools(req.tools)
		if (tools.length > 0) {
			body['tools'] = tools
			const choice = toOpenAiToolChoice(req.tool_choice)
			if (choice) body['tool_choice'] = choice
		}

		const res = await this.fetchImpl(this.endpoint, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(this.timeoutMs),
		})
		if (!res.ok) await this.throwError(res)
		const json = (await res.json()) as OpenAiResponse
		return fromOpenAiResponse(json, req.model)
	}

	/**
	 * Map a non-2xx response onto the {@link ModelError} hierarchy. Reads
	 * a short `error.code` / `error.message` from the body when present;
	 * never includes the request or key.
	 */
	private async throwError(res: Response): Promise<never> {
		let code = 'unknown'
		let message = `HTTP ${res.status}`
		try {
			const body = (await res.json()) as {
				error?: { code?: string; type?: string; message?: string }
			}
			code = body.error?.code ?? body.error?.type ?? code
			message = body.error?.message ?? message
		} catch {
			// non-JSON error body; keep defaults.
		}
		if (res.status === 401 || res.status === 403) {
			throw new ModelAuthError(code, message)
		}
		if (res.status === 429) {
			const retryAfter = res.headers.get('retry-after')
			const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : undefined
			throw new ModelRateLimitError(
				code,
				message,
				Number.isFinite(seconds) ? (seconds as number) : undefined
			)
		}
		if (res.status >= 500) throw new ModelServerError(res.status, code, message)
		throw new ModelRequestError(res.status, code, message)
	}
}

/* -------------------------------------------------------------- *
 * Request translation: canonical → OpenAI                        *
 * -------------------------------------------------------------- */

/**
 * Flatten the canonical system prompt + content-block history into an
 * ordered OpenAI `messages[]`.
 *
 * Assistant `tool_use` blocks become `tool_calls` on the assistant
 * message; the matching `tool_result` blocks (which the run loop carries
 * inside a following user turn) become standalone `role:'tool'` messages
 * keyed by `tool_call_id`, preserving the call/result pairing OpenAI
 * requires.
 */
function toOpenAiMessages(req: CreateMessageRequest): OpenAiMessage[] {
	const out: OpenAiMessage[] = []
	if (req.system) out.push({ role: 'system', content: req.system })

	for (const msg of req.messages) {
		if (typeof msg.content === 'string') {
			out.push(
				msg.role === 'assistant'
					? { role: 'assistant', content: msg.content }
					: { role: 'user', content: msg.content }
			)
			continue
		}
		if (msg.role === 'assistant') {
			out.push(assistantBlocksToMessage(msg.content))
			continue
		}
		// User turn carrying content blocks: in this loop those are
		// tool_result blocks (plus, rarely, free text).
		pushUserBlocks(out, msg.content)
	}
	return out
}

/** Build a single assistant message from its text + tool_use blocks. */
function assistantBlocksToMessage(blocks: readonly ContentBlock[]): OpenAiMessage {
	const text = blocks
		.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
		.map((b) => b.text)
		.join('\n')
	const toolCalls: OpenAiToolCall[] = []
	for (const b of blocks) {
		if (b.type !== 'tool_use') continue
		toolCalls.push({
			id: b.id,
			type: 'function',
			function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
		})
	}
	if (toolCalls.length > 0) {
		// OpenAI requires content to be null (not "") when only tool calls
		// are present, or a string alongside the calls.
		return { role: 'assistant', content: text.length > 0 ? text : null, tool_calls: toolCalls }
	}
	return { role: 'assistant', content: text }
}

/** Emit `role:'tool'` messages for tool_result blocks; text → a user turn. */
function pushUserBlocks(out: OpenAiMessage[], blocks: readonly ContentBlock[]): void {
	const freeText: string[] = []
	for (const b of blocks) {
		if (b.type === 'tool_result') {
			out.push({
				role: 'tool',
				tool_call_id: b.tool_use_id,
				content: toolResultText(b.content),
			})
		} else if (b.type === 'text') {
			freeText.push(b.text)
		}
	}
	if (freeText.length > 0) out.push({ role: 'user', content: freeText.join('\n') })
}

/** Normalize a tool_result `content` (string or text parts) to a string. */
function toolResultText(
	content: string | ReadonlyArray<{ type: 'text'; text: string }>
): string {
	return typeof content === 'string' ? content : content.map((c) => c.text).join('\n')
}

/**
 * Convert canonical tool schemas to OpenAI function-tool defs, dropping
 * the Anthropic-only computer-use tool (it has no OpenAI equivalent).
 */
function toOpenAiTools(
	tools: readonly ToolSchema[] | undefined
): Array<Record<string, unknown>> {
	if (!tools) return []
	const out: Array<Record<string, unknown>> = []
	for (const t of tools) {
		if (isComputerToolSchema(t)) continue
		out.push({
			type: 'function',
			function: {
				name: t.name,
				description: t.description,
				parameters: t.input_schema,
			},
		})
	}
	return out
}

/** Map the canonical `tool_choice` onto OpenAI's vocabulary. */
function toOpenAiToolChoice(
	choice: CreateMessageRequest['tool_choice']
): string | undefined {
	if (!choice) return undefined
	if (choice.type === 'any') return 'required'
	if (choice.type === 'none') return 'none'
	return 'auto'
}

/* -------------------------------------------------------------- *
 * Response translation: OpenAI → canonical                       *
 * -------------------------------------------------------------- */

/**
 * Convert an OpenAI chat response into the canonical assistant turn.
 *
 * @param json the raw OpenAI response body.
 * @param requestedModel echoed into the result when the body omits it.
 * @return the canonical response with text and `tool_use` blocks.
 */
function fromOpenAiResponse(
	json: OpenAiResponse,
	requestedModel: string
): CreateMessageResponse {
	const choice = json.choices?.[0]
	const message = choice?.message
	const content: ContentBlock[] = []

	const text = message?.content
	if (typeof text === 'string' && text.length > 0) {
		content.push({ type: 'text', text })
	}
	for (const call of message?.tool_calls ?? []) {
		content.push({
			type: 'tool_use',
			id: call.id,
			name: call.function.name,
			input: safeParseArgs(call.function.arguments),
		})
	}

	return {
		id: json.id ?? '',
		model: json.model ?? requestedModel,
		role: 'assistant',
		content,
		stop_reason: mapFinishReason(choice?.finish_reason, content),
		stop_sequence: null,
		usage: {
			input_tokens: json.usage?.prompt_tokens ?? 0,
			output_tokens: json.usage?.completion_tokens ?? 0,
		},
	}
}

/**
 * Map an OpenAI `finish_reason` onto the canonical `stop_reason`. When a
 * tool call is present we always report `tool_use` so the run loop keeps
 * dispatching, regardless of how the provider labeled the stop.
 */
function mapFinishReason(
	reason: string | undefined,
	content: readonly ContentBlock[]
): CreateMessageResponse['stop_reason'] {
	if (content.some((b) => b.type === 'tool_use')) return 'tool_use'
	switch (reason) {
		case 'length':
			return 'max_tokens'
		case 'content_filter':
			return 'refusal'
		case 'tool_calls':
			return 'tool_use'
		case 'stop':
		default:
			return 'end_turn'
	}
}

/**
 * Parse tool-call arguments, tolerating an empty or malformed string by
 * returning an empty object. Providers occasionally emit `''` for a
 * no-argument call.
 */
function safeParseArgs(raw: string): Readonly<Record<string, unknown>> {
	if (!raw) return {}
	try {
		const parsed = JSON.parse(raw) as unknown
		return parsed && typeof parsed === 'object'
			? (parsed as Record<string, unknown>)
			: {}
	} catch {
		return {}
	}
}
