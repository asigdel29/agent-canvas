/**
 * Shared route table for the orchestrator's HTTP surface.
 *
 * The same matching logic runs in two places:
 *   - apps/orchestrator/api/dispatch.ts        (Vercel production catch-all)
 *   - apps/orchestrator/scripts/dev-server.ts  (local Node HTTP server)
 *
 * A single catch-all is used in production to fit inside Vercel's Hobby
 * 12-function ceiling: every /api/* request enters one Serverless Function
 * which then dispatches to the underlying handler module by path + method.
 *
 * Handlers are imported lazily — eagerly importing all 29 would force
 * module init for postgres, KMS, Stripe, etc. at function cold start,
 * which hangs (and times out) when the corresponding env vars are absent.
 *
 * Matching is kept separate from loading (`matchRoute` vs `loadRoute`) so
 * the route table can be unit-tested without triggering those lazy imports.
 */

export type Handler = (req: Request) => Promise<Response>
type Loader = () => Promise<{ default: Handler }>

interface Route {
	/** Stable identifier — the handler module path. Lets tests assert which
	 *  route a method+path resolves to without importing the handler. */
	id: string
	match: (method: string, pathname: string, opts: boolean) => boolean
	load: Loader
}

const exact = (path: string, methods: string[]): Route['match'] => {
	return (method, pathname, opts) =>
		pathname === path && (methods.includes(method) || opts)
}
const rx = (re: RegExp, methods: string[]): Route['match'] => {
	return (method, pathname, opts) =>
		re.test(pathname) && (methods.includes(method) || opts)
}

const routes: Route[] = [
	{ id: 'health', match: exact('/api/health', ['GET']), load: () => import('./health.js') },
	{ id: 'commands', match: exact('/api/commands', ['POST']), load: () => import('./commands.js') },
	{
		id: 'auth/sse-token',
		match: exact('/api/auth/sse-token', ['POST']),
		load: () => import('./auth/sse-token.js'),
	},
	{
		id: 'auth/login/github',
		match: exact('/api/auth/login/github', ['GET']),
		load: () => import('./auth/login/github.js'),
	},
	{
		id: 'auth/github/callback',
		match: exact('/api/auth/github/callback', ['GET']),
		load: () => import('./auth/github/callback.js'),
	},
	{
		id: 'agents/index',
		match: exact('/api/agents', ['GET', 'POST']),
		load: () => import('./agents/index.js'),
	},
	{
		id: 'agents/runs',
		match: exact('/api/agents/runs', ['POST']),
		load: () => import('./agents/runs.js'),
	},
	{
		id: 'agents/probe-mcp',
		match: exact('/api/agents/probe-mcp', ['POST']),
		load: () => import('./agents/probe-mcp.js'),
	},
	{ id: 'feedback', match: exact('/api/feedback', ['POST']), load: () => import('./feedback.js') },
	{
		id: 'tokens/index',
		match: exact('/api/tokens', ['GET', 'POST']),
		load: () => import('./tokens/index.js'),
	},
	{
		id: 'tokens/[id]',
		match: rx(/^\/api\/tokens\/[^/]+$/, ['DELETE']),
		load: () => import('./tokens/[id].js'),
	},
	{
		id: 'agents/[id]',
		match: rx(/^\/api\/agents\/[^/]+$/, ['GET', 'PATCH', 'DELETE']),
		load: () => import('./agents/[id].js'),
	},
	{
		id: 'approvals/index',
		match: exact('/api/approvals', ['GET']),
		load: () => import('./approvals/index.js'),
	},
	{
		id: 'approvals/[id]',
		match: rx(/^\/api\/approvals\/[^/]+$/, ['POST']),
		load: () => import('./approvals/[id].js'),
	},
	{
		id: 'sync/[room]',
		match: (method, pathname, opts) =>
			pathname.startsWith('/api/sync/') && (method === 'GET' || opts),
		load: () => import('./sync/[room].js'),
	},
	{ id: 'audit/index', match: exact('/api/audit', ['GET']), load: () => import('./audit/index.js') },
	{
		id: 'workspaces/index',
		match: exact('/api/workspaces', ['GET', 'POST']),
		load: () => import('./workspaces/index.js'),
	},
	{
		id: 'workspaces/members',
		match: rx(/^\/api\/workspaces\/[^/]+\/members(?:\/[^/]+)?$/, ['GET', 'POST', 'PATCH', 'DELETE']),
		load: () => import('./workspaces/members.js'),
	},
	{
		id: 'admin/webhooks/drain',
		match: exact('/api/admin/webhooks/drain', ['POST']),
		load: () => import('./admin/webhooks/drain.js'),
	},
	{
		id: 'cron/drain-webhooks',
		match: exact('/api/cron/drain-webhooks', ['GET']),
		load: () => import('./cron/drain-webhooks.js'),
	},
	// Outbound webhook management — list / register / revoke. Matched BEFORE
	// the inbound ingest route so GET/POST/DELETE on /api/webhooks(...) reach
	// the management handlers; inbound deliveries use /api/webhooks/ingest/:provider.
	{
		id: 'webhooks/index',
		match: exact('/api/webhooks', ['GET', 'POST']),
		load: () => import('./webhooks/index.js'),
	},
	{
		id: 'webhooks/[id]',
		match: rx(/^\/api\/webhooks\/whe_[^/]+$/, ['DELETE']),
		load: () => import('./webhooks/[id].js'),
	},
	{
		id: 'webhooks/ingest/[provider]',
		match: rx(/^\/api\/webhooks\/ingest\/[^/]+$/, ['POST']),
		load: () => import('./webhooks/ingest/[provider].js'),
	},
	{
		id: 'oauth/[provider]/start',
		match: rx(/^\/api\/oauth\/[^/]+\/start$/, ['GET']),
		load: () => import('./oauth/[provider]/start.js'),
	},
	{
		id: 'oauth/[provider]/callback',
		match: rx(/^\/api\/oauth\/[^/]+\/callback$/, ['GET']),
		load: () => import('./oauth/[provider]/callback.js'),
	},
]

/**
 * Resolve a method + path to a route without loading the handler module.
 * Returns the matched route (whose `id` identifies the handler) or null.
 * Pure and import-free, so it is safe to exercise in unit tests.
 */
export function matchRoute(method: string, pathname: string): Route | null {
	const opts = method === 'OPTIONS'
	for (const r of routes) {
		if (r.match(method, pathname, opts)) return r
	}
	return null
}

export async function loadRoute(method: string, pathname: string): Promise<Handler | null> {
	const route = matchRoute(method, pathname)
	if (route === null) return null
	const mod = await route.load()
	return mod.default
}
