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
import { verifyEd25519 } from '../_crypto.js'
import { OAuthHelper, parseStandardTokenResponse, type FetchLike } from '../_oauth.js'
import { buildWebhook, stubOAuth } from '../_stubs.js'

export interface DiscordConnectorOptions {
	readonly clientId?: string
	readonly clientSecret?: string
	readonly scope?: string
	readonly fetch?: FetchLike
}

export class DiscordConnector implements Connector {
	readonly id: ProviderId = 'discord'
	readonly display_name = 'Discord'
	readonly oauth: OAuthFramework

	constructor(opts: DiscordConnectorOptions = {}) {
		const clientId = opts.clientId ?? process.env['DISCORD_OAUTH_CLIENT_ID']
		const clientSecret = opts.clientSecret ?? process.env['DISCORD_OAUTH_CLIENT_SECRET']
		if (clientId && clientSecret) {
			this.oauth = new OAuthHelper({
				config: {
					clientId,
					clientSecret,
					scope: opts.scope ?? 'identify guilds bot applications.commands',
					authorizeUrl: 'https://discord.com/oauth2/authorize',
					tokenUrl: 'https://discord.com/api/oauth2/token',
					revokeUrl: 'https://discord.com/api/oauth2/token/revoke',
				},
				providerKey: 'discord',
				parseTokenResponse: parseStandardTokenResponse,
				...(opts.fetch && { fetch: opts.fetch }),
			})
		} else {
			this.oauth = stubOAuth
		}
	}
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
		// For Discord, the "secret" is the application's public key (hex).
		// Stored in the vault per-installation alongside the bot token.
		verifySignature: async (req, publicKeyHex) =>
			verifyEd25519({
				publicKeyHex,
				body: req.body,
				timestamp: req.headers['x-signature-timestamp'],
				providedSignatureHex: req.headers['x-signature-ed25519'],
			}),
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
