/**
 * Single catch-all entrypoint for the orchestrator.
 *
 * Vercel's Hobby tier caps a deployment at 12 Serverless Functions; the
 * orchestrator has 29 logical routes. All /api/* requests land here and
 * are dispatched to the underlying handler via the shared route table in
 * handlers/_router.ts. Handlers are loaded lazily so that a request to
 * /api/health does not trigger module init for postgres/KMS/Stripe etc.
 */

import { loadRoute } from '../handlers/_router.js'

export default async function handler(req: Request): Promise<Response> {
	try {
		const url = new URL(req.url)
		const route = await loadRoute(req.method, url.pathname)
		if (route === null) {
			return new Response(JSON.stringify({ error: 'not_found', path: url.pathname }), {
				status: 404,
				headers: { 'content-type': 'application/json' },
			})
		}
		return await route(req)
	} catch (err) {
		const e = err as Error
		return new Response(
			JSON.stringify({
				error: 'dispatch_crashed',
				message: e?.message ?? String(err),
				stack: e?.stack?.split('\n').slice(0, 15) ?? null,
			}),
			{ status: 500, headers: { 'content-type': 'application/json' } }
		)
	}
}
