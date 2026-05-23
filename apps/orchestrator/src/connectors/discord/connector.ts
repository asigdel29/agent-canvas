/**
 * Discord connector.
 *
 * OAuth model: bot token (long-lived) for server actions + interaction
 * tokens (short-lived, ~15 min) for interaction follow-ups.
 *
 * Webhook idempotency: `interaction.id` from the payload. The outside-
 * voice review flagged that Discord interaction tokens themselves
 * expire, which matters for the orchestrator's pause/resume flow more
 * than for idempotency.
 * Signature: Ed25519 over `timestamp + body`, sent as
 * `X-Signature-Ed25519` with the timestamp in `X-Signature-Timestamp`.
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

export class DiscordConnector implements Connector {
	readonly id: ProviderId = 'discord'
	readonly display_name = 'Discord'
	readonly oauth: OAuthFramework = stubOAuth
	readonly webhook: WebhookFramework = buildWebhook({
		provider: 'discord',
		idempotencyKey: (req) => {
			try {
				const body = JSON.parse(req.body) as { id?: string }
				return body.id ?? 'discord_unknown'
			} catch {
				return 'discord_unparseable'
			}
		},
		verifySignature: async () => false,
		parseEventType: (req) => {
			try {
				const body = JSON.parse(req.body) as { type?: number }
				return `interaction_type_${body.type ?? 'unknown'}`
			} catch {
				return 'unknown'
			}
		},
	})

	readonly tools: readonly ToolDescriptor[] = [
		{
			id: 'send_message',
			name: 'Send message',
			description: 'Send a message to a channel.',
			safety: 'safe',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'list_messages',
			name: 'List messages',
			description: 'Read recent messages from a channel.',
			safety: 'safe',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'delete_message',
			name: 'Delete message',
			description: 'Delete a message.',
			safety: 'destructive',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'kick_member',
			name: 'Kick member',
			description: 'Remove a user from the server.',
			safety: 'destructive',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
	]

	readonly triggers: readonly TriggerDescriptor[] = [
		{ id: 'slash_command', name: 'Slash command', description: '', kind: 'webhook' },
		{ id: 'message_create', name: 'Message created', description: '', kind: 'webhook' },
	]

	readonly sinks: readonly SinkDescriptor[] = [
		{ id: 'channel_message', name: 'Channel message', description: '', safety: 'safe' },
	]
}
