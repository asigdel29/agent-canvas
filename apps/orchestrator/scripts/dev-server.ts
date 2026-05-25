/**
 * Local development server for the orchestrator.
 *
 * The orchestrator ships as a set of Vercel Function handlers — each
 * `api/*.ts` exports a default function that takes a Web `Request` and
 * returns a Web `Response`. In production Vercel's runtime maps each
 * file to a route and dispatches accordingly. This script does the same
 * thing locally on a plain Node http server, so the stack can be
 * exercised end-to-end without `vercel dev` or any external login.
 *
 * Routes mirror the file layout under `api/`:
 *
 *     GET  /api/health                  → api/health.ts
 *     POST /api/commands                → api/commands.ts
 *     POST /api/auth/sse-token          → api/auth/sse-token.ts
 *     GET  /api/sync/:room              → api/sync/[room].ts
 *     POST /api/webhooks/:provider      → api/webhooks/[provider].ts
 *     GET  /api/oauth/:provider/start   → api/oauth/[provider]/start.ts
 *     GET  /api/oauth/:provider/callback → api/oauth/[provider]/callback.ts
 *
 * Additionally, two dev-only helpers ship under `/dev/*`. These are
 * never registered in production (the path prefix is not deployed) and
 * exist purely so a developer can produce credentials for manual smoke
 * testing without running a separate script:
 *
 *     POST /dev/mint-session            mint a session JWT for any sub
 *     GET  /dev/emit/:room              push a synthetic run event onto
 *                                       the room's bus (smoke-test SSE)
 *
 * Required env vars (load from .env.local — see .env.example):
 *
 *     JWT_SECRET            session-JWT HMAC key
 *     SSE_TOKEN_SECRET      SSE-token HMAC key (distinct from JWT_SECRET)
 *
 * Optional:
 *
 *     PORT                  defaults to 3000
 *     ALLOWED_ORIGINS       CORS allowlist; defaults to http://localhost:5173
 *     ENABLE_MOCK_PROVIDER  registers MockProvider for canned demo runs
 *
 * Throws on startup if a required env var is unset — fails-fast over
 * deferring the failure to the first authenticated request.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import healthHandler from '../api/health.js'
import commandsHandler from '../api/commands.js'
import sseTokenHandler from '../api/auth/sse-token.js'
import authLoginGithubHandler from '../api/auth/login/github.js'
import authGithubCallbackHandler from '../api/auth/github/callback.js'
import agentsIndexHandler from '../api/agents/index.js'
import agentByIdHandler from '../api/agents/[id].js'
import agentRunsHandler from '../api/agents/runs.js'
import agentProbeMcpHandler from '../api/agents/probe-mcp.js'
import feedbackHandler from '../api/feedback.js'
import tokensIndexHandler from '../api/tokens/index.js'
import tokenByIdHandler from '../api/tokens/[id].js'
import webhooksIndexHandler from '../api/webhooks/index.js'
import webhookByIdHandler from '../api/webhooks/[id].js'
import auditIndexHandler from '../api/audit/index.js'
import approvalsIndexHandler from '../api/approvals/index.js'
import approvalByIdHandler from '../api/approvals/[id].js'
import syncHandler from '../api/sync/[room].js'
import webhookHandler from '../api/webhooks/[provider].js'
import oauthStartHandler from '../api/oauth/[provider]/start.js'
import oauthCallbackHandler from '../api/oauth/[provider]/callback.js'

import { signSession } from '../dist/auth/jwt.js'
import { getRuntime } from '../dist/index.js'

loadDotEnvLocalIfPresent()

const PORT = Number(process.env['PORT'] ?? 3000)
const REQUIRED = ['JWT_SECRET', 'SSE_TOKEN_SECRET'] as const
const missing = REQUIRED.filter((k) => !process.env[k])
if (missing.length > 0) {
	process.stderr.write(
		`[dev-server] missing required env vars: ${missing.join(', ')}\n` +
			`Copy apps/orchestrator/.env.example to apps/orchestrator/.env.local and set them.\n`
	)
	process.exit(1)
}
if (!process.env['ALLOWED_ORIGINS']) {
	process.env['ALLOWED_ORIGINS'] = 'http://localhost:5173,http://localhost:5420'
}

/**
 * Route the incoming Node request to the matching Vercel handler.
 * Returns null when no route matches; the caller writes a 404.
 */
type Handler = (req: Request) => Promise<Response>

function matchRoute(method: string, pathname: string): Handler | null {
	// Every handler under api/ runs its own preflight check via the cors
	// module, so forward OPTIONS to whichever handler owns the path. The
	// handler returns 204 for a CORS preflight and the method-specific
	// behavior otherwise.
	const opts = method === 'OPTIONS'
	if (pathname === '/api/health' && method === 'GET') return healthHandler
	if (pathname === '/api/commands' && (method === 'POST' || opts)) return commandsHandler
	if (pathname === '/api/auth/sse-token' && (method === 'POST' || opts)) {
		return sseTokenHandler
	}
	if (pathname === '/api/auth/login/github' && method === 'GET') return authLoginGithubHandler
	if (pathname === '/api/auth/github/callback' && method === 'GET') return authGithubCallbackHandler
	if (pathname === '/api/agents' && (method === 'GET' || method === 'POST' || opts)) {
		return agentsIndexHandler
	}
	if (pathname === '/api/agents/runs' && (method === 'POST' || opts)) {
		return agentRunsHandler
	}
	if (pathname === '/api/agents/probe-mcp' && (method === 'POST' || opts)) {
		return agentProbeMcpHandler
	}
	if (pathname === '/api/feedback' && (method === 'POST' || opts)) {
		return feedbackHandler
	}
	if (pathname === '/api/tokens' && (method === 'GET' || method === 'POST' || opts)) {
		return tokensIndexHandler
	}
	if (
		pathname.match(/^\/api\/tokens\/[^/]+$/) &&
		(method === 'DELETE' || opts)
	) {
		return tokenByIdHandler
	}
	if (
		pathname.match(/^\/api\/agents\/[^/]+$/) &&
		(method === 'GET' || method === 'PATCH' || method === 'DELETE' || opts)
	) {
		return agentByIdHandler
	}
	if (pathname === '/api/approvals' && (method === 'GET' || opts)) {
		return approvalsIndexHandler
	}
	if (
		pathname.match(/^\/api\/approvals\/[^/]+$/) &&
		(method === 'POST' || opts)
	) {
		return approvalByIdHandler
	}
	if (pathname.startsWith('/api/sync/') && (method === 'GET' || opts)) return syncHandler
	if (pathname === '/api/audit' && (method === 'GET' || opts)) {
		return auditIndexHandler
	}
	// Outbound webhook management — list / register / revoke.
	// Matched BEFORE the inbound /api/webhooks/:provider route so a
	// GET or DELETE on /api/webhooks(...) reaches the outbound
	// handlers; POSTs with a provider segment still flow to inbound.
	if (pathname === '/api/webhooks' && (method === 'GET' || method === 'POST' || opts)) {
		return webhooksIndexHandler
	}
	if (
		pathname.match(/^\/api\/webhooks\/whe_[^/]+$/) &&
		(method === 'DELETE' || opts)
	) {
		return webhookByIdHandler
	}
	if (pathname.startsWith('/api/webhooks/') && (method === 'POST' || opts)) return webhookHandler
	if (pathname.match(/^\/api\/oauth\/[^/]+\/start$/) && (method === 'GET' || opts)) {
		return oauthStartHandler
	}
	if (pathname.match(/^\/api\/oauth\/[^/]+\/callback$/) && (method === 'GET' || opts)) {
		return oauthCallbackHandler
	}
	return null
}

async function nodeRequestToWebRequest(req: IncomingMessage): Promise<Request> {
	// Reconstruct an absolute URL. Node IncomingMessage carries only the path.
	const url = `http://${req.headers.host ?? `localhost:${PORT}`}${req.url ?? '/'}`
	const headers = new Headers()
	for (const [k, v] of Object.entries(req.headers)) {
		if (v === undefined) continue
		if (Array.isArray(v)) headers.set(k, v.join(','))
		else headers.set(k, v)
	}
	// GET/HEAD must not have a body per the Fetch spec.
	const method = req.method ?? 'GET'
	const init: RequestInit = { method, headers }
	if (method !== 'GET' && method !== 'HEAD') {
		const chunks: Buffer[] = []
		for await (const chunk of req) chunks.push(chunk as Buffer)
		init.body = Buffer.concat(chunks)
	}
	return new Request(url, init)
}

async function writeWebResponseToNode(res: Response, out: ServerResponse): Promise<void> {
	out.statusCode = res.status
	res.headers.forEach((value, key) => out.setHeader(key, value))
	if (!res.body) {
		out.end()
		return
	}
	// Stream the body so SSE works end-to-end.
	const reader = res.body.getReader()
	const decoder = new TextDecoder()
	for (;;) {
		const { value, done } = await reader.read()
		if (done) break
		out.write(typeof value === 'string' ? value : Buffer.from(value))
	}
	out.end()
	void decoder // silence unused
}

/**
 * Best-effort .env.local loader. Parses KEY=VALUE lines, ignores blanks
 * and # comments. Does not interpret variable expansion or quoted
 * multilines — kept deliberately small. For anything richer the user
 * exports env vars before running.
 */
function loadDotEnvLocalIfPresent(): void {
	try {
		// Anchor on the script's own location so the loader works regardless
		// of where `npm run dev` was invoked from (repo root, workspace, etc).
		const scriptDir = dirname(fileURLToPath(import.meta.url))
		const path = resolve(scriptDir, '..', '.env.local')
		const text = readFileSync(path, 'utf8')
		for (const raw of text.split('\n')) {
			const line = raw.trim()
			if (line.length === 0 || line.startsWith('#')) continue
			const eq = line.indexOf('=')
			if (eq < 0) continue
			const key = line.slice(0, eq).trim()
			let value = line.slice(eq + 1).trim()
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1)
			}
			if (!(key in process.env)) process.env[key] = value
		}
	} catch {
		// .env.local optional. Caller can also export env vars directly.
	}
}

/**
 * POST /dev/mint-session — produce a session JWT for the caller-supplied
 * sub. Dev-only: never exposed in production. Body: {sub, ttl_seconds?}.
 */
async function devMintSession(req: Request): Promise<Response> {
	if (req.method !== 'POST') {
		return json(405, { error: 'method_not_allowed' })
	}
	const secret = process.env['JWT_SECRET']!
	let body: { sub?: string; ttl_seconds?: number }
	try {
		body = (await req.json()) as { sub?: string; ttl_seconds?: number }
	} catch {
		return json(400, { error: 'malformed_json' })
	}
	const sub = (body.sub ?? 'u_dev') as never
	const ttlSeconds = body.ttl_seconds ?? 3600
	const now = Math.floor(Date.now() / 1000)
	const token = signSession({ sub, exp: now + ttlSeconds, iat: now }, secret)
	return json(200, { token, sub, expires_in: ttlSeconds })
}

/**
 * GET /dev/emit/:room — push a synthetic run event onto the room's bus
 * so an active SSE client immediately sees a message. Dev-only.
 */
async function devEmit(req: Request, roomId: string): Promise<Response> {
	if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' })
	const { roomEventBus } = getRuntime() as unknown as {
		roomEventBus?: {
			publish: (room_id: string, event: unknown) => void
			subscriberCount: (room_id: string) => number
		}
	}
	if (!roomEventBus) return json(503, { error: 'realtime_bus_not_initialized' })
	const event = {
		seq: Math.floor(Math.random() * 1_000_000),
		run_id: 'run_dev_synthetic' as never,
		kind: 'progress' as never,
		ts: new Date().toISOString(),
		schema_version: 1,
		payload: { message: 'synthetic dev-emit event' },
	}
	roomEventBus.publish(roomId, event)
	return json(200, {
		emitted: true,
		room_id: roomId,
		subscribers: roomEventBus.subscriberCount(roomId),
		event,
	})
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

const server = createServer(async (rawReq, rawRes) => {
	const reqUrl = rawReq.url ?? '/'
	const parsed = new URL(reqUrl, `http://${rawReq.headers.host ?? 'localhost'}`)
	const pathname = parsed.pathname
	const method = rawReq.method ?? 'GET'

	// Dev-only helpers first; they don't go through the auth middleware.
	if (pathname === '/dev/mint-session') {
		const webReq = await nodeRequestToWebRequest(rawReq)
		const webRes = await devMintSession(webReq)
		await writeWebResponseToNode(webRes, rawRes)
		return
	}
	const emitMatch = pathname.match(/^\/dev\/emit\/(.+)$/)
	if (emitMatch) {
		const webReq = await nodeRequestToWebRequest(rawReq)
		const webRes = await devEmit(webReq, emitMatch[1]!)
		await writeWebResponseToNode(webRes, rawRes)
		return
	}

	const handler = matchRoute(method, pathname)
	if (!handler) {
		rawRes.statusCode = 404
		rawRes.setHeader('content-type', 'application/json')
		rawRes.end(JSON.stringify({ error: 'route_not_found', path: pathname, method }))
		return
	}

	try {
		const webReq = await nodeRequestToWebRequest(rawReq)
		const webRes = await handler(webReq)
		await writeWebResponseToNode(webRes, rawRes)
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		rawRes.statusCode = 500
		rawRes.setHeader('content-type', 'application/json')
		rawRes.end(JSON.stringify({ error: 'handler_threw', detail: msg }))
	}
})

server.listen(PORT, () => {
	process.stdout.write(
		`[dev-server] listening on http://localhost:${PORT}\n` +
			`[dev-server] mint a session token:\n` +
			`    curl -s -XPOST http://localhost:${PORT}/dev/mint-session ` +
			`-H 'content-type: application/json' -d '{"sub":"u_dev"}'\n` +
			`[dev-server] open the canvas (default Vite port 5173) with:\n` +
			`    http://localhost:5173/?room=room_test&session=<jwt-from-above>\n`
	)
})
