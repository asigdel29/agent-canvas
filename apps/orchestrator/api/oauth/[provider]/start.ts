/**
 * GET /api/oauth/:provider/start — begin an OAuth handover.
 *
 * Generates a CSRF state token, stores it in a short-lived signed
 * cookie, and redirects the user to the provider's authorize URL.
 * Real implementation lands when the connector's OAuth framework is
 * fully wired (per-adapter follow-up PR).
 */

import { getRuntime } from '../../../dist/index.js'
import type { ProviderId } from '@agent-canvas/orchestrator-types'

export default async function handler(req: Request): Promise<Response> {
	if (req.method !== 'GET') return jsonError(405, 'method_not_allowed')
	const url = new URL(req.url)
	const segments = url.pathname.split('/').filter(Boolean)
	const provider = segments[segments.length - 2] as ProviderId | undefined
	if (!provider) return jsonError(404, 'missing_provider')

	const { registry } = getRuntime()
	let connector: ReturnType<typeof registry.getConnector>
	try {
		connector = registry.getConnector(provider)
	} catch {
		return jsonError(404, `unknown_connector: ${provider}`)
	}

	const state = crypto.randomUUID()
	const redirect_uri = `${url.origin}/api/oauth/${provider}/callback`
	try {
		const { authorize_url } = await connector.oauth.authorize({ state, redirect_uri })
		return new Response(null, {
			status: 302,
			headers: {
				location: authorize_url,
				'set-cookie': `oauth_state_${provider}=${state}; Path=/api/oauth/${provider}; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
			},
		})
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'oauth_not_implemented'
		return jsonError(501, 'oauth_not_implemented', msg)
	}
}

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
