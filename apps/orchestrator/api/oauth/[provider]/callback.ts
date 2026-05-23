/**
 * GET /api/oauth/:provider/callback — exchange the authorization code
 * for a token set and persist it to the vault.
 *
 * Validates the `state` parameter against the signed cookie set by
 * /start (CSRF defense). Real token exchange lands in the per-adapter
 * follow-up PRs.
 */

import { getRuntime } from '../../../dist/index.js'
import type { ProviderId } from '@agent-canvas/orchestrator-types'

export const config = {
	runtime: 'nodejs',
}

export default async function handler(req: Request): Promise<Response> {
	if (req.method !== 'GET') return jsonError(405, 'method_not_allowed')
	const url = new URL(req.url)
	const segments = url.pathname.split('/').filter(Boolean)
	const provider = segments[segments.length - 2] as ProviderId | undefined
	if (!provider) return jsonError(404, 'missing_provider')

	const state = url.searchParams.get('state')
	const code = url.searchParams.get('code')
	if (!state || !code) return jsonError(400, 'missing_state_or_code')

	const cookieHeader = req.headers.get('cookie') ?? ''
	const expected = parseCookie(cookieHeader, `oauth_state_${provider}`)
	if (!expected || expected !== state) return jsonError(403, 'csrf_state_mismatch')

	const { registry } = getRuntime()
	let connector: ReturnType<typeof registry.getConnector>
	try {
		connector = registry.getConnector(provider)
	} catch {
		return jsonError(404, `unknown_connector: ${provider}`)
	}

	try {
		const tokenSet = await connector.oauth.callback({ state, code })
		// Production: encrypt and store in vault via Vault.store(...).
		return new Response(
			JSON.stringify({
				provider,
				connected: true,
				expires_at: tokenSet.expires_at ?? null,
			}),
			{
				status: 200,
				headers: {
					'content-type': 'application/json',
					'set-cookie': `oauth_state_${provider}=; Path=/api/oauth/${provider}; Max-Age=0`,
				},
			}
		)
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'oauth_not_implemented'
		return jsonError(501, 'oauth_not_implemented', msg)
	}
}

function parseCookie(header: string, name: string): string | null {
	for (const part of header.split(';')) {
		const [k, v] = part.trim().split('=')
		if (k === name && v !== undefined) return decodeURIComponent(v)
	}
	return null
}

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
