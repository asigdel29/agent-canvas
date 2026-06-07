/**
 * Local development server for the orchestrator.
 *
 * The orchestrator ships as a set of handler modules under `handlers/`,
 * each exporting a default function that takes a Web `Request` and returns
 * a Web `Response`. The production server (`scripts/server.ts`) routes
 * every `/api/*` request to the matching handler via the shared route
 * table in `handlers/_router.ts`. This script does the same thing for
 * local development, adding the `/dev/*` helpers below, so the stack can
 * be exercised end-to-end without any external login.
 *
 * Routes mirror the file layout under `handlers/`:
 *
 *     GET  /api/health                    → handlers/health.ts
 *     POST /api/commands                  → handlers/commands.ts
 *     POST /api/auth/sse-token            → handlers/auth/sse-token.ts
 *     GET  /api/sync/:room                → handlers/sync/[room].ts
 *     POST /api/webhooks/ingest/:provider → handlers/webhooks/ingest/[provider].ts
 *     GET  /api/oauth/:provider/start     → handlers/oauth/[provider]/start.ts
 *     GET  /api/oauth/:provider/callback  → handlers/oauth/[provider]/callback.ts
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
 * Required env vars (loaded from ./.env — see .env.example):
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
 * @author asigdel29
 */

import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadRoute } from '../handlers/_router.js'
import {
	loadDotEnvIfPresent,
	nodeRequestToWebRequest,
	writeWebResponseToNode,
} from './httpBridge.js'

import { signSession } from '../dist/auth/jwt.js'
import { getRuntime } from '../dist/index.js'
import { logger } from '../dist/observability/logger.js'

// Prefer the consolidated repo-root .env (what ./scripts/setup.sh
// writes); fall back to the orchestrator-local .env.local for anyone
// still using the older per-workspace file.
{
	const scriptDir = dirname(fileURLToPath(import.meta.url))
	loadDotEnvIfPresent([
		resolve(scriptDir, '..', '..', '..', '.env'),
		resolve(scriptDir, '..', '.env.local'),
	])
}

const PORT = Number(process.env['PORT'] ?? 3000)
const REQUIRED = ['JWT_SECRET', 'SSE_TOKEN_SECRET'] as const
const missing = REQUIRED.filter((k) => !process.env[k])
if (missing.length > 0) {
	process.stderr.write(
		`[dev-server] missing required env vars: ${missing.join(', ')}\n` +
			`Run ./scripts/setup.sh (it generates them) or set them in ./.env.\n`
	)
	process.exit(1)
}
if (!process.env['ALLOWED_ORIGINS']) {
	process.env['ALLOWED_ORIGINS'] = 'http://localhost:5173,http://localhost:5420'
}

// Route matching lives in handlers/_router.ts so the production server
// (scripts/server.ts) and the dev server share one table. The Node ⇄ Web
// request bridge and the .env loader live in ./httpBridge.ts so this
// server and the production server share one copy.

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
		const webReq = await nodeRequestToWebRequest(rawReq, PORT)
		const webRes = await devMintSession(webReq)
		await writeWebResponseToNode(webRes, rawRes)
		return
	}
	const emitMatch = pathname.match(/^\/dev\/emit\/(.+)$/)
	if (emitMatch) {
		const webReq = await nodeRequestToWebRequest(rawReq, PORT)
		const webRes = await devEmit(webReq, emitMatch[1]!)
		await writeWebResponseToNode(webRes, rawRes)
		return
	}

	const handler = await loadRoute(method, pathname)
	if (!handler) {
		rawRes.statusCode = 404
		rawRes.setHeader('content-type', 'application/json')
		rawRes.end(JSON.stringify({ error: 'route_not_found', path: pathname, method }))
		return
	}

	try {
		const webReq = await nodeRequestToWebRequest(rawReq, PORT)
		const webRes = await handler(webReq)
		await writeWebResponseToNode(webRes, rawRes)
	} catch (err) {
		// Log the real error server-side; never return its message (which can
		// carry a stack or internal detail) to the client.
		logger.error('handler_threw', { err })
		rawRes.statusCode = 500
		rawRes.setHeader('content-type', 'application/json')
		rawRes.end(JSON.stringify({ error: 'internal_error' }))
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
