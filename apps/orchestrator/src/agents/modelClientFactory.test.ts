/**
 * Tests for createModelClient: provider routing and base-URL SSRF
 * enforcement at construction time.
 *
 * @author asigdel29
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createModelClient, ModelClientConfigError } from './modelClientFactory.js'
import { AnthropicClient } from './anthropicClient.js'
import { OpenAiCompatibleClient } from './openAiCompatibleClient.js'

afterEach(() => {
	delete process.env['MODEL_BASE_URL_ALLOW_PRIVATE']
	delete process.env['MODEL_BASE_URL_ALLOW_HTTP']
})

describe('createModelClient', () => {
	it('builds an AnthropicClient for the anthropic provider', () => {
		const client = createModelClient({ provider: 'anthropic', apiKey: 'sk-ant-x' })
		expect(client).toBeInstanceOf(AnthropicClient)
	})

	it('builds an OpenAiCompatibleClient for a valid https base URL', () => {
		const client = createModelClient({
			provider: 'openai',
			apiKey: 'sk-x',
			baseUrl: 'https://api.openai.com/v1',
		})
		expect(client).toBeInstanceOf(OpenAiCompatibleClient)
	})

	it('rejects a missing API key', () => {
		expect(() => createModelClient({ provider: 'anthropic', apiKey: '' })).toThrow(
			ModelClientConfigError
		)
	})

	it('rejects the openai provider without a base URL', () => {
		expect(() => createModelClient({ provider: 'openai', apiKey: 'sk-x' })).toThrow(
			expect.objectContaining({ code: 'missing_base_url' })
		)
	})

	it('rejects an openai base URL on a private address (SSRF)', () => {
		expect(() =>
			createModelClient({
				provider: 'openai',
				apiKey: 'sk-x',
				baseUrl: 'http://127.0.0.1:11434/v1',
			})
		).toThrow(expect.objectContaining({ code: 'invalid_base_url:unsupported_scheme' }))
	})

	it('rejects an https private address without the dev allowance', () => {
		expect(() =>
			createModelClient({
				provider: 'openai',
				apiKey: 'sk-x',
				baseUrl: 'https://10.0.0.5/v1',
			})
		).toThrow(expect.objectContaining({ code: 'invalid_base_url:private_address' }))
	})

	it('permits a loopback base URL when the dev flags are set (local models)', () => {
		process.env['MODEL_BASE_URL_ALLOW_HTTP'] = 'true'
		process.env['MODEL_BASE_URL_ALLOW_PRIVATE'] = 'true'
		const client = createModelClient({
			provider: 'openai',
			apiKey: 'sk-x',
			baseUrl: 'http://127.0.0.1:11434/v1',
		})
		expect(client).toBeInstanceOf(OpenAiCompatibleClient)
	})

	it('rejects an unknown provider', () => {
		expect(() =>
			createModelClient({ provider: 'azure' as never, apiKey: 'sk-x' })
		).toThrow(expect.objectContaining({ code: 'unknown_provider' }))
	})
})
