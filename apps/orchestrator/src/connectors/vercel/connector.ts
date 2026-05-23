/**
 * Vercel connector (as an integration the agent calls out to — NOT the
 * platform this product is deployed on).
 *
 * OAuth model: Vercel integration tokens (per-team installation, scoped
 * to the team).
 *
 * Webhook idempotency: `x-vercel-delivery` header.
 * Signature: HMAC-SHA1 with the integration's client secret, sent as
 * `x-vercel-signature`.
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
import { verifyHmacSha1 } from '../_crypto.js'
import { buildWebhook, stubOAuth } from '../_stubs.js'

export class VercelConnector implements Connector {
	readonly id: ProviderId = 'vercel'
	readonly display_name = 'Vercel'
	readonly oauth: OAuthFramework = stubOAuth
	readonly webhook: WebhookFramework = buildWebhook({
		provider: 'vercel',
		idempotencyKey: (req) => req.headers['x-vercel-delivery'] ?? 'vercel_unknown',
		verifySignature: async (req, secret) =>
			verifyHmacSha1({
				secret,
				body: req.body,
				providedSignature: req.headers['x-vercel-signature'],
			}),
	})

	readonly tools: readonly ToolDescriptor[] = [
		{
			id: 'get_logs',
			name: 'Get function logs',
			description: 'Read function logs for a deployment.',
			safety: 'safe',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'deploy_preview',
			name: 'Deploy preview',
			description: 'Create a preview deployment from a branch.',
			safety: 'destructive',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'promote_to_production',
			name: 'Promote to production',
			description: 'Promote a preview deployment to the production alias.',
			safety: 'irreversible',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'rollback',
			name: 'Rollback production',
			description: 'Roll production back to a prior deployment.',
			safety: 'irreversible',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
	]

	readonly triggers: readonly TriggerDescriptor[] = [
		{ id: 'deployment_created', name: 'Deployment created', description: '', kind: 'webhook' },
		{ id: 'deployment_ready', name: 'Deployment ready', description: '', kind: 'webhook' },
		{ id: 'deployment_error', name: 'Deployment error', description: '', kind: 'webhook' },
	]

	readonly sinks: readonly SinkDescriptor[] = [
		{ id: 'trigger_deploy', name: 'Trigger deploy', description: '', safety: 'destructive' },
	]
}
