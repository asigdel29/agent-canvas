/**
 * Slack connector.
 *
 * OAuth model: standard OAuth 2.0 for bot installation.
 *
 * Webhook idempotency: Slack message events lack a stable delivery ID.
 * The outside-voice review called this out: dedupe on `ts + channel +
 * X-Slack-Retry-Num` instead of a delivery header. Slack uses these
 * three values together to deduplicate retries.
 * Signature: HMAC-SHA256 over `v0:{timestamp}:{body}`, sent as
 * `X-Slack-Signature` (`v0=<hex>`), with the timestamp in
 * `X-Slack-Request-Timestamp`.
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
import type { OAuthTokenSet } from '@agent-canvas/connector-core'
import { verifySlack } from '../_crypto.js'
import { OAuthHelper, type FetchLike } from '../_oauth.js'
import { buildWebhook, stubOAuth } from '../_stubs.js'

export interface SlackConnectorOptions {
	readonly clientId?: string
	readonly clientSecret?: string
	readonly scope?: string
	readonly fetch?: FetchLike
}

/**
 * Slack's OAuth v2 response is non-standard: { ok, access_token,
 * authed_user, scope, team, ... }. `ok` signals success; `access_token`
 * is the bot token, and `authed_user.access_token` would be the user
 * token (we keep the bot token for bot-style actions).
 */
function parseSlackTokenResponse(json: Record<string, unknown>): OAuthTokenSet {
	if (json['ok'] !== true) {
		throw new Error(`slack oauth response not ok: ${String(json['error'] ?? 'unknown')}`)
	}
	const access_token = String(json['access_token'] ?? '')
	if (!access_token) throw new Error('access_token missing in slack OAuth response')
	const out: OAuthTokenSet = { access_token }
	if (typeof json['scope'] === 'string') (out as { scope?: string }).scope = json['scope']
	return out
}

export class SlackConnector implements Connector {
	readonly id: ProviderId = 'slack'
	readonly display_name = 'Slack'
	readonly oauth: OAuthFramework

	constructor(opts: SlackConnectorOptions = {}) {
		const clientId = opts.clientId ?? process.env['SLACK_OAUTH_CLIENT_ID']
		const clientSecret = opts.clientSecret ?? process.env['SLACK_OAUTH_CLIENT_SECRET']
		if (clientId && clientSecret) {
			this.oauth = new OAuthHelper({
				config: {
					clientId,
					clientSecret,
					scope: opts.scope ?? 'chat:write,channels:read,channels:history',
					authorizeUrl: 'https://slack.com/oauth/v2/authorize',
					tokenUrl: 'https://slack.com/api/oauth.v2.access',
					revokeUrl: 'https://slack.com/api/auth.revoke',
				},
				providerKey: 'slack',
				parseTokenResponse: parseSlackTokenResponse,
				...(opts.fetch && { fetch: opts.fetch }),
			})
		} else {
			this.oauth = stubOAuth
		}
	}
	readonly webhook: WebhookFramework = buildWebhook({
		provider: 'slack',
		idempotencyKey: (req) => {
			const retry = req.headers['x-slack-retry-num'] ?? '0'
			let ts = 'unknown'
			let channel = 'unknown'
			try {
				const body = JSON.parse(req.body) as { event?: { ts?: string; channel?: string } }
				ts = body.event?.ts ?? ts
				channel = body.event?.channel ?? channel
			} catch {
				// Slack url-verification challenges and some other payloads
				// are url-encoded, not JSON; fall through to defaults.
			}
			return `slack_${channel}_${ts}_${retry}`
		},
		verifySignature: async (req, secret) =>
			verifySlack({
				secret,
				body: req.body,
				timestamp: req.headers['x-slack-request-timestamp'],
				providedSignature: req.headers['x-slack-signature'],
				nowMs: Date.now(),
			}),
		parseEventType: (req) => {
			try {
				const body = JSON.parse(req.body) as { event?: { type?: string }; type?: string }
				return body.event?.type ?? body.type ?? 'unknown'
			} catch {
				return 'unknown'
			}
		},
	})

	readonly tools: readonly ToolDescriptor[] = [
		{
			id: 'post_message',
			name: 'Post message',
			description: 'Send a message to a channel or thread.',
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
			description: 'Delete a previously-posted message.',
			safety: 'destructive',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
	]

	readonly triggers: readonly TriggerDescriptor[] = [
		{ id: 'message_posted', name: 'Message posted', description: '', kind: 'webhook' },
		{ id: 'mention', name: 'Bot mentioned', description: '', kind: 'webhook' },
		{ id: 'slash_command', name: 'Slash command invoked', description: '', kind: 'webhook' },
	]

	readonly sinks: readonly SinkDescriptor[] = [
		{ id: 'channel_message', name: 'Channel message', description: '', safety: 'safe' },
		{ id: 'thread_reply', name: 'Thread reply', description: '', safety: 'safe' },
	]
}
