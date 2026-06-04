/**
 * config.ts — runtime configuration resolved once for the canvas client.
 *
 * The orchestrator base URL is resolved in priority order:
 *
 *   1. VITE_ORCHESTRATOR_URL, when the build sets it. The dev build
 *      (apps/canvas/.env.development) points this at the local
 *      orchestrator on :3000 so the Vite dev server on :5173 can reach
 *      it cross-origin.
 *   2. window.location.origin — the same-origin default. The production
 *      build ships with no VITE_ORCHESTRATOR_URL, so the canvas talks to
 *      `/api/*` on whatever origin served it. This is what makes the
 *      single-service deploy work with zero configuration and no CORS.
 *   3. http://localhost:3000 — a last-resort fallback for non-browser
 *      contexts (tests, SSR) where `window` is absent.
 *
 * @author asigdel29
 */

/**
 * Resolve the orchestrator base URL for this session.
 *
 * @returns an absolute origin (no trailing slash) suitable for both
 *   `fetch(`${base}/api/...`)` and `new URL(`${base}/api/...`)`.
 */
function resolveOrchestratorUrl(): string {
	const env = (import.meta as unknown as { env?: Record<string, string> }).env?.[
		'VITE_ORCHESTRATOR_URL'
	]
	if (env) return env
	if (typeof window !== 'undefined' && window.location?.origin) {
		return window.location.origin
	}
	return 'http://localhost:3000'
}

/** The orchestrator base URL the canvas issues API and SSE requests against. */
export const ORCHESTRATOR_URL = resolveOrchestratorUrl()
