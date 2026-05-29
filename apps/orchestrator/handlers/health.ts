/**
 * GET /api/health — liveness + readiness probe.
 *
 * Returns 200 with a small JSON body the moment the function is
 * reachable. Vercel's platform uses this for its built-in checks; the
 * monitoring stack can use it for synthetic uptime probes.
 */

export default async function handler(_req: Request): Promise<Response> {
	return new Response(
		JSON.stringify({ status: 'ok', service: 'agent-canvas-orchestrator', ts: new Date().toISOString() }),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	)
}
