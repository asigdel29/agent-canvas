import { describe, expect, it } from 'vitest'
import { openSseStream } from './sseStream.js'

async function readAllChunks(response: Response): Promise<string> {
	const reader = response.body!.getReader()
	const decoder = new TextDecoder()
	let out = ''
	for (;;) {
		const { value, done } = await reader.read()
		if (done) break
		out += decoder.decode(value, { stream: true })
	}
	out += decoder.decode()
	return out
}

describe('openSseStream', () => {
	it('emits a data event for each send() in SSE format', async () => {
		const sse = openSseStream({ keepAliveMs: 60_000 })
		sse.send({ kind: 'progress', seq: 1 })
		sse.send({ kind: 'succeeded', seq: 2 })
		sse.close()
		const body = await readAllChunks(sse.response)
		expect(body).toContain('data: {"kind":"progress","seq":1}\n\n')
		expect(body).toContain('data: {"kind":"succeeded","seq":2}\n\n')
	})

	it('sets the SSE content-type and disables buffering', () => {
		const sse = openSseStream({ keepAliveMs: 60_000 })
		expect(sse.response.headers.get('content-type')).toBe('text/event-stream')
		expect(sse.response.headers.get('cache-control')).toMatch(/no-cache/)
		expect(sse.response.headers.get('x-accel-buffering')).toBe('no')
		sse.close()
	})

	it('close() is idempotent', async () => {
		const sse = openSseStream({ keepAliveMs: 60_000 })
		sse.send({ a: 1 })
		sse.close()
		sse.close() // second close should not throw
		expect(sse.closed).toBe(true)
	})

	it('send() after close() is a no-op (no throw)', async () => {
		const sse = openSseStream({ keepAliveMs: 60_000 })
		sse.close()
		expect(() => sse.send({ a: 1 })).not.toThrow()
	})

	it('emits a keep-alive comment on the configured interval', async () => {
		const sse = openSseStream({ keepAliveMs: 10 })
		await new Promise((resolve) => setTimeout(resolve, 35))
		sse.close()
		const body = await readAllChunks(sse.response)
		const keepAliveCount = (body.match(/: keep-alive\n\n/g) ?? []).length
		expect(keepAliveCount).toBeGreaterThanOrEqual(2)
	})
})
