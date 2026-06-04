/**
 * requestLog — wraps a Vercel-style fetch handler with structured
 * request/response logging. One log line per request with method,
 * path, status, latency, and the user id when a session was
 * extracted by the route.
 *
 * Use:
 *
 *   export default withRequestLog('agents-runs', handler)
 *
 * On 5xx or thrown errors the wrapper bumps to `error` level and
 * the configured Sentry hook fires (when SENTRY_DSN is set). 4xx
 * stays at `warn` because client-side mistakes are not operator
 * incidents.
 *
 * Latency is wall-clock from handler entry to response resolution.
 * Cold start is implicit (the first request after deploy pays it).
 * @author asigdel29
 */

import { logger } from './logger.js'

export type FetchHandler = (req: Request) => Promise<Response>

export interface WithRequestLogOptions {
	/** Stable name for this route — surfaces in every log line. */
	readonly route: string
}

export function withRequestLog(
	options: WithRequestLogOptions | string,
	handler: FetchHandler
): FetchHandler {
	const route = typeof options === 'string' ? options : options.route
	return async (req: Request) => {
		const start = performance.now()
		const url = new URL(req.url)
		const baseAttrs = {
			route,
			method: req.method,
			path: url.pathname,
			origin: req.headers.get('origin') ?? null,
		}
		try {
			const res = await handler(req)
			const latency_ms = Math.round(performance.now() - start)
			const level = res.status >= 500 ? 'error' : res.status >= 400 ? 'warn' : 'info'
			logger[level]('http_request', {
				...baseAttrs,
				status: res.status,
				latency_ms,
			})
			return res
		} catch (err) {
			const latency_ms = Math.round(performance.now() - start)
			logger.error('http_request_failed', {
				...baseAttrs,
				latency_ms,
				err,
			})
			// Re-throw so the platform's default 500 surface still triggers.
			throw err
		}
	}
}
