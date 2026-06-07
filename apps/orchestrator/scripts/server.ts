/**
 * server.ts — single-process production server for agent-canvas.
 *
 * One persistent Node process serves the entire application on one
 * origin:
 *
 *   - /api/*            the orchestrator HTTP + SSE surface, dispatched
 *                       through the shared route table (handlers/_router).
 *   - everything else   the built canvas (apps/canvas/dist), with an
 *                       SPA fallback to index.html.
 *
 * Running as one long-lived process (rather than per-request serverless
 * functions) is what lets the SSE multiplayer layer hold a Postgres
 * LISTEN/NOTIFY connection open across requests, so this is the intended
 * deployment target for a platform such as Railway. Because the API and
 * the canvas share an origin, no CORS configuration is required for the
 * common single-domain deploy.
 *
 * A lightweight in-process scheduler drains the outbound-webhook queue on
 * an interval, replacing the platform cron the serverless deploy used.
 *
 * Required env: JWT_SECRET, SSE_TOKEN_SECRET. Optional: PORT (default
 * 3000), DATABASE_URL, ALLOWED_ORIGINS, WEBHOOK_DRAIN_DISABLED.
 *
 * @author asigdel29
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadRoute } from '../handlers/_router.js'
import {
	loadDotEnvIfPresent,
	nodeRequestToWebRequest,
	writeWebResponseToNode,
} from './httpBridge.js'
import { logger } from '../dist/observability/logger.js'

const HERE = dirname(fileURLToPath(import.meta.url)) // apps/orchestrator/scripts
const ORCH_ROOT = resolve(HERE, '..') // apps/orchestrator
const REPO_ROOT = resolve(ORCH_ROOT, '..', '..') // repository root
const CANVAS_DIST = resolve(REPO_ROOT, 'apps/canvas/dist')

// Local runs read a .env file; a platform (Railway) injects real env
// vars, which always take precedence over the file.
loadDotEnvIfPresent([join(REPO_ROOT, '.env'), join(ORCH_ROOT, '.env.local')])

const PORT = Number(process.env['PORT'] ?? 3000)

const REQUIRED = ['JWT_SECRET', 'SSE_TOKEN_SECRET'] as const
const missing = REQUIRED.filter((k) => !process.env[k])
if (missing.length > 0) {
	process.stderr.write(
		`[server] missing required env vars: ${missing.join(', ')}\n` +
			`Run ./scripts/setup.sh (it generates them) or set them in .env.\n`
	)
	process.exit(1)
}

/** Map a file extension to a Content-Type for static asset responses. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.txt': 'text/plain; charset=utf-8',
}

/**
 * Resolve a request path to a file inside the canvas build directory.
 *
 * Returns null when the resolved path would escape the build directory
 * (path-traversal guard). Hashed asset files are served as-is; any path
 * without a file extension is treated as a client-side route and falls
 * back to index.html so the single-page app can handle it.
 *
 * @param pathname the URL path requested by the browser.
 * @returns an absolute path under CANVAS_DIST, or null if traversal was
 *          attempted.
 */
function resolveStaticPath(pathname: string): string | null {
	const decoded = decodeURIComponent(pathname)
	const hasExtension = extname(decoded) !== ''
	const relative = hasExtension ? decoded : '/index.html'
	const candidate = normalize(join(CANVAS_DIST, relative))
	if (candidate !== CANVAS_DIST && !candidate.startsWith(CANVAS_DIST + '/')) {
		return null
	}
	return candidate
}

/**
 * Serve a static asset (or the SPA shell) for a non-API request.
 *
 * Missing hashed assets return 404; missing routes fall through to
 * index.html so the canvas router owns deep links. index.html is served
 * with no-cache and hashed assets with a long immutable cache.
 */
async function serveStatic(pathname: string, out: ServerResponse): Promise<void> {
	const filePath = resolveStaticPath(pathname)
	if (filePath === null) {
		out.statusCode = 403
		out.end('Forbidden')
		return
	}
	try {
		const body = await readFile(filePath)
		const ext = extname(filePath)
		out.statusCode = 200
		out.setHeader('content-type', CONTENT_TYPES[ext] ?? 'application/octet-stream')
		out.setHeader(
			'cache-control',
			ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable'
		)
		out.end(body)
	} catch {
		// A hashed asset that does not exist is a genuine 404; a missing
		// extensionless route was already rewritten to index.html above,
		// so reaching here for one means the canvas was never built.
		const fallback = await readFile(join(CANVAS_DIST, 'index.html')).catch(() => null)
		if (fallback) {
			out.statusCode = 200
			out.setHeader('content-type', 'text/html; charset=utf-8')
			out.setHeader('cache-control', 'no-cache')
			out.end(fallback)
			return
		}
		out.statusCode = 404
		out.setHeader('content-type', 'text/plain; charset=utf-8')
		out.end('Not found. Build the canvas with `npm run build` before starting the server.')
	}
}

const server = createServer(async (rawReq: IncomingMessage, rawRes: ServerResponse) => {
	const parsed = new URL(rawReq.url ?? '/', `http://${rawReq.headers.host ?? 'localhost'}`)
	const pathname = parsed.pathname
	const method = rawReq.method ?? 'GET'

	if (pathname.startsWith('/api/')) {
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
			// Log the real error server-side; never return its message (which
			// can carry a stack or internal detail) to the client.
			logger.error('handler_threw', { err })
			rawRes.statusCode = 500
			rawRes.setHeader('content-type', 'application/json')
			rawRes.end(JSON.stringify({ error: 'internal_error' }))
		}
		return
	}

	// Static assets only respond to GET/HEAD.
	if (method !== 'GET' && method !== 'HEAD') {
		rawRes.statusCode = 405
		rawRes.end('Method Not Allowed')
		return
	}
	await serveStatic(pathname, rawRes)
})

server.listen(PORT, () => {
	process.stdout.write(`[server] agent-canvas listening on http://localhost:${PORT}\n`)
	startWebhookDrain()
})

/**
 * Start the in-process outbound-webhook drainer.
 *
 * Replaces the platform cron the serverless deploy relied on: a single
 * interval timer drains a batch of pending deliveries every 60 seconds.
 * It is skipped when WEBHOOK_DRAIN_DISABLED is set, and each tick is a
 * cheap no-op when the queue is empty, so it costs nothing until an
 * outbound webhook endpoint is actually registered. The timer is
 * unref'd so it never holds the process open on shutdown.
 */
function startWebhookDrain(): void {
	if (process.env['WEBHOOK_DRAIN_DISABLED']) {
		process.stdout.write('[server] outbound webhook drain disabled\n')
		return
	}
	const intervalMs = 60_000
	const tick = async (): Promise<void> => {
		try {
			const { getRuntime } = await import('../dist/index.js')
			const { drainOnce } = await import('../dist/webhooks/drainOnce.js')
			const runtime = getRuntime() as unknown as {
				webhookEndpointStore?: Parameters<typeof drainOnce>[0]['endpointStore']
				webhookDeliveryStore?: Parameters<typeof drainOnce>[0]['deliveryStore']
			}
			const endpointStore = runtime.webhookEndpointStore
			const deliveryStore = runtime.webhookDeliveryStore
			if (!endpointStore || !deliveryStore) return
			await drainOnce({ endpointStore, deliveryStore }, { batchSize: 16 })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			process.stderr.write(`[server] webhook drain tick failed: ${msg}\n`)
		}
	}
	const timer = setInterval(() => void tick(), intervalMs)
	timer.unref()
}
