/**
 * Tests for runLoop.
 *
 * @author asigdel29
 */

import { describe, expect, it } from 'vitest'
import type { RunEvent, RunId, RoomId } from '@agent-canvas/orchestrator-types'
import {
	type AnthropicClient,
	type CreateMessageRequest,
	type CreateMessageResponse,
} from './anthropicClient.js'
import {
	AutoApprove,
	AutoReject,
	BusRunEventSink,
	FlagCancellation,
	type RunEventSink,
	runLoop,
} from './runLoop.js'
import {
	composeToolCatalog,
	type ProviderContribution,
	type ToolDescriptor,
	type ToolSafety,
} from './toolRegistry.js'
import type { AgentRecord } from './agentRecord.js'

/* -------------------------------------------------------------- *
 * Fakes                                                           *
 * -------------------------------------------------------------- */

/**
 * FakeAnthropic returns a scripted sequence of responses, one per
 * createMessage call. Tests construct the script that mimics the
 * scenario they want to exercise.
 */
function fakeAnthropic(script: CreateMessageResponse[]): {
	client: AnthropicClient
	calls: CreateMessageRequest[]
} {
	const calls: CreateMessageRequest[] = []
	let i = 0
	const client = {
		async createMessage(req: CreateMessageRequest) {
			// Deep-clone the request at call time. The run loop mutates
			// its own `messages` array between iterations; without the
			// snapshot, post-loop assertions would see the final state
			// of the array instead of the per-call shape.
			calls.push(JSON.parse(JSON.stringify(req)) as CreateMessageRequest)
			const next = script[i++]
			if (!next) throw new Error('fakeAnthropic: script exhausted')
			return next
		},
	} as unknown as AnthropicClient
	return { client, calls }
}

function tool(
	name: string,
	safety: ToolSafety,
	executeImpl: (
		input: Record<string, unknown>
	) => Promise<{ ok: true; content: string } | { ok: false; error: string }> = async () => ({
		ok: true,
		content: 'done',
	})
): ToolDescriptor {
	return {
		schema: {
			name,
			description: `the ${name} tool`,
			input_schema: { type: 'object', properties: {} },
		},
		safety,
		describeCall: (input) => `${name}(${JSON.stringify(input)})`,
		execute: async (input) => executeImpl(input as Record<string, unknown>),
	}
}

function bundle(descriptors: ToolDescriptor[]): ProviderContribution {
	return {
		descriptors,
		async teardown() {
			/* no-op for tests */
		},
	}
}

function collectingSink(): { sink: RunEventSink; events: RunEvent[] } {
	const events: RunEvent[] = []
	const sink = {
		emit(e: RunEvent) {
			events.push(e)
		},
	}
	return { sink, events }
}

const AGENT: AgentRecord = {
	id: 'ag_test' as never,
	workspace_id: 'ws_test' as never,
	owner_user_id: 'u_test' as never,
	name: 'Test',
	purpose: '',
	provider: 'anthropic',
	model: 'claude-sonnet-4-6',
	model_base_url: null,
	system_prompt: 'You are a test agent.',
	capabilities: {
		computer_use: { enabled: false, provider: 'none' },
		browser_use: { enabled: false, persist_cookies: false },
		mcp_servers: [],
	},
	created_at: '2026-01-01T00:00:00Z',
	updated_at: '2026-01-01T00:00:00Z',
	archived_at: null,
}

function makeInput(): Parameters<typeof runLoop>[0] {
	return {
		run_id: 'run_test' as RunId,
		room_id: 'room_test' as RoomId,
		agent: AGENT,
		initial_user_message: 'do the thing',
	}
}

function endTurn(text: string): CreateMessageResponse {
	return {
		id: 'msg_1',
		model: 'claude-sonnet-4-6',
		role: 'assistant',
		content: [{ type: 'text', text }],
		stop_reason: 'end_turn',
		stop_sequence: null,
		usage: { input_tokens: 10, output_tokens: 5 },
	}
}

function toolUseTurn(
	tool_use_id: string,
	name: string,
	input: Record<string, unknown>
): CreateMessageResponse {
	return {
		id: 'msg_tool',
		model: 'claude-sonnet-4-6',
		role: 'assistant',
		content: [{ type: 'tool_use', id: tool_use_id, name, input }],
		stop_reason: 'tool_use',
		stop_sequence: null,
		usage: { input_tokens: 8, output_tokens: 4 },
	}
}

/* -------------------------------------------------------------- *
 * Tests                                                           *
 * -------------------------------------------------------------- */

describe('runLoop', () => {
	it('completes a no-tool run with an end_turn after one iteration', async () => {
		const { client, calls } = fakeAnthropic([endTurn('all done')])
		const { sink, events } = collectingSink()
		const summary = await runLoop(makeInput(), {
			model: client,
			catalog: composeToolCatalog([bundle([])]),
			sink,
			approvalGate: new AutoApprove(),
		})
		expect(summary.outcome).toBe('succeeded')
		expect(summary.iterations).toBe(1)
		expect(summary.final_text).toBe('all done')
		expect(summary.tool_calls).toBe(0)
		expect(calls).toHaveLength(1)
		expect(events.map((e) => e.kind)).toEqual([
			'run_started',
			'progress',
			'run_succeeded',
		])
	})

	it('dispatches a safe tool, feeds the result back, completes on the next end_turn', async () => {
		let executed = 0
		const search = tool('search', 'safe', async () => {
			executed += 1
			return { ok: true, content: 'three results' }
		})
		const { client, calls } = fakeAnthropic([
			toolUseTurn('use_1', 'search', { q: 'agent canvas' }),
			endTurn('the search said: three results'),
		])
		const { sink, events } = collectingSink()
		const summary = await runLoop(makeInput(), {
			model: client,
			catalog: composeToolCatalog([bundle([search])]),
			sink,
			approvalGate: new AutoApprove(),
		})
		expect(summary.outcome).toBe('succeeded')
		expect(summary.iterations).toBe(2)
		expect(summary.tool_calls).toBe(1)
		expect(executed).toBe(1)
		// Anthropic call #2 received the tool_result as a user message.
		const secondCallMessages = calls[1]!.messages
		const lastMessage = secondCallMessages[secondCallMessages.length - 1]!
		expect(lastMessage.role).toBe('user')
		expect(Array.isArray(lastMessage.content)).toBe(true)
		const block = (lastMessage.content as Array<{ type: string; tool_use_id?: string }>)[0]!
		expect(block.type).toBe('tool_result')
		expect(block.tool_use_id).toBe('use_1')
		expect(events.map((e) => e.kind)).toContain('tool_call')
		expect(events.map((e) => e.kind)).toContain('tool_result')
		expect(events.map((e) => e.kind)).toContain('run_succeeded')
	})

	it('pauses on a destructive tool for approval, rejects gracefully', async () => {
		let executed = 0
		const destroy = tool('drop_table', 'destructive', async () => {
			executed += 1
			return { ok: true, content: 'gone' }
		})
		const { client } = fakeAnthropic([
			toolUseTurn('use_drop', 'drop_table', { table: 'users' }),
			// After rejection the model gets the rejection text and ends.
			endTurn('aborting because the operator said no'),
		])
		const { sink, events } = collectingSink()
		const summary = await runLoop(makeInput(), {
			model: client,
			catalog: composeToolCatalog([bundle([destroy])]),
			sink,
			approvalGate: new AutoReject(),
		})
		expect(summary.outcome).toBe('succeeded')
		expect(summary.approvals_requested).toBe(1)
		expect(summary.approvals_rejected).toBe(1)
		expect(executed).toBe(0)
		expect(events.map((e) => e.kind)).toEqual(
			expect.arrayContaining(['approval_required', 'approval_rejected', 'run_succeeded'])
		)
	})

	it('approves a destructive tool then runs it', async () => {
		let executed = 0
		const destroy = tool('drop_table', 'destructive', async () => {
			executed += 1
			return { ok: true, content: 'gone' }
		})
		const { client } = fakeAnthropic([
			toolUseTurn('use_drop', 'drop_table', { table: 'users' }),
			endTurn('done'),
		])
		const { sink, events } = collectingSink()
		await runLoop(makeInput(), {
			model: client,
			catalog: composeToolCatalog([bundle([destroy])]),
			sink,
			approvalGate: new AutoApprove(),
		})
		expect(executed).toBe(1)
		expect(events.find((e) => e.kind === 'tool_call')?.payload['tool_name']).toBe(
			'drop_table'
		)
	})

	it('returns max_iterations when the model never ends the turn', async () => {
		const safeNoOp = tool('noop', 'safe')
		// 26 tool_use turns; cap is 25.
		const script = Array.from({ length: 26 }, (_, i) =>
			toolUseTurn(`use_${i}`, 'noop', {})
		)
		const { client } = fakeAnthropic(script)
		const summary = await runLoop(makeInput(), {
			model: client,
			catalog: composeToolCatalog([bundle([safeNoOp])]),
			sink: collectingSink().sink,
			approvalGate: new AutoApprove(),
		})
		expect(summary.outcome).toBe('max_iterations')
		expect(summary.iterations).toBe(25)
	})

	it('cancels on a CancellationSignal before the next call', async () => {
		const cancel = new FlagCancellation()
		// One turn, then the cancel flag flips before iteration 2.
		const { client } = fakeAnthropic([
			toolUseTurn('use_1', 'noop', {}),
			endTurn('would never reach here'),
		])
		const noop = tool('noop', 'safe', async () => {
			cancel.cancel()
			return { ok: true, content: 'done' }
		})
		const summary = await runLoop(makeInput(), {
			model: client,
			catalog: composeToolCatalog([bundle([noop])]),
			sink: collectingSink().sink,
			approvalGate: new AutoApprove(),
			cancellation: cancel,
		})
		expect(summary.outcome).toBe('cancelled')
		expect(summary.iterations).toBe(1)
	})

	it('surfaces unknown tool calls as is_error tool_result without crashing', async () => {
		const { client } = fakeAnthropic([
			toolUseTurn('use_x', 'unregistered_tool', { foo: 'bar' }),
			endTurn('recovered'),
		])
		const { sink, events } = collectingSink()
		const summary = await runLoop(makeInput(), {
			model: client,
			catalog: composeToolCatalog([bundle([])]),
			sink,
			approvalGate: new AutoApprove(),
		})
		expect(summary.outcome).toBe('succeeded')
		expect(events.map((e) => e.kind)).toContain('tool_call_unknown')
	})

	it('tears down the catalog exactly once even on a thrown anthropic error', async () => {
		let tornDown = 0
		const broken = {
			descriptors: [],
			async teardown() {
				tornDown += 1
			},
		}
		const client = {
			createMessage: async () => {
				throw new Error('upstream 503')
			},
		} as unknown as AnthropicClient
		const summary = await runLoop(makeInput(), {
			model: client,
			catalog: composeToolCatalog([broken]),
			sink: collectingSink().sink,
			approvalGate: new AutoApprove(),
		})
		expect(summary.outcome).toBe('failed')
		expect(summary.final_error).toContain('upstream 503')
		expect(tornDown).toBe(1)
	})

	it('BusRunEventSink publishes to the supplied bus on the supplied room', () => {
		const published: Array<{ room: string; event: RunEvent }> = []
		const sink = new BusRunEventSink(
			{
				publish(room: string, event: RunEvent) {
					published.push({ room, event })
				},
			},
			'room_x' as RoomId
		)
		const sample: RunEvent = {
			seq: 1,
			run_id: 'r' as RunId,
			kind: 'progress' as never,
			ts: '2026-01-01T00:00:00Z',
			schema_version: 1,
			payload: {},
		}
		sink.emit(sample)
		expect(published).toEqual([{ room: 'room_x', event: sample }])
	})
})
