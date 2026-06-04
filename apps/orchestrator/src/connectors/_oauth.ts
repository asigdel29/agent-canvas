/**
 * Shared OAuth 2.0 authorization-code flow.
 *
 * Three of our providers (GitHub, Linear, Slack) speak nearly the same
 * OAuth 2.0 flow with minor shape differences. This helper isolates the
 * common HTTP work; per-provider connectors supply URLs and body shapes.
 *
 * The default fetch is the global one; tests pass an injected fetch
 * that returns fixture responses.
 * @author asigdel29
 */

import {
	ConnectorRevokedError,
	type OAuthAuthorizeRequest,
	type OAuthAuthorizeResult,
	type OAuthCallbackRequest,
	type OAuthFramework,
	type OAuthTokenSet,
	TokenExpiredError,
	TokenRefreshError,
} from '@agent-canvas/connector-core'

export type FetchLike = typeof fetch

export interface OAuthConfig {
	readonly clientId: string
	readonly clientSecret: string
	readonly scope: string
	readonly authorizeUrl: string
	readonly tokenUrl: string
	readonly revokeUrl?: string
}

export interface OAuthHelperOptions {
	readonly config: OAuthConfig
	readonly providerKey: string
	/** Translates a token-response body into our normalized OAuthTokenSet. */
	readonly parseTokenResponse: (json: Record<string, unknown>) => OAuthTokenSet
	/** Optional override for the form-encoded body. */
	readonly buildExchangeBody?: (req: { code: string; redirectUri?: string }) => URLSearchParams
	readonly fetch?: FetchLike
}

export class OAuthHelper implements OAuthFramework {
	constructor(private readonly opts: OAuthHelperOptions) {}

	async authorize(req: OAuthAuthorizeRequest): Promise<OAuthAuthorizeResult> {
		const url = new URL(this.opts.config.authorizeUrl)
		url.searchParams.set('client_id', this.opts.config.clientId)
		url.searchParams.set('redirect_uri', req.redirect_uri)
		url.searchParams.set('state', req.state)
		url.searchParams.set('scope', this.opts.config.scope)
		url.searchParams.set('response_type', 'code')
		return { authorize_url: url.toString() }
	}

	async callback(req: OAuthCallbackRequest): Promise<OAuthTokenSet> {
		const f = this.opts.fetch ?? fetch
		const body =
			this.opts.buildExchangeBody?.({ code: req.code }) ??
			new URLSearchParams({
				client_id: this.opts.config.clientId,
				client_secret: this.opts.config.clientSecret,
				code: req.code,
				grant_type: 'authorization_code',
			})
		const res = await f(this.opts.config.tokenUrl, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/x-www-form-urlencoded',
			},
			body,
		})
		if (!res.ok) {
			throw new TokenRefreshError(
				this.opts.providerKey as never,
				`oauth callback failed: ${res.status} ${await res.text()}`
			)
		}
		const json = (await res.json()) as Record<string, unknown>
		if (typeof json['error'] === 'string') {
			throw new TokenRefreshError(
				this.opts.providerKey as never,
				`oauth callback failed: ${String(json['error'])}`
			)
		}
		return this.opts.parseTokenResponse(json)
	}

	async refresh(token_set: OAuthTokenSet): Promise<OAuthTokenSet> {
		if (!token_set.refresh_token) throw new TokenExpiredError(this.opts.providerKey as never)
		const f = this.opts.fetch ?? fetch
		const body = new URLSearchParams({
			client_id: this.opts.config.clientId,
			client_secret: this.opts.config.clientSecret,
			refresh_token: token_set.refresh_token,
			grant_type: 'refresh_token',
		})
		const res = await f(this.opts.config.tokenUrl, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/x-www-form-urlencoded',
			},
			body,
		})
		if (!res.ok) {
			throw new TokenRefreshError(
				this.opts.providerKey as never,
				`refresh failed: ${res.status}`
			)
		}
		const json = (await res.json()) as Record<string, unknown>
		if (json['error'] === 'invalid_grant') {
			throw new ConnectorRevokedError(this.opts.providerKey as never)
		}
		if (typeof json['error'] === 'string') {
			throw new TokenRefreshError(this.opts.providerKey as never, String(json['error']))
		}
		const refreshed = this.opts.parseTokenResponse(json)
		// Some providers return only access_token on refresh; carry the
		// existing refresh_token forward if absent.
		return {
			access_token: refreshed.access_token,
			...(refreshed.refresh_token !== undefined && {
				refresh_token: refreshed.refresh_token,
			}),
			...(refreshed.refresh_token === undefined && token_set.refresh_token !== undefined && {
				refresh_token: token_set.refresh_token,
			}),
			...(refreshed.expires_at !== undefined && { expires_at: refreshed.expires_at }),
			...(refreshed.scope !== undefined && { scope: refreshed.scope }),
		}
	}

	async revoke(token_set: OAuthTokenSet): Promise<void> {
		const revokeUrl = this.opts.config.revokeUrl
		if (!revokeUrl) return // best-effort: no-op when the provider has no revoke endpoint
		const f = this.opts.fetch ?? fetch
		const body = new URLSearchParams({
			client_id: this.opts.config.clientId,
			client_secret: this.opts.config.clientSecret,
			token: token_set.access_token,
		})
		await f(revokeUrl, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/x-www-form-urlencoded',
			},
			body,
		})
	}
}

/** Build a token set from a `{access_token, refresh_token?, expires_in?, scope?}` payload. */
export function parseStandardTokenResponse(json: Record<string, unknown>): OAuthTokenSet {
	const access_token = String(json['access_token'] ?? '')
	if (!access_token) throw new Error('access_token missing in OAuth response')
	const out: OAuthTokenSet = { access_token }
	if (typeof json['refresh_token'] === 'string') {
		;(out as { refresh_token?: string }).refresh_token = json['refresh_token']
	}
	if (typeof json['expires_in'] === 'number') {
		const expiresMs = Date.now() + json['expires_in'] * 1000
		;(out as { expires_at?: string }).expires_at = new Date(expiresMs).toISOString()
	}
	if (typeof json['scope'] === 'string') {
		;(out as { scope?: string }).scope = json['scope']
	}
	return out
}
