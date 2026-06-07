/**
 * GET /api/auth/github/callback — finish the GitHub sign-in flow.
 *
 * GitHub redirects here with ?code=<oauth-code>&state=<state-jwt>.
 * We verify the state JWT, exchange the code for an access token,
 * read the GitHub user's login + id via /user, mint our own session
 * JWT, and redirect back to the caller's original destination
 * (recovered from the state payload, not from the URL query — the
 * URL query is attacker-controlled).
 *
 * The GitHub access token is intentionally NOT persisted. Login
 * uses GitHub as an identity provider only; connector-style access
 * to GitHub APIs goes through /api/oauth/github/start which DOES
 * persist tokens against an explicit user consent.
 *
 * The session JWT lands in the redirect URL as ?session=<jwt>. The
 * canvas's intakeAndStashCredentials picks it up on first load and
 * immediately strips it via history.replaceState.
 *
 * Required env vars are the same as /api/auth/login/github plus:
 *
 *   GITHUB_OAUTH_CLIENT_SECRET   GitHub OAuth app client secret
 *   JWT_SECRET                   session JWT HMAC secret
 *   AUTH_STATE_SECRET            HMAC for the state JWT we minted
 * @author asigdel29
 */

import { signSession, verifySession } from '../../../dist/auth/jwt.js'
import { preflightResponse } from '../../../dist/http/cors.js'
import { getRuntime } from '../../../dist/index.js'
import { logger } from '../../../dist/observability/logger.js'
import type { UserId } from '@agent-canvas/orchestrator-types'

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_USER_URL = 'https://api.github.com/user'
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight
	if (req.method !== 'GET') return jsonError(405, 'method_not_allowed')

	const clientId = process.env['GITHUB_OAUTH_CLIENT_ID']
	const clientSecret = process.env['GITHUB_OAUTH_CLIENT_SECRET']
	const sessionSecret = process.env['JWT_SECRET']
	const stateSecret = process.env['AUTH_STATE_SECRET']
	const canvasOrigin = process.env['CANVAS_ORIGIN']
	if (!clientId || !clientSecret || !sessionSecret || !stateSecret || !canvasOrigin) {
		return jsonError(500, 'auth_misconfigured')
	}

	const url = new URL(req.url)
	const code = url.searchParams.get('code')
	const stateJwt = url.searchParams.get('state')
	const ghError = url.searchParams.get('error')
	if (ghError) {
		// User clicked Cancel on GitHub. Send them back without a session.
		return Response.redirect(`${canvasOrigin}/?auth=cancelled`, 302)
	}
	if (!code || !stateJwt) return jsonError(400, 'missing_code_or_state')

	// Verify our own state JWT to confirm this callback wasn't forged.
	let stateClaims
	try {
		stateClaims = verifySession(stateJwt, stateSecret)
	} catch {
		return jsonError(400, 'invalid_state')
	}
	const redirectTo = decodeStatePayload(stateClaims.sub as string)
	if (!redirectTo) return jsonError(400, 'invalid_state_payload')

	const orchestratorOrigin =
		process.env['PUBLIC_ORCHESTRATOR_ORIGIN'] ?? `${url.protocol}//${url.host}`
	const callbackUrl = `${orchestratorOrigin}/api/auth/github/callback`

	// Exchange the code for an access token.
	let access: string
	try {
		access = await exchangeCode(code, clientId, clientSecret, callbackUrl)
	} catch (err) {
		logger.error('github_token_exchange_failed', { err })
		return jsonError(502, 'github_token_exchange_failed', 'could not complete GitHub sign-in')
	}

	// Read the GitHub user. We need a stable identifier; login can
	// change but the numeric id is forever, so we use id and keep
	// login as a human-readable suffix on sub.
	let user: GitHubUser
	try {
		user = await fetchGitHubUser(access)
	} catch (err) {
		logger.error('github_user_fetch_failed', { err })
		return jsonError(502, 'github_user_fetch_failed', 'could not read your GitHub profile')
	}

	// Upsert the user + ensure they have a solo workspace. This is
	// the first time the tenancy tables see this person; once landed
	// here every subsequent login is a no-op idempotent refresh.
	const runtime = getRuntime() as unknown as {
		tenancyStore?: import('../../../dist/tenancy/tenancyStore.js').TenancyStore
	}
	const tenancy = runtime.tenancyStore
	if (!tenancy) return jsonError(500, 'tenancy_store_not_initialized')

	const tenantUser = await tenancy.upsertGithubUser({
		github_id: String(user.id),
		github_login: user.login,
		email: user.email ?? null,
		name: user.name ?? null,
	})
	const workspace = await tenancy.ensureSoloWorkspace(
		tenantUser.id,
		`${user.login}'s workspace`
	)

	const now = Math.floor(Date.now() / 1000)
	const session = signSession(
		{
			sub: tenantUser.id as UserId,
			workspace_id: workspace.id,
			exp: now + SESSION_TTL_SECONDS,
			iat: now,
		} as never,
		sessionSecret
	)

	// Redirect with the session + workspace + handle in the URL. The
	// canvas immediately stashes everything to sessionStorage and
	// strips the params with replaceState.
	const dest = new URL(redirectTo)
	dest.searchParams.set('session', session)
	if (!dest.searchParams.has('room')) {
		dest.searchParams.set('room', workspace.id)
	}
	dest.searchParams.set('workspace_id', workspace.id)
	dest.searchParams.set('login_provider', 'github')
	dest.searchParams.set('login_handle', user.login)

	return Response.redirect(dest.toString(), 302)
}

interface GitHubUser {
	readonly id: number
	readonly login: string
	readonly name?: string | null
	readonly email?: string | null
}

async function exchangeCode(
	code: string,
	clientId: string,
	clientSecret: string,
	redirectUri: string
): Promise<string> {
	const body = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		code,
		redirect_uri: redirectUri,
	})
	const res = await fetch(GITHUB_TOKEN_URL, {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'application/x-www-form-urlencoded',
		},
		body: body.toString(),
		signal: AbortSignal.timeout(8000),
	})
	if (!res.ok) {
		throw new Error(`github token endpoint returned HTTP ${res.status}`)
	}
	const json = (await res.json()) as { access_token?: string; error?: string }
	if (json.error) throw new Error(`github reported: ${json.error}`)
	if (!json.access_token) throw new Error('github returned no access_token')
	return json.access_token
}

async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
	const res = await fetch(GITHUB_USER_URL, {
		headers: {
			authorization: `Bearer ${accessToken}`,
			accept: 'application/vnd.github+json',
			'user-agent': 'agent-canvas-auth/1.0',
		},
		signal: AbortSignal.timeout(8000),
	})
	if (!res.ok) throw new Error(`github /user returned HTTP ${res.status}`)
	const json = (await res.json()) as GitHubUser
	if (typeof json.id !== 'number' || typeof json.login !== 'string') {
		throw new Error('github /user returned unexpected shape')
	}
	return { id: json.id, login: json.login, name: json.name ?? null, email: json.email ?? null }
}

function decodeStatePayload(sub: string): string | null {
	const sep = sub.indexOf(':')
	if (sep < 0) return null
	const encoded = sub.slice(0, sep)
	try {
		return Buffer.from(encoded, 'base64url').toString('utf8')
	} catch {
		return null
	}
}

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
