import { describe, expect, it, vi } from 'vitest'
import type { RoomId, RunEvent } from '@agent-canvas/orchestrator-types'
import { InMemoryRoomEventBus } from './roomEventBus.js'
import { openSseEndpoint } from './sseEndpoint.js'
import { openSseStream } from './sseStream.js'

const ROOM: RoomId = 'room_sse' as RoomId

function ev(seq: number): RunEvent {
	return {
		seq,
		run_id: 'run_s' as RunEvent['run_id'],
		kind: 'progress',
		ts: new Date().toISOString(),
		schema_version: 1,
		payload: {},
	}
}

async function collect(response: Response, ms: number): Promise<string> {
	const reader = response.body!.getReader()
	const decoder = new TextDecoder()
	let out = ''
	const start = Date.now()
	while (Date.now() - start < ms) {
		const r = await Promise.race([
			reader.read(),
			new Promise<{ done: true; value: undefined }>((resolve) =>
				setTimeout(() => resolve({ done: true, value: undefined }), ms - (Date.now() - start))
			),
		])
		if (r.done) break
		if (r.value) out += decoder.decode(r.value, { stream: true })
	}
	out += decoder.decode()
	return out
}

describe('openSseEndpoint', () => {
	it('sends a hello message and forwards bus events', async () => {
		const bus = new InMemoryRoomEventBus()
		const sender = openSseStream({ keepAliveMs: 60_000 })
		const ep = openSseEndpoint({ room_id: ROOM, bus, sender, maxAgeMs: 60_000 })
		bus.publish(ROOM, ev(1))
		bus.publish(ROOM, ev(2))
		ep.close()
		const body = await collect(ep.response, 100)
		expect(body).toContain('"type":"hello"')
		expect(body).toContain('"seq":1')
		expect(body).toContain('"seq":2')
	})

	it('does not forward events from other rooms', async () => {
		const bus = new InMemoryRoomEventBus()
		const other: RoomId = 'room_other' as RoomId
		const sender = openSseStream({ keepAliveMs: 60_000 })
		const ep = openSseEndpoint({ room_id: ROOM, bus, sender, maxAgeMs: 60_000 })
		bus.publish(other, ev(1))
		bus.publish(ROOM, ev(2))
		ep.close()
		const body = await collect(ep.response, 100)
		expect(body).toContain('"seq":2')
		expect(body).not.toContain('"seq":1')
	})

	it('emits a reconnect hint when the max-age timeout fires', async () => {
		const bus = new InMemoryRoomEventBus()
		const sender = openSseStream({ keepAliveMs: 60_000 })
		openSseEndpoint({ room_id: ROOM, bus, sender, maxAgeMs: 25 })
		await new Promise((resolve) => setTimeout(resolve, 60))
		const body = await collect(sender.response, 50)
		expect(body).toContain('"type":"reconnect"')
	})

	it('disposes the bus subscription on close()', async () => {
		const bus = new InMemoryRoomEventBus()
		const sender = openSseStream({ keepAliveMs: 60_000 })
		const ep = openSseEndpoint({ room_id: ROOM, bus, sender, maxAgeMs: 60_000 })
		expect(bus.subscriberCount(ROOM)).toBe(1)
		ep.close()
		expect(bus.subscriberCount(ROOM)).toBe(0)
	})

	it('aborts cleanly when the AbortSignal fires', async () => {
		const bus = new InMemoryRoomEventBus()
		const sender = openSseStream({ keepAliveMs: 60_000 })
		const ctrl = new AbortController()
		openSseEndpoint({
			room_id: ROOM,
			bus,
			sender,
			maxAgeMs: 60_000,
			abortSignal: ctrl.signal,
		})
		expect(bus.subscriberCount(ROOM)).toBe(1)
		ctrl.abort()
		expect(bus.subscriberCount(ROOM)).toBe(0)
	})

	it('does not echo bus events delivered after close()', async () => {
		const bus = new InMemoryRoomEventBus()
		const sender = openSseStream({ keepAliveMs: 60_000 })
		const ep = openSseEndpoint({ room_id: ROOM, bus, sender, maxAgeMs: 60_000 })
		const spy = vi.spyOn(sender, 'send')
		ep.close()
		bus.publish(ROOM, ev(99))
		// hello + (close ran; subsequent publishes do not reach the closed sender)
		expect(spy.mock.calls.some(([arg]) => JSON.stringify(arg).includes('99'))).toBe(false)
	})
})
