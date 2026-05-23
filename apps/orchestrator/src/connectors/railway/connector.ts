/**
 * Railway connector.
 *
 * OAuth model: project token (PAT-equivalent) scoped to one project.
 * Tokens are long-lived; rotation is manual.
 *
 * Webhook idempotency: `Railway-Delivery` header.
 * Signature: HMAC-SHA256 with the webhook secret, sent as
 * `Railway-Signature`.
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

export class RailwayConnector implements Connector {
	readonly id: ProviderId = 'railway'
	readonly display_name = 'Railway'
	readonly oauth: OAuthFramework = stubOAuth
	readonly webhook: WebhookFramework = buildWebhook({
		provider: 'railway',
		idempotencyKey: (req) =>
			req.headers['railway-delivery'] ?? req.headers['Railway-Delivery'] ?? 'railway_unknown',
		verifySignature: async () => false,
	})

	readonly tools: readonly ToolDescriptor[] = [
		{
			id: 'list_deployments',
			name: 'List deployments',
			description: 'List recent deployments for a service.',
			safety: 'safe',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'get_logs',
			name: 'Get logs',
			description: 'Read deployment logs for a service.',
			safety: 'safe',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'redeploy',
			name: 'Redeploy',
			description: 'Trigger a new deployment of a service.',
			safety: 'destructive',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'delete_deployment',
			name: 'Delete deployment',
			description: 'Permanently remove a deployment.',
			safety: 'irreversible',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
	]

	readonly triggers: readonly TriggerDescriptor[] = [
		{ id: 'deployment_succeeded', name: 'Deployment succeeded', description: '', kind: 'webhook' },
		{ id: 'deployment_failed', name: 'Deployment failed', description: '', kind: 'webhook' },
	]

	readonly sinks: readonly SinkDescriptor[] = [
		{ id: 'trigger_deploy', name: 'Trigger deploy', description: '', safety: 'destructive' },
	]
}
