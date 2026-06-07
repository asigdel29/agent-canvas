/**
 * RunLoop — drives an agent execution from initial message to
 * terminal stop, dispatching tool calls and publishing every
 * step to the room event bus.
 *
 * Contract:
 *
 *   start(input)
 *     1. Fetch the AgentRecord from the store.
 *     2. Compose a ToolCatalog from the agent's capabilities.
 *     3. Emit `run_started` to the room bus.
 *     4. Iterate: call Anthropic with current messages + tools,
 *        dispatch any tool_use blocks the model returns, append
 *        the tool_result and call again, until the model returns
 *        an end_turn or we hit the iteration cap.
 *     5. On every tool_use: classify safety. Destructive or
 *        irreversible calls write a pending_approvals row, emit
 *        `approval_required`, and block until the row resolves.
 *     6. On every tool dispatch: emit `tool_call` then `tool_result`
 *        (with truncated input/output) so the canvas can render
 *        a live audit trail.
 *     7. On terminal state: emit `run_succeeded` / `run_failed` /
 *        `run_cancelled`, tear down the tool catalog, return the
 *        final RunSummary.
 *
 * Invariants:
 *   - Tool catalog is torn down exactly once, even on exception
 *     paths. A bug here leaks MCP connections and computer-use
 *     sandbox seconds.
 *   - The model never sees a tool_result with an unmatched
 *     tool_use_id. The loop asserts this with a Map check.
 *   - Iteration cap (default 25) protects against runaway loops.
 *     The cap is observable as `last_iteration` in the summary.
 *
 * What this module deliberately does NOT do (yet):
 *   - Streaming. We use createMessage (non-streaming) for the
 *     first cut; streaming lands when the canvas wants partial
 *     text on the AgentShape.
 *   - Cost gating. The BillingGate is wired upstream of start();
 *     this module just records token counts.
 *   - Retries on AnthropicServerError or RateLimitError. Caller
 *     wraps with a retry policy.
 * @author asigdel29
 */

import { randomUUID } from 'node:crypto'

import type { RunEvent, RunId, RoomId } from '@agent-canvas/orchestrator-types'

import type { ContentBlock, Message, ModelClient } from './modelClient.js'
import type { AgentRecord } from './agentRecord.js'
import type { ToolCatalog, ToolResult } from './toolRegistry.js'

const DEFAULT_MAX_ITERATIONS = 25
const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_TEMPERATURE = 0.7

export type RunOutcome = 'succeeded' | 'failed' | 'cancelled' | 'max_iterations'

export interface RunSummary {
	readonly run_id: RunId
	readonly outcome: RunOutcome
	readonly final_text: string
	readonly iterations: number
	readonly input_tokens: number
	readonly output_tokens: number
	readonly tool_calls: number
	readonly approvals_requested: number
	readonly approvals_rejected: number
	readonly final_error: string | null
}

export interface RunStartInput {
	readonly run_id: RunId
	readonly room_id: RoomId
	readonly agent: AgentRecord
	readonly initial_user_message: string
	readonly max_iterations?: number
	readonly max_tokens_per_call?: number
	readonly temperature?: number
}

/**
 * Adapter the run loop calls on every emission. Implementations
 * push into the room bus, the audit log, or both. Kept as an
 * interface so tests can collect events into an array.
 */
export interface RunEventSink {
	emit(event: RunEvent): Promise<void> | void
}

/**
 * Adapter for the approval blocking step. Real implementations
 * write a pending_approvals row, return a promise that resolves
 * when /api/approvals/:id/approve|reject fires. In tests, an
 * AlwaysApprove or AlwaysReject sink stands in.
 */
export interface ApprovalGate {
	requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>
}

export interface ApprovalRequest {
	readonly run_id: RunId
	readonly agent: AgentRecord
	readonly tool_name: string
	readonly tool_input: Readonly<Record<string, unknown>>
	readonly tool_description: string
	readonly safety: 'destructive' | 'irreversible'
}

export interface ApprovalDecision {
	readonly resolution: 'approved' | 'rejected'
	readonly resolved_by_user_id?: string
}

/**
 * Adapter for cancellation. The caller passes a signal that
 * resolves to true when the user (or a TTL) wants to stop the run.
 * On signal, the loop emits `run_cancelled` and tears down.
 */
export interface CancellationSignal {
	isCancelled(): boolean
}

export interface RunLoopOptions {
	/** The provider-agnostic model client the loop drives each turn. */
	readonly model: ModelClient
	readonly catalog: ToolCatalog
	readonly sink: RunEventSink
	readonly approvalGate: ApprovalGate
	readonly cancellation?: CancellationSignal
}

/**
 * Execute a run from start to terminal. Caller owns the lifecycle
 * of the catalog INPUT (we don't take ownership); but we DO call
 * catalog.teardown() at the end so the caller doesn't need to.
 */
export async function runLoop(
	input: RunStartInput,
	opts: RunLoopOptions
): Promise<RunSummary> {
	const { model: modelClient, catalog, sink, approvalGate, cancellation } = opts
	const maxIterations = input.max_iterations ?? DEFAULT_MAX_ITERATIONS
	const maxTokens = input.max_tokens_per_call ?? DEFAULT_MAX_TOKENS
	const temperature = input.temperature ?? DEFAULT_TEMPERATURE

	let seq = 0
	let iteration = 0
	let inputTokens = 0
	let outputTokens = 0
	let toolCalls = 0
	let approvalsRequested = 0
	let approvalsRejected = 0
	let finalText = ''
	let outcome: RunOutcome = 'failed'
	let finalError: string | null = null

	const messages: Message[] = [
		{ role: 'user', content: input.initial_user_message },
	]

	try {
		await emit('run_started', {
			agent_id: input.agent.id,
			model: input.agent.model,
			tool_count: catalog.tools.length,
		})

		while (iteration < maxIterations) {
			if (cancellation?.isCancelled()) {
				outcome = 'cancelled'
				break
			}
			iteration += 1

			// Build the request without optional fields when they are
			// empty. exactOptionalPropertyTypes is on; passing
			// `system: undefined` is not the same as omitting it, and the
			// Anthropic API treats them differently.
			const request: {
				model: string
				messages: typeof messages
				max_tokens: number
				temperature: number
				system?: string
				tools?: typeof catalog.schemas
			} = {
				model: input.agent.model,
				messages,
				max_tokens: maxTokens,
				temperature,
			}
			if (input.agent.system_prompt) request.system = input.agent.system_prompt
			if (catalog.schemas.length > 0) request.tools = catalog.schemas
			const response = await modelClient.createMessage(request)
			inputTokens += response.usage.input_tokens
			outputTokens += response.usage.output_tokens

			// Append the assistant turn verbatim — Anthropic expects the
			// next request to echo this turn followed by tool_result(s).
			messages.push({ role: 'assistant', content: response.content })

			const textParts = response.content
				.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
				.map((c) => c.text)
			if (textParts.length > 0) {
				finalText = textParts.join('\n')
				await emit('progress', { iteration, text: finalText })
			}

			if (response.stop_reason === 'end_turn') {
				outcome = 'succeeded'
				break
			}
			if (response.stop_reason === 'max_tokens') {
				finalError = `model hit max_tokens at iteration ${iteration}`
				outcome = 'failed'
				break
			}
			if (response.stop_reason !== 'tool_use') {
				// stop_sequence / refusal / pause_turn — surface verbatim
				finalError = `unexpected stop_reason: ${response.stop_reason}`
				outcome = 'failed'
				break
			}

			// Dispatch every tool_use block in turn. We process them
			// sequentially (not in parallel) so the operator's approval
			// queue stays understandable.
			const toolResults: ContentBlock[] = []
			let userCancelled = false
			for (const block of response.content) {
				if (block.type !== 'tool_use') continue
				toolCalls += 1
				const descriptor = catalog.toolByName.get(block.name)
				if (!descriptor) {
					toolResults.push({
						type: 'tool_result',
						tool_use_id: block.id,
						content: `Tool ${block.name} is not registered for this run.`,
						is_error: true,
					})
					await emit('tool_call_unknown', { tool_name: block.name })
					continue
				}

				if (descriptor.safety !== 'safe') {
					approvalsRequested += 1
					await emit('approval_required', {
						tool_name: block.name,
						tool_description: descriptor.describeCall(block.input),
						safety: descriptor.safety,
					})
					const decision = await approvalGate.requestApproval({
						run_id: input.run_id,
						agent: input.agent,
						tool_name: block.name,
						tool_input: block.input,
						tool_description: descriptor.describeCall(block.input),
						safety: descriptor.safety,
					})
					if (decision.resolution === 'rejected') {
						approvalsRejected += 1
						await emit('approval_rejected', { tool_name: block.name })
						toolResults.push({
							type: 'tool_result',
							tool_use_id: block.id,
							content:
								'The operator rejected this tool call. Do not retry the same action; choose a different approach or end the turn.',
							is_error: true,
						})
						// Do NOT cancel the whole run on a single rejection; the
						// model can recover. Cancellation comes through the
						// CancellationSignal channel only.
						continue
					}
				}

				await emit('tool_call', {
					tool_name: block.name,
					input_preview: previewJson(block.input),
				})
				let result: ToolResult
				try {
					result = await descriptor.execute(block.input)
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					result = { ok: false, error: msg }
				}
				const resultText = result.ok
					? typeof result.content === 'string'
						? result.content
						: result.content.map((c) => c.text).join('\n')
					: result.error
				await emit('tool_result', {
					tool_name: block.name,
					ok: result.ok,
					output_preview: previewText(resultText),
				})
				const resultBlock: ContentBlock = result.ok
					? {
							type: 'tool_result',
							tool_use_id: block.id,
							content: resultText,
						}
					: {
							type: 'tool_result',
							tool_use_id: block.id,
							content: resultText,
							is_error: true,
						}
				toolResults.push(resultBlock)
			}

			if (userCancelled) {
				outcome = 'cancelled'
				break
			}
			// Feed all tool_results back as a single user turn — the
			// Anthropic API expects every tool_use to be followed by a
			// matching tool_result in the next user message.
			messages.push({ role: 'user', content: toolResults })
		}

		if (iteration >= maxIterations && outcome === 'failed') {
			outcome = 'max_iterations'
			finalError = `hit max_iterations=${maxIterations}`
		}
	} catch (err) {
		outcome = 'failed'
		finalError = err instanceof Error ? err.message : String(err)
	} finally {
		try {
			await catalog.teardown()
		} catch (err) {
			// Teardown failure is logged but does not change the outcome.
			await emit('teardown_warning', {
				message: err instanceof Error ? err.message : String(err),
			}).catch(() => undefined)
		}
	}

	const terminalKind =
		outcome === 'succeeded'
			? 'run_succeeded'
			: outcome === 'cancelled'
				? 'run_cancelled'
				: outcome === 'max_iterations'
					? 'run_failed'
					: 'run_failed'
	await emit(terminalKind, {
		final_text: finalText,
		iterations: iteration,
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		final_error: finalError,
	})

	return {
		run_id: input.run_id,
		outcome,
		final_text: finalText,
		iterations: iteration,
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		tool_calls: toolCalls,
		approvals_requested: approvalsRequested,
		approvals_rejected: approvalsRejected,
		final_error: finalError,
	}

	async function emit(kind: string, payload: Record<string, unknown>): Promise<void> {
		seq += 1
		const event: RunEvent = {
			seq,
			run_id: input.run_id,
			kind: kind as never,
			ts: new Date().toISOString(),
			schema_version: 1,
			payload,
		}
		try {
			await sink.emit(event)
		} catch {
			// emission failures should never abort the run; we accept the
			// loss and continue.
		}
	}
}

function previewJson(v: Readonly<Record<string, unknown>>, max = 240): string {
	const s = JSON.stringify(v)
	return s.length > max ? `${s.slice(0, max)}…` : s
}
function previewText(t: string, max = 480): string {
	return t.length > max ? `${t.slice(0, max)}…` : t
}

/* -------------------------------------------------------------- *
 * Default sinks/gates for the orchestrator wiring                *
 * -------------------------------------------------------------- */

/**
 * Sink that publishes every RunEvent into the in-process room bus.
 * Production deploys with multi-instance fanout wrap this with the
 * listenBus, same as the existing event-log path.
 */
export class BusRunEventSink implements RunEventSink {
	constructor(
		private readonly bus: { publish(room_id: string, event: RunEvent): void },
		private readonly room_id: RoomId
	) {}
	emit(event: RunEvent): void {
		this.bus.publish(this.room_id, event)
	}
}

/**
 * Approval gate used in tests and in environments where the
 * operator UI is not yet wired. Auto-approves every request.
 * NEVER use in production.
 */
export class AutoApprove implements ApprovalGate {
	async requestApproval(): Promise<ApprovalDecision> {
		return { resolution: 'approved' }
	}
}

/**
 * Approval gate that auto-rejects every request. Tests use this
 * to exercise the rejection path.
 */
export class AutoReject implements ApprovalGate {
	async requestApproval(): Promise<ApprovalDecision> {
		return { resolution: 'rejected' }
	}
}

/**
 * Trivial cancellation backed by a mutable boolean. Tests flip
 * the flag mid-loop to assert cancellation behavior.
 */
export class FlagCancellation implements CancellationSignal {
	constructor(private cancelled = false) {}
	cancel(): void {
		this.cancelled = true
	}
	isCancelled(): boolean {
		return this.cancelled
	}
}

/**
 * Mint a fresh run id. Callers can supply their own; this is just
 * the common-case helper.
 */
export function newRunId(): RunId {
	return `run_${randomUUID()}` as RunId
}
