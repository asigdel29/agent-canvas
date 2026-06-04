import { describe, expect, it, vi } from 'vitest'
import { AgentCanvasClient, ApiError } from './client.js'

function mockFetch(
	response: { status: number; body?: unknown; headers?: Record<string, string> }
): {
	fetch: typeof fetch
	calls: Array<{ url: string; method: string; auth: string; body: string }>
} {
	const calls: Array<{ url: string; method: string; auth: string; body: string }> = []
	const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers ?? {})
		calls.push({
			url: String(input),
			method: (init?.method ?? 'GET') as string,
			auth: headers.get('authorization') ?? '',
			body: typeof init?.body === 'string' ? init.body : '',
		})
		const respHeaders: Record<string, string> = {
			'content-type': 'application/json',
			...(response.headers ?? {}),
		}
		return new Response(
			response.body !== undefined ? JSON.stringify(response.body) : null,
			{ status: response.status, headers: respHeaders }
		)
	}) as unknown as typeof fetch
	return { fetch: fn, calls }
}

const BASE = 'https://orch.example.com'
const TOKEN = 'ack_test_token_abc'

describe('AgentCanvasClient.tokens', () => {
	it('list issues GET /api/tokens with Bearer auth and returns items', async () => {
		const { fetch, calls } = mockFetch({
			status: 200,
			body: { items: [{ id: 'tok_1', name: 'cli' }] },
		})
		const c = new AgentCanvasClient({ base_url: BASE, token: TOKEN, fetchImpl: fetch })
		const list = await c.tokens.list()
		expect(list).toHaveLength(1)
		expect(calls[0]!.url).toBe('https://orch.example.com/api/tokens')
		expect(calls[0]!.method).toBe('GET')
		expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`)
	})

	it('mint POSTs JSON body and returns the raw_token', async () => {
		const { fetch, calls } = mockFetch({
			status: 201,
			body: { record: { id: 'tok_1' }, raw_token: 'ack_new_secret' },
		})
		const c = new AgentCanvasClient({ base_url: BASE, token: TOKEN, fetchImpl: fetch })
		const issued = await c.tokens.mint({ name: 'cli', scope: 'read' })
		expect(issued.raw_token).toBe('ack_new_secret')
		expect(calls[0]!.method).toBe('POST')
		const body = JSON.parse(calls[0]!.body) as { name: string; scope: string }
		expect(body).toEqual({ name: 'cli', scope: 'read' })
	})

	it('revoke DELETEs and resolves on 204', async () => {
		const { fetch, calls } = mockFetch({ status: 204 })
		const c = new AgentCanvasClient({ base_url: BASE, token: TOKEN, fetchImpl: fetch })
		await c.tokens.revoke('tok_1')
		expect(calls[0]!.method).toBe('DELETE')
		expect(calls[0]!.url.endsWith('/api/tokens/tok_1')).toBe(true)
	})

	it('throws ApiError on non-2xx with parsed error body', async () => {
		const { fetch } = mockFetch({
			status: 403,
			body: { error: 'workspace_forbidden', detail: null },
		})
		const c = new AgentCanvasClient({ base_url: BASE, token: TOKEN, fetchImpl: fetch })
		await expect(c.tokens.list()).rejects.toMatchObject({
			name: 'ApiError',
			status: 403,
			code: 'workspace_forbidden',
		})
	})

	it('surfaces rate-limit headers on 429', async () => {
		const { fetch } = mockFetch({
			status: 429,
			body: { error: 'rate_limited' },
			headers: {
				'x-ratelimit-limit': '5',
				'x-ratelimit-remaining': '0',
				'x-ratelimit-reset': '1700000060',
				'retry-after': '30',
			},
		})
		const c = new AgentCanvasClient({ base_url: BASE, token: TOKEN, fetchImpl: fetch })
		try {
			await c.tokens.mint({ name: 'x', scope: 'read' })
			throw new Error('expected throw')
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError)
			const apiErr = err as ApiError
			expect(apiErr.status).toBe(429)
			expect(apiErr.rate_limit?.limit).toBe(5)
			expect(apiErr.rate_limit?.retry_after_sec).toBe(30)
		}
	})
})

describe('AgentCanvasClient.webhooks', () => {
	it('list returns items', async () => {
		const { fetch, calls } = mockFetch({
			status: 200,
			body: { items: [{ id: 'whe_1', url: 'https://api/h' }] },
		})
		const c = new AgentCanvasClient({ base_url: BASE, token: TOKEN, fetchImpl: fetch })
		const list = await c.webhooks.list()
		expect(list).toHaveLength(1)
		expect(calls[0]!.url).toBe(`${BASE}/api/webhooks`)
	})

	it('register POSTs and returns signing_secret', async () => {
		const { fetch } = mockFetch({
			status: 201,
			body: { record: { id: 'whe_1' }, signing_secret: 'deadbeef' },
		})
		const c = new AgentCanvasClient({ base_url: BASE, token: TOKEN, fetchImpl: fetch })
		const r = await c.webhooks.register({
			url: 'https://api/h',
			events: ['token.minted'],
		})
		expect(r.signing_secret).toBe('deadbeef')
	})
})

describe('AgentCanvasClient.audit', () => {
	it('query encodes params into the query string', async () => {
		const { fetch, calls } = mockFetch({ status: 200, body: { items: [] } })
		const c = new AgentCanvasClient({ base_url: BASE, token: TOKEN, fetchImpl: fetch })
		await c.audit.query({ workspace_id: 'ws_1', action: 'token.minted', limit: 50 })
		expect(calls[0]!.url).toContain('/api/audit?')
		expect(calls[0]!.url).toContain('workspace_id=ws_1')
		expect(calls[0]!.url).toContain(`action=${encodeURIComponent('token.minted')}`)
		expect(calls[0]!.url).toContain('limit=50')
	})
})

describe('AgentCanvasClient.runs', () => {
	it('start POSTs and returns run_id', async () => {
		const { fetch } = mockFetch({
			status: 202,
			body: { run_id: 'run_1', agent_id: 'agt_1', room_id: 'room_1' },
		})
		const c = new AgentCanvasClient({ base_url: BASE, token: TOKEN, fetchImpl: fetch })
		const r = await c.runs.start({
			agent_id: 'agt_1',
			room_id: 'room_1',
			initial_message: 'hi',
		})
		expect(r.run_id).toBe('run_1')
	})
})
