/**
 * GitHub connector.
 *
 * OAuth model: GitHub App installation. Tokens are installation tokens
 * (~1 hour TTL, scoped via app permissions to specific repos). The
 * orchestrator mints these per-run; long-lived secrets stay in the vault.
 *
 * Webhook idempotency: `X-GitHub-Delivery` header (UUID per delivery).
 * Signature: HMAC-SHA256 with the app's webhook secret, sent as
 * `X-Hub-Signature-256`.
 * @author asigdel29
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

export interface GitHubConnectorOptions {
	readonly clientId?: string
	readonly clientSecret?: string
	readonly scope?: string
	readonly fetch?: FetchLike
}

export class GitHubConnector implements Connector {
	readonly id: ProviderId = 'github'
	readonly display_name = 'GitHub'
	readonly oauth: OAuthFramework

	constructor(opts: GitHubConnectorOptions = {}) {
		const clientId = opts.clientId ?? process.env['GITHUB_OAUTH_CLIENT_ID']
		const clientSecret = opts.clientSecret ?? process.env['GITHUB_OAUTH_CLIENT_SECRET']
		if (clientId && clientSecret) {
			this.oauth = new OAuthHelper({
				config: {
					clientId,
					clientSecret,
					scope: opts.scope ?? 'repo read:user',
					authorizeUrl: 'https://github.com/login/oauth/authorize',
					tokenUrl: 'https://github.com/login/oauth/access_token',
					// GitHub's revoke endpoint uses Basic auth + DELETE; doesn't
					// fit the standard form-encoded POST. Skip; the vault
					// drops the cached tokens locally on disconnect.
				},
				providerKey: 'github',
				parseTokenResponse: parseStandardTokenResponse,
				...(opts.fetch && { fetch: opts.fetch }),
			})
		} else {
			this.oauth = stubOAuth
		}
	}
	readonly webhook: WebhookFramework = buildWebhook({
		provider: 'github',
		idempotencyKey: (req) =>
			req.headers['x-github-delivery'] ?? req.headers['X-GitHub-Delivery'] ?? '',
		verifySignature: async (req, secret) =>
			verifyHmacSha256({
				secret,
				body: req.body,
				providedSignature:
					req.headers['x-hub-signature-256'] ?? req.headers['X-Hub-Signature-256'],
				prefix: 'sha256=',
			}),
		parseEventType: (req) =>
			req.headers['x-github-event'] ?? req.headers['X-GitHub-Event'] ?? 'unknown',
	})

	readonly tools: readonly ToolDescriptor[] = [
		{
			id: 'create_pr',
			name: 'Create pull request',
			description: 'Open a pull request from a branch to a base.',
			safety: 'safe',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'write_file',
			name: 'Write file',
			description: 'Create or update a file on a branch.',
			safety: 'safe',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'comment_issue',
			name: 'Comment on issue',
			description: 'Add a comment to an issue or pull request.',
			safety: 'safe',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'run_tests',
			name: 'Run tests',
			description: 'Trigger the CI test workflow for a ref.',
			safety: 'safe',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'merge_pr',
			name: 'Merge pull request',
			description: 'Merge an open pull request.',
			safety: 'destructive',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'force_push',
			name: 'Force-push',
			description: 'Force-push to a branch, overwriting history.',
			safety: 'irreversible',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
		{
			id: 'delete_branch',
			name: 'Delete branch',
			description: 'Delete a branch.',
			safety: 'destructive',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
		},
	]

	readonly triggers: readonly TriggerDescriptor[] = [
		{ id: 'issue_opened', name: 'Issue opened', description: '', kind: 'webhook' },
		{ id: 'pr_opened', name: 'PR opened', description: '', kind: 'webhook' },
		{ id: 'pr_merged', name: 'PR merged', description: '', kind: 'webhook' },
		{ id: 'check_failed', name: 'CI check failed', description: '', kind: 'webhook' },
	]

	readonly sinks: readonly SinkDescriptor[] = [
		{ id: 'pr_comment', name: 'PR comment', description: '', safety: 'safe' },
		{ id: 'issue_comment', name: 'Issue comment', description: '', safety: 'safe' },
		{ id: 'check_run', name: 'Check run status', description: '', safety: 'safe' },
	]
}
