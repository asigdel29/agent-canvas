/**
 * POST /api/agents/probe-mcp
 *   body: { url: string, auth?: { type: 'bearer', token: string } | { type: 'oauth' } }
 *
 * Opens a single MCP connection, lists tools, closes, returns the
 * count + tool names. Used by the NewAgentModal's "Test" button
 * so the user gets fast feedback on whether an MCP URL is reachable
 * BEFORE they hit Create. Previously the user only learned of a
 * bad URL at run time.
 *
 * Connection lifetime is short (5s connect timeout + the time to
 * list tools, usually <500ms). The probe NEVER calls any tool; it
 * only connects and lists.
 *
 * Errors:
 *   400 missing_url            url field empty
 *   400 invalid_url            url isn't http(s)
 *   504 probe_timeout          connect exceeded 5s
 *   502 probe_failed           server refused / wrong protocol
 *   200 { tools: [{name, description?}], count: N }
 *
 * Session-gated (same auth as the rest of /api/agents). No rate
 * limit yet — adding one is a P1 task once any user can hit
 * arbitrary URLs.
 * @author asigdel29
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

import { extractSession } from '../../dist/auth/session.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight
	if (req.method !== 'POST') {
		return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))
	}

	const secret = process.env['JWT_SECRET']
	if (!secret) return withCorsHeaders(req, jsonError(500, 'jwt_secret_not_configured'))
	if (!extractSession(req, secret)) return withCorsHeaders(req, jsonError(401, 'unauthorized'))

	let body: { url?: string; auth?: { type: string; token?: string } }
	try {
		body = (await req.json()) as typeof body
	} catch {
		return withCorsHeaders(req, jsonError(400, 'malformed_json'))
	}

	const rawUrl = (body.url ?? '').trim()
	if (!rawUrl) return withCorsHeaders(req, jsonError(400, 'missing_url'))
	let url: URL
	try {
		url = new URL(rawUrl)
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return withCorsHeaders(req, jsonError(400, 'invalid_url', 'must be http(s)'))
		}
	} catch {
		return withCorsHeaders(req, jsonError(400, 'invalid_url', 'must be a parseable URL'))
	}

	const headers: Record<string, string> = {}
	if (body.auth?.type === 'bearer' && body.auth.token) {
		headers['authorization'] = `Bearer ${body.auth.token}`
	}

	const transport = new SSEClientTransport(url, { requestInit: { headers } })
	const client = new Client(
		{ name: 'agent-canvas-probe', version: '0.0.1' },
		{ capabilities: {} }
	)

	try {
		await Promise.race([
			client.connect(transport),
			new Promise<never>((_resolve, reject) =>
				setTimeout(() => reject(new Error('probe_timeout')), 5000)
			),
		])
		const list = await client.listTools()
		const tools = list.tools.map((t) => ({
			name: t.name,
			description: t.description ?? '',
		}))
		try {
			await client.close()
		} catch {
			/* best-effort */
		}
		return withCorsHeaders(
			req,
			new Response(JSON.stringify({ count: tools.length, tools }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		)
	} catch (err) {
		try {
			await client.close()
		} catch {
			/* best-effort */
		}
		const msg = err instanceof Error ? err.message : String(err)
		if (msg === 'probe_timeout') {
			return withCorsHeaders(
				req,
				jsonError(504, 'probe_timeout', `no response from ${url.host} within 5s`)
			)
		}
		return withCorsHeaders(req, jsonError(502, 'probe_failed', msg.slice(0, 320)))
	}
}

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
