/**
 * The single construction point for {@link ModelClient} instances.
 *
 * Every model request in the orchestrator flows through a client built
 * here; the run handler never instantiates a provider client directly.
 * Centralizing construction keeps three invariants in one place:
 *
 *   1. Provider routing is exhaustive — an unknown provider fails loudly
 *      rather than silently defaulting.
 *   2. An OpenAI-compatible base URL is SSRF-checked before any socket
 *      is opened ({@link validateModelBaseUrl}).
 *   3. A model id can never reach the wrong client — routing is on
 *      `provider` alone, so an OpenAI model id cannot hit the Anthropic
 *      endpoint or vice versa.
 *
 * @author asigdel29
 */

import { AnthropicClient } from './anthropicClient.js'
import { OpenAiCompatibleClient } from './openAiCompatibleClient.js'
import { validateModelBaseUrl } from './modelBaseUrl.js'
import type { ModelClient, Provider } from './modelClient.js'

/** Raised when a model client cannot be built from the given inputs. */
export class ModelClientConfigError extends Error {
	constructor(
		public readonly code: string,
		message: string
	) {
		super(message)
		this.name = 'ModelClientConfigError'
	}
}

/** Inputs for {@link createModelClient}. */
export interface CreateModelClientInput {
	/** Which provider family to construct for. */
	readonly provider: Provider
	/** The resolved API key (BYOK header or server env). */
	readonly apiKey: string
	/**
	 * The OpenAI-compatible API root. Required when `provider==='openai'`,
	 * ignored for `anthropic`.
	 */
	readonly baseUrl?: string | null
	/** Test seam forwarded to the concrete client. */
	readonly fetchImpl?: typeof fetch
}

/**
 * Build a {@link ModelClient} for the requested provider.
 *
 * @param input provider, key, and (for OpenAI-compatible) base URL.
 * @return a ready-to-use client implementing the canonical contract.
 * @throws ModelClientConfigError when the provider is unknown, the key
 *   is missing, or the OpenAI base URL is absent or fails the SSRF check.
 */
export function createModelClient(input: CreateModelClientInput): ModelClient {
	if (!input.apiKey) {
		throw new ModelClientConfigError('missing_api_key', 'a model API key is required')
	}

	if (input.provider === 'anthropic') {
		return new AnthropicClient(
			input.fetchImpl
				? { apiKey: input.apiKey, fetchImpl: input.fetchImpl }
				: { apiKey: input.apiKey }
		)
	}

	if (input.provider === 'openai') {
		const baseUrl = input.baseUrl?.trim()
		if (!baseUrl) {
			throw new ModelClientConfigError(
				'missing_base_url',
				'an OpenAI-compatible base URL is required for this provider'
			)
		}
		const check = validateModelBaseUrl(baseUrl)
		if (!check.ok) {
			throw new ModelClientConfigError(
				`invalid_base_url:${check.reason}`,
				`the model base URL was rejected (${check.reason})`
			)
		}
		return new OpenAiCompatibleClient(
			input.fetchImpl
				? { apiKey: input.apiKey, baseUrl, fetchImpl: input.fetchImpl }
				: { apiKey: input.apiKey, baseUrl }
		)
	}

	// Exhaustiveness: a new Provider added without a branch lands here.
	throw new ModelClientConfigError(
		'unknown_provider',
		`unsupported provider: ${String(input.provider)}`
	)
}
