/**
 * Graphite connector.
 *
 * OAuth model: personal access token (PAT) — Graphite does not expose a
 * full OAuth 2.0 flow for third-party apps as of this writing.
 *
 * Webhook idempotency: `Graphite-Delivery` header.
 * Signature: HMAC-SHA256 with the webhook secret, sent as
 * `Graphite-Signature`.
 */

import type {
	Connector,
	OAuthFramework,
	SinkDescriptor,
	ToolDescriptor,
	TriggerDescriptor,
	WebhookFramework,
} from '@agent-canvas/connector-core'
import type { ProviderId } from '@agent-canvas/orchestrator-types'
import { buildWebhook, stubOAuth } from '../_stubs.js'

export class GraphiteConnector implements Connector {
	readonly id: ProviderId = 'graphite'
	readonly display_name = 'Graphite'
	readonly oauth: OAuthFramework = stubOAuth
	readonly webhook: WebhookFramework = buildWebhook({
		provider: 'graphite',
		idempotencyKey: (req) =>
			req.headers['graphite-delivery'] ?? req.headers['Graphite-Delivery'] ?? 'graphite_unknown',
		verifySignature: async () => false,
	})

	readonly tools: readonly ToolDescriptor[] = [
		{
			id: 'submit_stack',
			name: 'Submit stack',
			description: 'Submit a stacked pull request for review.',
			safety: 'safe',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'submit_review',
			name: 'Submit review',
			description: 'Submit a code review on a Graphite PR.',
			safety: 'safe',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'merge_stack',
			name: 'Merge stack',
			description: 'Merge a stacked PR (and its parents).',
			safety: 'destructive',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
	]

	readonly triggers: readonly TriggerDescriptor[] = [
		{ id: 'stack_submitted', name: 'Stack submitted', description: '', kind: 'webhook' },
		{ id: 'review_requested', name: 'Review requested', description: '', kind: 'webhook' },
	]

	readonly sinks: readonly SinkDescriptor[] = [
		{ id: 'review_comment', name: 'Review comment', description: '', safety: 'safe' },
	]
}
