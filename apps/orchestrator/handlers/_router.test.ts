import { describe, expect, it } from 'vitest'

import { matchRoute } from './_router.js'

/**
 * The production server (scripts/server.ts) and the local dev server both
 * dispatch through this one table, so a wrong match ships a 404 (or worse,
 * the wrong handler) to every client. These tests pin the exact mapping —
 * especially the ordering traps where a specific route must win over a
 * greedy regex that would otherwise swallow it.
 *
 * matchRoute is used instead of loadRoute so no handler module is imported
 * (importing them would init postgres / the vault without env vars).
 */

const id = (method: string, path: string): string | null => matchRoute(method, path)?.id ?? null

describe('matchRoute — happy-path resolution', () => {
	const cases: Array<[string, string, string]> = [
		['GET', '/api/health', 'health'],
		['POST', '/api/commands', 'commands'],
		['POST', '/api/auth/sse-token', 'auth/sse-token'],
		['GET', '/api/auth/config', 'auth/config'],
		['POST', '/api/auth/anon-session', 'auth/anon-session'],
		['GET', '/api/auth/login/github', 'auth/login/github'],
		['GET', '/api/auth/github/callback', 'auth/github/callback'],
		['GET', '/api/agents', 'agents/index'],
		['POST', '/api/agents', 'agents/index'],
		['POST', '/api/feedback', 'feedback'],
		['GET', '/api/tokens', 'tokens/index'],
		['DELETE', '/api/tokens/tok_123', 'tokens/[id]'],
		['GET', '/api/approvals', 'approvals/index'],
		['POST', '/api/approvals/apr_9', 'approvals/[id]'],
		['GET', '/api/sync/room-42', 'sync/[room]'],
		['GET', '/api/audit', 'audit/index'],
		['GET', '/api/workspaces', 'workspaces/index'],
		['POST', '/api/workspaces', 'workspaces/index'],
		['GET', '/api/workspaces/ws_1/members', 'workspaces/members'],
		['DELETE', '/api/workspaces/ws_1/members/usr_2', 'workspaces/members'],
		['POST', '/api/admin/webhooks/drain', 'admin/webhooks/drain'],
		['GET', '/api/cron/drain-webhooks', 'cron/drain-webhooks'],
		['GET', '/api/webhooks', 'webhooks/index'],
		['POST', '/api/webhooks', 'webhooks/index'],
		['DELETE', '/api/webhooks/whe_abc', 'webhooks/[id]'],
		['POST', '/api/webhooks/ingest/github', 'webhooks/ingest/[provider]'],
		['GET', '/api/oauth/github/start', 'oauth/[provider]/start'],
		['GET', '/api/oauth/github/callback', 'oauth/[provider]/callback'],
	]
	it.each(cases)('%s %s → %s', (method, path, expected) => {
		expect(id(method, path)).toBe(expected)
	})
})

describe('matchRoute — ordering traps (specific must beat greedy)', () => {
	it('routes /api/agents/runs to the runs handler, not agents/[id]', () => {
		expect(id('POST', '/api/agents/runs')).toBe('agents/runs')
	})
	it('routes /api/agents/probe-mcp to probe-mcp, not agents/[id]', () => {
		expect(id('POST', '/api/agents/probe-mcp')).toBe('agents/probe-mcp')
	})
	it('routes a bare agent id to agents/[id]', () => {
		expect(id('GET', '/api/agents/agt_xyz')).toBe('agents/[id]')
		expect(id('PATCH', '/api/agents/agt_xyz')).toBe('agents/[id]')
		expect(id('DELETE', '/api/agents/agt_xyz')).toBe('agents/[id]')
	})
	it('distinguishes outbound webhook mgmt from inbound ingest', () => {
		expect(id('DELETE', '/api/webhooks/whe_123')).toBe('webhooks/[id]')
		expect(id('POST', '/api/webhooks/ingest/linear')).toBe('webhooks/ingest/[provider]')
	})
	it('does not let ingest paths match the whe_ id route', () => {
		// /api/webhooks/ingest/x has no whe_ prefix, so DELETE there is unmatched
		expect(id('DELETE', '/api/webhooks/ingest/github')).toBeNull()
	})
})

describe('matchRoute — method gating', () => {
	it('rejects wrong methods on exact routes', () => {
		expect(id('DELETE', '/api/health')).toBeNull()
		expect(id('GET', '/api/commands')).toBeNull()
		expect(id('PUT', '/api/agents')).toBeNull()
	})
	it('rejects a POST to the DELETE-only webhook id route', () => {
		expect(id('POST', '/api/webhooks/whe_123')).toBeNull()
	})
})

describe('matchRoute — OPTIONS preflight', () => {
	it('matches the owning route for any method-gated path', () => {
		// opts bypasses the method check so the handler can answer the preflight
		expect(id('OPTIONS', '/api/commands')).toBe('commands')
		expect(id('OPTIONS', '/api/agents/agt_1')).toBe('agents/[id]')
		expect(id('OPTIONS', '/api/webhooks/ingest/github')).toBe('webhooks/ingest/[provider]')
	})
	it('still returns null for paths with no route at all', () => {
		expect(id('OPTIONS', '/api/nope')).toBeNull()
	})
})

describe('matchRoute — unknown paths', () => {
	it('returns null for unmatched paths', () => {
		expect(id('GET', '/api/does-not-exist')).toBeNull()
		expect(id('GET', '/')).toBeNull()
		expect(id('GET', '/api')).toBeNull()
		expect(id('GET', '/api/agents/runs/extra')).toBeNull()
	})
})
