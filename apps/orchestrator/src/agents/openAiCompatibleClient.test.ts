/**
 * Tests for OpenAiCompatibleClient: request/response translation between
 * the canonical Anthropic-style contract and the OpenAI chat schema, and
 * error normalization.
 *
 * @author asigdel29
 */

import { describe, expect, it } from 'vitest'
import { OpenAiCompatibleClient } from './openAiCompatibleClient.js'
import {
	ModelAuthError,
	ModelRateLimitError,
	ModelServerError,
} from './modelClient.js'
import type { CreateMessageRequest } from './anthropicClient.js'

/**
 * Build a fetch stub that records the request body and returns `body`
 * as a JSON response with the given status.
 */
function stubFetch(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {}
): { fetchImpl: typeof fetch; seen: { url?: string; body?: any } } {
	const seen: { url?: string; body?: any } = {}
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		seen.url = url
		seen.body = init?.body ? JSON.parse(init.body as string) : undefined
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json', ...headers },
		})
	}) as unknown as typeof fetch
	return { fetchImpl, seen }
}

const REQUEST: CreateMessageRequest = {
	model: 'gpt-4o',
	system: 'be terse',
	max_tokens: 100,
	temperature: 0.5,
	messages: [
		{ role: 'user', content: 'hello' },
		{
			role: 'assistant',
			content: [
				{ type: 'text', text: 'thinking' },
				{ type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'x' } },
			],
		},
		{
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'result text' }],
		},
	],
	tools: [
		{
			name: 'search',
			description: 'searches',
			input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
		},
		{
			type: 'computer_20241022',
			name: 'computer',
			display_width_px: 1024,
			display_height_px: 768,
		},
	],
	tool_choice: { type: 'auto' },
}

describe('OpenAiCompatibleClient request translation', () => {
	it('flattens system + content blocks into ordered OpenAI messages', async () => {
		const { fetchImpl, seen } = stubFetch({
			id: 'c1',
			model: 'gpt-4o',
			choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 1, completion_tokens: 1 },
		})
		const client = new OpenAiCompatibleClient({
			apiKey: 'sk-test',
			baseUrl: 'https://api.openai.com/v1',
			fetchImpl,
		})
		await client.createMessage(REQUEST)

		expect(seen.url).toBe('https://api.openai.com/v1/chat/completions')
		expect(seen.body.model).toBe('gpt-4o')
		expect(seen.body.max_tokens).toBe(100)
		expect(seen.body.temperature).toBe(0.5)
		expect(seen.body.messages).toEqual([
			{ role: 'system', content: 'be terse' },
			{ role: 'user', content: 'hello' },
			{
				role: 'assistant',
				content: 'thinking',
				tool_calls: [
					{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
				],
			},
			{ role: 'tool', tool_call_id: 'call_1', content: 'result text' },
		])
	})

	it('exposes standard tools as functions and drops the computer tool', async () => {
		const { fetchImpl, seen } = stubFetch({
			id: 'c1',
			choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 1, completion_tokens: 1 },
		})
		const client = new OpenAiCompatibleClient({
			apiKey: 'sk-test',
			baseUrl: 'https://api.openai.com/v1',
			fetchImpl,
		})
		await client.createMessage(REQUEST)

		expect(seen.body.tools).toHaveLength(1)
		expect(seen.body.tools[0]).toEqual({
			type: 'function',
			function: {
				name: 'search',
				description: 'searches',
				parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
			},
		})
		expect(seen.body.tool_choice).toBe('auto')
	})
})

describe('OpenAiCompatibleClient response translation', () => {
	it('maps content + tool_calls into canonical blocks and stop_reason', async () => {
		const { fetchImpl } = stubFetch({
			id: 'chatcmpl-1',
			model: 'gpt-4o',
			choices: [
				{
					message: {
						content: 'hi there',
						tool_calls: [
							{ id: 'call_2', type: 'function', function: { name: 'search', arguments: '{"q":"y"}' } },
						],
					},
					finish_reason: 'tool_calls',
				},
			],
			usage: { prompt_tokens: 12, completion_tokens: 7 },
		})
		const client = new OpenAiCompatibleClient({
			apiKey: 'sk-test',
			baseUrl: 'https://api.openai.com/v1',
			fetchImpl,
		})
		const res = await client.createMessage(REQUEST)

		expect(res.stop_reason).toBe('tool_use')
		expect(res.content).toEqual([
			{ type: 'text', text: 'hi there' },
			{ type: 'tool_use', id: 'call_2', name: 'search', input: { q: 'y' } },
		])
		expect(res.usage).toEqual({ input_tokens: 12, output_tokens: 7 })
	})

	it('maps a plain stop to end_turn', async () => {
		const { fetchImpl } = stubFetch({
			id: 'c1',
			choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 3, completion_tokens: 2 },
		})
		const client = new OpenAiCompatibleClient({
			apiKey: 'sk-test',
			baseUrl: 'https://api.openai.com/v1',
			fetchImpl,
		})
		const res = await client.createMessage(REQUEST)
		expect(res.stop_reason).toBe('end_turn')
		expect(res.content).toEqual([{ type: 'text', text: 'done' }])
	})
})

describe('OpenAiCompatibleClient error mapping', () => {
	it('maps 401 to ModelAuthError', async () => {
		const { fetchImpl } = stubFetch({ error: { message: 'bad key' } }, 401)
		const client = new OpenAiCompatibleClient({
			apiKey: 'sk-bad',
			baseUrl: 'https://api.openai.com/v1',
			fetchImpl,
		})
		await expect(client.createMessage(REQUEST)).rejects.toBeInstanceOf(ModelAuthError)
	})

	it('maps 429 to ModelRateLimitError with retry-after', async () => {
		const { fetchImpl } = stubFetch({ error: { message: 'slow down' } }, 429, {
			'retry-after': '7',
		})
		const client = new OpenAiCompatibleClient({
			apiKey: 'sk-test',
			baseUrl: 'https://api.openai.com/v1',
			fetchImpl,
		})
		await expect(client.createMessage(REQUEST)).rejects.toMatchObject({
			name: 'ModelRateLimitError',
			retry_after_seconds: 7,
		})
	})

	it('maps 500 to ModelServerError', async () => {
		const { fetchImpl } = stubFetch({ error: { message: 'boom' } }, 500)
		const client = new OpenAiCompatibleClient({
			apiKey: 'sk-test',
			baseUrl: 'https://api.openai.com/v1',
			fetchImpl,
		})
		await expect(client.createMessage(REQUEST)).rejects.toBeInstanceOf(ModelServerError)
	})
})
