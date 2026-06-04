/**
 * httpBridge.ts — shared glue between Node's `http` server and the
 * orchestrator's Web-standard handlers.
 *
 * Every orchestrator handler takes a Web `Request` and returns a Web
 * `Response` (the same shape a Vercel Function receives). Both the local
 * dev server (scripts/dev-server.ts) and the production server
 * (scripts/server.ts) run those handlers on a plain Node `http` server,
 * so the request/response conversion and the optional .env loader live
 * here once rather than being copied into each entry point.
 *
 * @author asigdel29
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'

/**
 * Convert a Node `IncomingMessage` into a Web `Request`.
 *
 * Node delivers only the path on `req.url`, so the absolute URL is
 * reconstructed from the `Host` header (falling back to `localhost:port`).
 * Per the Fetch spec a GET/HEAD request must not carry a body, so the
 * body is read only for other methods.
 *
 * @param req  the incoming Node request; its stream is fully consumed for
 *             non-GET/HEAD methods.
 * @param port the listening port, used only to synthesize a host when the
 *             `Host` header is absent.
 * @returns a Web `Request` mirroring method, headers, and body.
 */
export async function nodeRequestToWebRequest(
	req: IncomingMessage,
	port: number
): Promise<Request> {
	const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url ?? '/'}`
	const headers = new Headers()
	for (const [k, v] of Object.entries(req.headers)) {
		if (v === undefined) continue
		if (Array.isArray(v)) headers.set(k, v.join(','))
		else headers.set(k, v)
	}
	const method = req.method ?? 'GET'
	const init: RequestInit = { method, headers }
	if (method !== 'GET' && method !== 'HEAD') {
		const chunks: Buffer[] = []
		for await (const chunk of req) chunks.push(chunk as Buffer)
		init.body = Buffer.concat(chunks)
	}
	return new Request(url, init)
}

/**
 * Stream a Web `Response` out through a Node `ServerResponse`.
 *
 * The body is streamed chunk by chunk rather than buffered so that
 * Server-Sent Events (the multiplayer transport) flush to the client as
 * they are produced instead of only at end-of-stream.
 *
 * @param res the Web `Response` to write.
 * @param out the Node response to write status, headers, and body into;
 *            it is ended before this resolves.
 */
export async function writeWebResponseToNode(
	res: Response,
	out: ServerResponse
): Promise<void> {
	out.statusCode = res.status
	res.headers.forEach((value, key) => out.setHeader(key, value))
	if (!res.body) {
		out.end()
		return
	}
	const reader = res.body.getReader()
	for (;;) {
		const { value, done } = await reader.read()
		if (done) break
		out.write(typeof value === 'string' ? value : Buffer.from(value))
	}
	out.end()
}

/**
 * Best-effort loader for a KEY=VALUE env file.
 *
 * Tries each path in order and loads the first that exists. Blank lines
 * and `#` comments are ignored; surrounding single or double quotes are
 * stripped. Variable expansion and multi-line values are intentionally
 * unsupported — for anything richer, export variables before starting
 * the process (which is what a platform such as Railway does). Existing
 * `process.env` values are never overwritten, so real environment
 * variables always win over the file.
 *
 * @param paths absolute paths to try, in priority order.
 * @returns the path that was loaded, or null when none existed.
 */
export function loadDotEnvIfPresent(paths: readonly string[]): string | null {
	for (const path of paths) {
		let text: string
		try {
			text = readFileSync(path, 'utf8')
		} catch {
			continue
		}
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
		return path
	}
	return null
}
