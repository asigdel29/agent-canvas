import { describe, expect, it } from 'vitest'
import {
	type Connector,
	ConnectorRegistry,
	type OAuthFramework,
	type WebhookFramework,
} from '@agent-canvas/connector-core'
import { SafetyClassifier } from './safetyClassifier.js'

const oauth: OAuthFramework = {
	authorize: async () => ({ authorize_url: '' }),
	callback: async () => ({ access_token: '' }),
	refresh: async (t) => t,
	revoke: async () => {},
}
const webhook: WebhookFramework = {
	verifySignature: async () => true,
	idempotencyKey: () => 'k',
	normalize: () => ({
		provider: 'github',
		event_type: 'noop',
		idempotency_key: 'k',
		received_at: new Date().toISOString(),
		payload: {},
	}),
}

const githubConnector: Connector = {
	id: 'github',
	display_name: 'GitHub',
	oauth,
	webhook,
	tools: [
		{
			id: 'create_pr',
			name: 'Create PR',
			description: 'Open a pull request',
			safety: 'safe',
			input_schema: {},
			output_schema: {},
		},
		{
			id: 'force_push',
			name: 'Force push',
			description: 'Force-push to a branch (destroys history)',
			safety: 'irreversible',
			input_schema: {},
			output_schema: {},
		},
		{
			id: 'merge_pr',
			name: 'Merge PR',
			description: 'Merge a pull request',
			safety: 'destructive',
			input_schema: {},
			output_schema: {},
		},
	],
	triggers: [],
	sinks: [],
}

function buildRegistry(): ConnectorRegistry {
	const r = new ConnectorRegistry()
	r.registerConnector(githubConnector)
	return r
}

describe('SafetyClassifier', () => {
	it('classifies safe tools as safe', () => {
		const c = new SafetyClassifier(buildRegistry())
		expect(c.classify({ provider: 'github', tool_id: 'create_pr', args: {} }).safety).toBe('safe')
		expect(c.requiresApproval({ provider: 'github', tool_id: 'create_pr', args: {} })).toBe(false)
	})

	it('classifies destructive tools and gates them', () => {
		const c = new SafetyClassifier(buildRegistry())
		expect(c.classify({ provider: 'github', tool_id: 'merge_pr', args: {} }).safety).toBe(
			'destructive'
		)
		expect(c.requiresApproval({ provider: 'github', tool_id: 'merge_pr', args: {} })).toBe(true)
	})

	it('classifies irreversible tools and gates them', () => {
		const c = new SafetyClassifier(buildRegistry())
		expect(c.classify({ provider: 'github', tool_id: 'force_push', args: {} }).safety).toBe(
			'irreversible'
		)
		expect(c.requiresApproval({ provider: 'github', tool_id: 'force_push', args: {} })).toBe(true)
	})

	it('fails closed on unknown tools (treats as irreversible)', () => {
		const c = new SafetyClassifier(buildRegistry())
		const result = c.classify({ provider: 'github', tool_id: 'do_something_wild', args: {} })
		expect(result.safety).toBe('irreversible')
		expect(result.tool_name).toContain('do_something_wild')
		expect(
			c.requiresApproval({ provider: 'github', tool_id: 'do_something_wild', args: {} })
		).toBe(true)
	})
})
