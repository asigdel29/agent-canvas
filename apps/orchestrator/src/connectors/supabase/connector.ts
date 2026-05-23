/**
 * Supabase connector.
 *
 * OAuth model: project service-role key (long-lived) + a short-lived
 * scoped JWT minted per run. The service-role key is in the vault; only
 * the JWT crosses to the agent vendor.
 *
 * Webhook idempotency: `x-supabase-delivery` header.
 * Signature: HMAC-SHA256 with the webhook secret, sent as
 * `x-supabase-signature`.
 *
 * SQL tools are classified as `destructive` by default because they
 * accept arbitrary SQL strings; safe specific operations (a typed
 * "fetch row by id" tool) can be added with `safe` classification, but
 * the generic `run_query` MUST be destructive.
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
import { OAuthHelper, parseStandardTokenResponse, type FetchLike } from '../_oauth.js'
import { buildWebhook, stubOAuth } from '../_stubs.js'

export interface SupabaseConnectorOptions {
	readonly clientId?: string
	readonly clientSecret?: string
	readonly scope?: string
	readonly fetch?: FetchLike
}

export class SupabaseConnector implements Connector {
	readonly id: ProviderId = 'supabase'
	readonly display_name = 'Supabase'
	readonly oauth: OAuthFramework

	constructor(opts: SupabaseConnectorOptions = {}) {
		const clientId = opts.clientId ?? process.env['SUPABASE_OAUTH_CLIENT_ID']
		const clientSecret = opts.clientSecret ?? process.env['SUPABASE_OAUTH_CLIENT_SECRET']
		if (clientId && clientSecret) {
			this.oauth = new OAuthHelper({
				config: {
					clientId,
					clientSecret,
					scope: opts.scope ?? 'all',
					authorizeUrl: 'https://api.supabase.com/v1/oauth/authorize',
					tokenUrl: 'https://api.supabase.com/v1/oauth/token',
					// Supabase management API does not expose a public revoke
					// endpoint; the user disconnects the integration from
					// the Supabase dashboard, which invalidates the tokens.
				},
				providerKey: 'supabase',
				parseTokenResponse: parseStandardTokenResponse,
				...(opts.fetch && { fetch: opts.fetch }),
			})
		} else {
			this.oauth = stubOAuth
		}
	}
	readonly webhook: WebhookFramework = buildWebhook({
		provider: 'supabase',
		idempotencyKey: (req) => req.headers['x-supabase-delivery'] ?? 'supabase_unknown',
		verifySignature: async (req, secret) =>
			verifyHmacSha256({
				secret,
				body: req.body,
				providedSignature: req.headers['x-supabase-signature'],
			}),
	})

	readonly tools: readonly ToolDescriptor[] = [
		{
			id: 'get_schema',
			name: 'Get schema',
			description: 'Inspect tables, columns, indexes.',
			safety: 'safe',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'run_query',
			name: 'Run SQL query',
			description:
				'Execute arbitrary SQL. ALWAYS destructive because the query string is ' +
				'opaque to the safety classifier.',
			safety: 'destructive',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'invoke_function',
			name: 'Invoke edge function',
			description: 'Call a Supabase Edge Function by name.',
			safety: 'destructive',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'drop_table',
			name: 'Drop table',
			description: 'Permanently delete a table and its rows.',
			safety: 'irreversible',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
	]

	readonly triggers: readonly TriggerDescriptor[] = [
		{ id: 'row_inserted', name: 'Row inserted', description: '', kind: 'webhook' },
		{ id: 'row_updated', name: 'Row updated', description: '', kind: 'webhook' },
	]

	readonly sinks: readonly SinkDescriptor[] = [
		{ id: 'insert_row', name: 'Insert row', description: '', safety: 'safe' },
	]
}
