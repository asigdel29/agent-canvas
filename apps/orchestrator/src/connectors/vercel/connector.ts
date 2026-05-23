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
import { OAuthHelper, parseStandardTokenResponse, type FetchLike } from '../_oauth.js'
import { buildWebhook, stubOAuth } from '../_stubs.js'

export interface VercelConnectorOptions {
	readonly clientId?: string
	readonly clientSecret?: string
	readonly scope?: string
	readonly fetch?: FetchLike
}

export class VercelConnector implements Connector {
	readonly id: ProviderId = 'vercel'
	readonly display_name = 'Vercel'
	readonly oauth: OAuthFramework

	constructor(opts: VercelConnectorOptions = {}) {
		const clientId = opts.clientId ?? process.env['VERCEL_OAUTH_CLIENT_ID']
		const clientSecret = opts.clientSecret ?? process.env['VERCEL_OAUTH_CLIENT_SECRET']
		if (clientId && clientSecret) {
			this.oauth = new OAuthHelper({
				config: {
					clientId,
					clientSecret,
					scope: opts.scope ?? '',
					authorizeUrl: 'https://vercel.com/integrations/install',
					tokenUrl: 'https://api.vercel.com/v2/oauth/access_token',
					// No public revoke endpoint on the integrations API; users
					// uninstall the integration from the Vercel dashboard.
				},
				providerKey: 'vercel',
				parseTokenResponse: parseStandardTokenResponse,
				...(opts.fetch && { fetch: opts.fetch }),
			})
		} else {
			this.oauth = stubOAuth
		}
	}
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
