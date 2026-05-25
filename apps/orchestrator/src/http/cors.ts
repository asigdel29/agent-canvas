/**
 * CORS — explicit allowlist driven by ALLOWED_ORIGINS env var.
 *
 *   ALLOWED_ORIGINS=https://canvas.example.com,https://staging.canvas.example.com
 *
 * Wildcards are deliberately rejected. The canvas's URL is set per
 * environment; cross-origin credential flows (SSE cookies, Bearer
 * tokens) require an explicit origin match per the CORS spec.
 *
 * Use:
 *   const cors = applyCors(req, response)
 *   return cors  // already includes the request-specific headers
 *
 * Preflight (OPTIONS) requests get a dedicated 204 response.
 */

const HEADERS_ALLOWED =
	'authorization, content-type, traceparent, x-csrf-token, x-anthropic-api-key, x-e2b-api-key'
const METHODS_ALLOWED = 'GET, POST, PUT, DELETE, OPTIONS'
const MAX_AGE_SECONDS = 600

export interface CorsConfig {
	readonly allowedOrigins: readonly string[]
}

export function readCorsConfig(): CorsConfig {
	const raw = process.env['ALLOWED_ORIGINS'] ?? ''
	const allowedOrigins = raw
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.filter((s) => s !== '*') // never honor a wildcard
		.filter((s) => s !== 'null') // sandboxed iframes / file:// send Origin: null — never trust it
		.map(normalizeOrigin)
		.filter((s): s is string => s !== null)
	return { allowedOrigins }
}

/**
 * Validate and normalize a single origin entry. Returns null on reject.
 *
 *   - Must parse as a URL with http: or https: scheme.
 *   - http: only allowed for localhost / 127.0.0.1 (dev convenience).
 *   - Trailing slashes and paths are stripped — the Origin header in
 *     browsers never carries them, so a path-bearing entry would never
 *     match anyway and indicates operator confusion.
 */
function normalizeOrigin(raw: string): string | null {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return null
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
	if (url.protocol === 'http:') {
		const isLocal =
			url.hostname === 'localhost' ||
			url.hostname === '127.0.0.1' ||
			url.hostname === '::1'
		if (!isLocal) return null
	}
	// `${origin}` is hostname + port, no path, no trailing slash.
	return url.origin
}

/**
 * Build the Access-Control-* headers for a given request. Returns an
 * empty object when the request has no Origin header (same-origin) or
 * the Origin is not in the allowlist (the browser will block the
 * response — we do NOT silently allow).
 */
export function corsHeadersFor(
	req: Request,
	cfg: CorsConfig = readCorsConfig()
): Record<string, string> {
	const origin = req.headers.get('origin')
	// Always emit Vary: Origin on endpoints that vary by origin, even when
	// no other CORS headers fire. Without it, a shared cache can serve a
	// response cached for origin A back to origin B.
	if (!origin) return { vary: 'Origin' }
	if (!cfg.allowedOrigins.includes(origin)) return { vary: 'Origin' }
	return {
		'access-control-allow-origin': origin,
		'access-control-allow-credentials': 'true',
		vary: 'Origin',
	}
}

/** Preflight handler. Call before the main handler runs. Returns null on non-preflight. */
export function preflightResponse(req: Request, cfg?: CorsConfig): Response | null {
	if (req.method !== 'OPTIONS') return null
	const headers = corsHeadersFor(req, cfg)
	if (Object.keys(headers).length === 0) {
		// Unknown origin — return a generic 204 without CORS headers; the
		// browser will block the subsequent request.
		return new Response(null, { status: 204 })
	}
	return new Response(null, {
		status: 204,
		headers: {
			...headers,
			'access-control-allow-methods': METHODS_ALLOWED,
			'access-control-allow-headers': HEADERS_ALLOWED,
			'access-control-max-age': String(MAX_AGE_SECONDS),
		},
	})
}

/** Wrap an existing Response with CORS headers for the given request. */
export function withCorsHeaders(req: Request, res: Response): Response {
	const headers = corsHeadersFor(req)
	if (Object.keys(headers).length === 0) return res
	const merged = new Headers(res.headers)
	for (const [k, v] of Object.entries(headers)) merged.set(k, v)
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers: merged,
	})
}

/**
 * Same as `withCorsHeaders` but mutates the headers in place rather than
 * re-wrapping the response. Use for streaming responses (SSE) where
 * re-wrapping the body via `new Response(res.body, ...)` can detach
 * backpressure or abort linkage on some Node/undici versions.
 *
 * Note: Response.headers is read-only on standards-conformant runtimes;
 * we apply by constructing a new Response only if necessary. For SSE the
 * intended pattern is to set headers at construction time via a CORS-
 * aware ResponseInit. This helper is the safe-but-slower middle path.
 */
export function applyCorsHeadersStreaming(req: Request, res: Response): Response {
	// On undici (Vercel/Node) Headers IS mutable on the response object
	// instance, but the spec says it's not — try mutate, fall back to wrap.
	const cors = corsHeadersFor(req)
	if (Object.keys(cors).length === 0) return res
	try {
		for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
		return res
	} catch {
		return withCorsHeaders(req, res)
	}
}
