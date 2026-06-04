/**
 * Meta-test: prove the conformance suite catches drift by running it
 * against a hand-built minimal Connector / ProviderAdapter. The 8 real
 * adapters import the same suite from their own test files.
 * @author asigdel29
 */

import { describe, expect, it } from 'vitest'
import {
	type Connector,
	ConnectorNotFoundError,
	ConnectorRegistry,
	type OAuthFramework,
	type ProviderAdapter,
	type WebhookFramework,
} from './index.js'
import { runConnectorConformance, runProviderAdapterConformance } from './conformance.js'

const mockOAuth: OAuthFramework = {
	authorize: async () => ({ authorize_url: 'https://example.com/auth' }),
	callback: async () => ({ access_token: 'tok' }),
	refresh: async (t) => t,
	revoke: async () => {},
}

const mockWebhook: WebhookFramework = {
	verifySignature: async () => true,
	idempotencyKey: () => 'fake-key',
	normalize: () => ({
		provider: 'github',
		event_type: 'noop',
		idempotency_key: 'fake-key',
		received_at: new Date().toISOString(),
		payload: {},
	}),
}

const mockConnector: Connector = {
	id: 'github',
	display_name: 'GitHub',
	oauth: mockOAuth,
	webhook: mockWebhook,
	tools: [
		{
			id: 'create_pr',
			name: 'Create PR',
			description: 'Open a pull request',
			safety: 'safe',
			input_schema: { type: 'object', properties: { repo: { type: 'string' } } },
			output_schema: { type: 'object' },
		},
		{
			id: 'force_push',
			name: 'Force push to main',
			description: 'Force-push to a protected branch',
			safety: 'irreversible',
			input_schema: { type: 'object', properties: { ref: { type: 'string' } } },
			output_schema: { type: 'object' },
		},
	],
	triggers: [{ id: 'pr_opened', name: 'PR opened', description: '', kind: 'webhook' }],
	sinks: [{ id: 'comment', name: 'Add comment', description: '', safety: 'safe' }],
}

const mockProvider: ProviderAdapter = {
	id: 'codex',
	display_name: 'Codex',
	getSupportedTools: async () => ['create_pr', 'force_push'],
	startRun: async () => ({ vendor_run_id: 'vrn_1' }),
	cancelRun: async () => {},
	getStatus: async (run_id) => ({
		run_id,
		status: 'running',
		last_observed_at: new Date().toISOString(),
	}),
	webhook: mockWebhook,
	extractRunInfo: () => null,
}

runConnectorConformance(mockConnector)
runProviderAdapterConformance(mockProvider)

describe('ConnectorRegistry', () => {
	it('registers and resolves connectors by id', () => {
		const r = new ConnectorRegistry()
		r.registerConnector(mockConnector)
		expect(r.getConnector('github').display_name).toBe('GitHub')
	})

	it('throws ConnectorNotFoundError for unknown connector', () => {
		const r = new ConnectorRegistry()
		expect(() => r.getConnector('github')).toThrow(ConnectorNotFoundError)
	})

	it('registers and resolves vendor providers by id', () => {
		const r = new ConnectorRegistry()
		r.registerProvider(mockProvider)
		expect(r.getProvider('codex').display_name).toBe('Codex')
	})
})
