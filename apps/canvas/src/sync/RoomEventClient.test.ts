import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	RoomEventClient,
	type RoomEventClientMessage,
	type RunEventPayload,
} from './RoomEventClient.js'

/**
 * Hand-rolled EventSource stub. Only implements the parts of the
 * interface the client actually uses (open/message/error events,
 * close()).
 */
class FakeEventSource {
	readonly url: string
	readyState = 0
	private readonly listeners = new Map<string, Set<(e: MessageEvent | Event) => void>>()
	closed = false

	constructor(url: string) {
		this.url = url
		FakeEventSource.opened.push(this)
		queueMicrotask(() => this.fire('open', new Event('open')))
	}

	addEventListener(type: string, fn: (e: MessageEvent | Event) => void): void {
		let set = this.listeners.get(type)
		if (!set) {
			set = new Set()
			this.listeners.set(type, set)
		}
		set.add(fn)
	}

	close(): void {
		this.closed = true
	}

	emit(data: RoomEventClientMessage): void {
		this.fire('message', new MessageEvent('message', { data: JSON.stringify(data) }))
	}

	emitTransportError(): void {
		this.fire('error', new Event('error'))
	}

	private fire(type: string, e: MessageEvent | Event): void {
		for (const fn of this.listeners.get(type) ?? []) fn(e)
	}

	static opened: FakeEventSource[] = []
	static reset(): void {
		FakeEventSource.opened = []
	}
}

function eventPayload(seq: number): RunEventPayload {
	return {
		seq,
		run_id: 'run_x',
		kind: 'progress',
		ts: new Date().toISOString(),
		schema_version: 1,
		payload: {},
	}
}

describe('RoomEventClient', () => {
	beforeEach(() => {
		FakeEventSource.reset()
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('appends the token to the URL as a query param', () => {
		const client = new RoomEventClient({
			url: 'http://localhost/api/sync/room_a',
			token: 'jwt_xyz',
			onEvent: () => {},
			eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
		})
		const opened = FakeEventSource.opened[0]
		expect(opened?.url).toContain('token=jwt_xyz')
		client.close()
	})

	it('invokes onEvent for `event` messages', () => {
		const seen: number[] = []
		const client = new RoomEventClient({
			url: 'http://localhost/api/sync/room_a',
			token: 't',
			onEvent: (e) => seen.push(e.seq),
			eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
		})
		const es = FakeEventSource.opened[0]!
		es.emit({ type: 'event', room_id: 'room_a', event: eventPayload(1) })
		es.emit({ type: 'event', room_id: 'room_a', event: eventPayload(2) })
		expect(seen).toEqual([1, 2])
		client.close()
	})

	it('invokes onHello on the hello message', () => {
		const onHello = vi.fn()
		const client = new RoomEventClient({
			url: 'http://localhost/api/sync/room_a',
			token: 't',
			onEvent: () => {},
			onHello,
			eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
		})
		FakeEventSource.opened[0]!.emit({ type: 'hello', room_id: 'room_a', ts: '' })
		expect(onHello).toHaveBeenCalledTimes(1)
		client.close()
	})

	it('reconnects when the server sends a reconnect message', () => {
		const client = new RoomEventClient({
			url: 'http://localhost/api/sync/room_a',
			token: 't',
			onEvent: () => {},
			eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
		})
		FakeEventSource.opened[0]!.emit({ type: 'reconnect' })
		vi.advanceTimersByTime(MIN_BACKOFF_MS_FOR_TEST)
		expect(FakeEventSource.opened.length).toBe(2)
		expect(FakeEventSource.opened[0]!.closed).toBe(true)
		client.close()
	})

	it('reconnects with exponential backoff after transport errors', () => {
		const client = new RoomEventClient({
			url: 'http://localhost/api/sync/room_a',
			token: 't',
			onEvent: () => {},
			eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
		})

		const transportError = (): void => FakeEventSource.opened.slice(-1)[0]!.emitTransportError()

		transportError()
		vi.advanceTimersByTime(250)
		expect(FakeEventSource.opened.length).toBe(2)

		transportError()
		vi.advanceTimersByTime(499)
		expect(FakeEventSource.opened.length).toBe(2) // backoff hasn't elapsed
		vi.advanceTimersByTime(1)
		expect(FakeEventSource.opened.length).toBe(3)

		client.close()
	})

	it('close() stops further reconnect attempts', () => {
		const client = new RoomEventClient({
			url: 'http://localhost/api/sync/room_a',
			token: 't',
			onEvent: () => {},
			eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
		})
		FakeEventSource.opened[0]!.emit({ type: 'reconnect' })
		client.close()
		vi.advanceTimersByTime(10_000)
		expect(FakeEventSource.opened.length).toBe(1)
	})

	it('survives malformed JSON without crashing', () => {
		const onEvent = vi.fn()
		const client = new RoomEventClient({
			url: 'http://localhost/api/sync/room_a',
			token: 't',
			onEvent,
			eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
		})
		const es = FakeEventSource.opened[0]!
		// Directly fire a `message` with non-JSON data; the parse should
		// catch and drop the message silently.
		for (const fn of (es as unknown as { listeners: Map<string, Set<(e: Event) => void>> })
			.listeners.get('message') ?? []) {
			fn(new MessageEvent('message', { data: 'not-json' }))
		}
		expect(onEvent).not.toHaveBeenCalled()
		client.close()
	})
})

const MIN_BACKOFF_MS_FOR_TEST = 250
