import { describe, expect, it, vi } from 'vitest'
import {
	ConnectorRevokedError,
	TokenExpiredError,
	TokenRefreshError,
} from '@agent-canvas/connector-core'
import {
	OAuthHelper,
	parseStandardTokenResponse,
	type FetchLike,
} from './_oauth.js'

const CONFIG = {
	clientId: 'client_id_test',
	clientSecret: 'client_secret_test',
	scope: 'repo:read',
	authorizeUrl: 'https://provider.example.com/oauth/authorize',
	tokenUrl: 'https://provider.example.com/oauth/token',
	revokeUrl: 'https://provider.example.com/oauth/revoke',
}

function fakeFetch(handler: (input: { url: string; body: URLSearchParams }) => Response): FetchLike {
	return vi.fn(async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
		const url = typeof input === 'string' ? input : input.toString()
		const body = init?.body as URLSearchParams
		return handler({ url, body })
	}) as unknown as FetchLike
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

describe('OAuthHelper.authorize', () => {
	const helper = new OAuthHelper({
		config: CONFIG,
		providerKey: 'github',
		parseTokenResponse: parseStandardTokenResponse,
	})

	it('builds the authorize URL with all required params', async () => {
		const { authorize_url } = await helper.authorize({
			state: 'csrf_state_xyz',
			redirect_uri: 'https://app.example.com/api/oauth/github/callback',
		})
		const url = new URL(authorize_url)
		expect(url.origin + url.pathname).toBe(CONFIG.authorizeUrl)
		expect(url.searchParams.get('client_id')).toBe(CONFIG.clientId)
		expect(url.searchParams.get('state')).toBe('csrf_state_xyz')
		expect(url.searchParams.get('redirect_uri')).toBe(
			'https://app.example.com/api/oauth/github/callback'
		)
		expect(url.searchParams.get('scope')).toBe('repo:read')
		expect(url.searchParams.get('response_type')).toBe('code')
	})
})

describe('OAuthHelper.callback', () => {
	it('exchanges code for an access_token', async () => {
		const f = fakeFetch(({ url, body }) => {
			expect(url).toBe(CONFIG.tokenUrl)
			expect(body.get('code')).toBe('the_code')
			expect(body.get('grant_type')).toBe('authorization_code')
			return jsonResponse({
				access_token: 'tok_abc',
				refresh_token: 'ref_abc',
				expires_in: 3600,
				scope: 'repo:read',
			})
		})
		const helper = new OAuthHelper({
			config: CONFIG,
			providerKey: 'github',
			parseTokenResponse: parseStandardTokenResponse,
			fetch: f,
		})
		const tokens = await helper.callback({ state: 's', code: 'the_code' })
		expect(tokens.access_token).toBe('tok_abc')
		expect(tokens.refresh_token).toBe('ref_abc')
		expect(tokens.scope).toBe('repo:read')
		expect(tokens.expires_at).toBeTruthy()
	})

	it('throws TokenRefreshError on non-2xx response', async () => {
		const f = fakeFetch(() => new Response('bad', { status: 500 }))
		const helper = new OAuthHelper({
			config: CONFIG,
			providerKey: 'github',
			parseTokenResponse: parseStandardTokenResponse,
			fetch: f,
		})
		await expect(helper.callback({ state: 's', code: 'c' })).rejects.toBeInstanceOf(
			TokenRefreshError
		)
	})

	it('throws TokenRefreshError when the JSON body carries an OAuth error', async () => {
		const f = fakeFetch(() => jsonResponse({ error: 'invalid_request' }))
		const helper = new OAuthHelper({
			config: CONFIG,
			providerKey: 'github',
			parseTokenResponse: parseStandardTokenResponse,
			fetch: f,
		})
		await expect(helper.callback({ state: 's', code: 'c' })).rejects.toBeInstanceOf(
			TokenRefreshError
		)
	})
})

describe('OAuthHelper.refresh', () => {
	it('exchanges a refresh_token for a new access_token', async () => {
		const f = fakeFetch(({ body }) => {
			expect(body.get('grant_type')).toBe('refresh_token')
			expect(body.get('refresh_token')).toBe('ref_old')
			return jsonResponse({ access_token: 'tok_new', expires_in: 3600 })
		})
		const helper = new OAuthHelper({
			config: CONFIG,
			providerKey: 'github',
			parseTokenResponse: parseStandardTokenResponse,
			fetch: f,
		})
		const tokens = await helper.refresh({ access_token: 'tok_old', refresh_token: 'ref_old' })
		expect(tokens.access_token).toBe('tok_new')
		// Original refresh_token carried forward when response omits it.
		expect(tokens.refresh_token).toBe('ref_old')
	})

	it('throws TokenExpiredError when no refresh_token is present', async () => {
		const helper = new OAuthHelper({
			config: CONFIG,
			providerKey: 'github',
			parseTokenResponse: parseStandardTokenResponse,
		})
		await expect(helper.refresh({ access_token: 'tok_old' })).rejects.toBeInstanceOf(
			TokenExpiredError
		)
	})

	it('throws ConnectorRevokedError when the provider returns invalid_grant', async () => {
		const f = fakeFetch(() => jsonResponse({ error: 'invalid_grant' }))
		const helper = new OAuthHelper({
			config: CONFIG,
			providerKey: 'github',
			parseTokenResponse: parseStandardTokenResponse,
			fetch: f,
		})
		await expect(
			helper.refresh({ access_token: 'tok_old', refresh_token: 'ref_revoked' })
		).rejects.toBeInstanceOf(ConnectorRevokedError)
	})
})

describe('OAuthHelper.revoke', () => {
	it('POSTs to the revoke URL with the token', async () => {
		const calls: { url: string; body: URLSearchParams }[] = []
		const f = fakeFetch((c) => {
			calls.push(c)
			return new Response(null, { status: 200 })
		})
		const helper = new OAuthHelper({
			config: CONFIG,
			providerKey: 'github',
			parseTokenResponse: parseStandardTokenResponse,
			fetch: f,
		})
		await helper.revoke({ access_token: 'tok_abc' })
		expect(calls).toHaveLength(1)
		expect(calls[0]!.url).toBe(CONFIG.revokeUrl)
		expect(calls[0]!.body.get('token')).toBe('tok_abc')
	})

	it('is a no-op when the provider has no revoke URL', async () => {
		const helper = new OAuthHelper({
			config: { ...CONFIG, revokeUrl: undefined as unknown as string }, // typing exercise
			providerKey: 'github',
			parseTokenResponse: parseStandardTokenResponse,
		})
		await expect(helper.revoke({ access_token: 't' })).resolves.toBeUndefined()
	})
})

describe('parseStandardTokenResponse', () => {
	it('passes through access_token, refresh_token, scope', () => {
		const t = parseStandardTokenResponse({
			access_token: 'a',
			refresh_token: 'r',
			scope: 's',
		})
		expect(t.access_token).toBe('a')
		expect(t.refresh_token).toBe('r')
		expect(t.scope).toBe('s')
	})

	it('converts expires_in (seconds) to expires_at (ISO string)', () => {
		const before = Date.now()
		const t = parseStandardTokenResponse({ access_token: 'a', expires_in: 60 })
		const after = Date.now()
		const t_ms = new Date(t.expires_at!).getTime()
		expect(t_ms).toBeGreaterThanOrEqual(before + 59_000)
		expect(t_ms).toBeLessThanOrEqual(after + 61_000)
	})

	it('throws when access_token is missing', () => {
		expect(() => parseStandardTokenResponse({})).toThrow(/access_token/)
	})
})
