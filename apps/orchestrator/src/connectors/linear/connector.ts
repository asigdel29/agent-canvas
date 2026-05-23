/**
 * Linear connector.
 *
 * OAuth model: standard OAuth 2.0 with refresh tokens.
 *
 * Webhook idempotency: `Linear-Delivery` header when present (newer
 * webhook versions); content-hash fallback for legacy versions. The
 * outside-voice review flagged Linear's mixed idempotency surface
 * explicitly.
 * Signature: HMAC-SHA256 with the webhook secret, sent as
 * `Linear-Signature` (hex).
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
import { verifyHmacSha256 } from '../_crypto.js'
import { buildWebhook, stubOAuth } from '../_stubs.js'

export class LinearConnector implements Connector {
	readonly id: ProviderId = 'linear'
	readonly display_name = 'Linear'
	readonly oauth: OAuthFramework = stubOAuth
	readonly webhook: WebhookFramework = buildWebhook({
		provider: 'linear',
		idempotencyKey: (req) => {
			const delivery = req.headers['linear-delivery'] ?? req.headers['Linear-Delivery']
			if (delivery) return delivery
			// Legacy fallback: hash the body deterministically.
			return `linear_hash_${djb2(req.body)}`
		},
		verifySignature: async (req, secret) =>
			verifyHmacSha256({
				secret,
				body: req.body,
				providedSignature: req.headers['linear-signature'] ?? req.headers['Linear-Signature'],
			}),
		parseEventType: (req) => req.headers['linear-event'] ?? 'unknown',
	})

	readonly tools: readonly ToolDescriptor[] = [
		{
			id: 'list_issues',
			name: 'List issues',
			description: 'List issues filtered by label, state, assignee, or project.',
			safety: 'safe',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'create_issue',
			name: 'Create issue',
			description: 'Open a new issue.',
			safety: 'safe',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'update_issue',
			name: 'Update issue',
			description: 'Update an issue (state, priority, assignee, labels).',
			safety: 'safe',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'comment_issue',
			name: 'Comment on issue',
			description: 'Add a comment to an issue.',
			safety: 'safe',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'delete_issue',
			name: 'Delete issue',
			description: 'Permanently delete an issue.',
			safety: 'destructive',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
	]

	readonly triggers: readonly TriggerDescriptor[] = [
		{ id: 'issue_created', name: 'Issue created', description: '', kind: 'webhook' },
		{ id: 'issue_state_changed', name: 'Issue state changed', description: '', kind: 'webhook' },
		{ id: 'comment_created', name: 'Comment created', description: '', kind: 'webhook' },
	]

	readonly sinks: readonly SinkDescriptor[] = [
		{ id: 'issue_comment', name: 'Issue comment', description: '', safety: 'safe' },
		{ id: 'issue_update', name: 'Issue update', description: '', safety: 'safe' },
	]
}

function djb2(s: string): string {
	let h = 5381
	for (let i = 0; i < s.length; i += 1) {
		h = ((h << 5) + h + s.charCodeAt(i)) | 0
	}
	return (h >>> 0).toString(16)
}
