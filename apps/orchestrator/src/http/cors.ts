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
	'authorization, content-type, traceparent, x-csrf-token'
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
	return { allowedOrigins }
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
	if (!origin) return {}
	if (!cfg.allowedOrigins.includes(origin)) return {}
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
