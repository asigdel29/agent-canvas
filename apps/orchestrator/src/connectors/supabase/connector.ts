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
import { buildWebhook, stubOAuth } from '../_stubs.js'

export class SupabaseConnector implements Connector {
	readonly id: ProviderId = 'supabase'
	readonly display_name = 'Supabase'
	readonly oauth: OAuthFramework = stubOAuth
	readonly webhook: WebhookFramework = buildWebhook({
		provider: 'supabase',
		idempotencyKey: (req) => req.headers['x-supabase-delivery'] ?? 'supabase_unknown',
		verifySignature: async () => false,
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
