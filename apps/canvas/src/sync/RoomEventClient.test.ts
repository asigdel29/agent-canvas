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

function asyncFactory(token: string): () => Promise<string> {
	return async () => token
}

async function flushMicrotasks(): Promise<void> {
	// Advance timers + flush pending microtasks so the async connect()
	// finishes constructing the EventSource before the test inspects state.
	await vi.advanceTimersByTimeAsync(0)
	await Promise.resolve()
}

describe('RoomEventClient', () => {
	beforeEach(() => {
		FakeEventSource.reset()
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('appends the minted SSE token to the URL as a query param', async () => {
		const client = new RoomEventClient({
			url: 'http://localhost/api/sync/room_a',
			tokenFactory: asyncFactory('sse_token_xyz'),
			onEvent: () => {},
			eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
		})
		await flushMicrotasks()
		const opened = FakeEventSource.opened[0]
		expect(opened?.url).toContain('token=sse_token_xyz')
		client.close()
	})

	it('invokes onEvent for `event` messages', async () => {
		const seen: number[] = []
		const client = new RoomEventClient({
			url: 'http://localhost/api/sync/room_a',
			tokenFactory: asyncFactory('t'),
			onEvent: (e) => seen.push(e.seq),
			eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
		})
		await flushMicrotasks()
		const es = FakeEventSource.opened[0]!
		es.emit({ type: 'event', room_id: 'room_a', event: eventPayload(1) })
		es.emit({ type: 'event', room_id: 'room_a', event: eventPayload(2) })
		expect(seen).toEqual([1, 2])
		client.close()
	})

	it('invokes onHello on the hello message', async () => {
		const onHello = vi.fn()
		const client = new RoomEventClient({
			url: 'http://localhost/api/sync/room_a',
			tokenFactory: asyncFactory('t'),
			onEvent: () => {},
			onHello,
			eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
		})
		await flushMicrotasks()
		FakeEventSource.opened[0]!.emit({ type: 'hello', room_id: 'room_a', ts: '' })
		expect(onHello).toHaveBeenCalledTimes(1)
		client.close()
	})

	it('mints a FRESH token on each reconnect (tokens are single-use)', async () => {
		const tokens = ['tok_first', 'tok_second', 'tok_third']
		let i = 0
		const tokenFactory = async (): Promise<string> => tokens[i++] ?? 'tok_overflow'
		const client = new RoomEventClient({
			url: 'http://localhost/api/sync/room_a',
			tokenFactory,
			onEvent: () => {},
			eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
		})
		await flushMicrotasks()
		expect(FakeEventSource.opened[0]?.url).toContain('token=tok_first')

		FakeEventSource.opened[0]!.emit({ type: 'reconnect' })
		await vi.advanceTimersByTimeAsync(MIN_BACKOFF_MS_FOR_TEST)
		await Promise.resolve()
		expect(FakeEventSource.opened[1]?.url).toContain('token=tok_second')

		client.close()
	})

	it('reconnects when the server sends a reconnect message', async () => {
		const client = new RoomEventClient({
			url: 'http://localhost/api/sync/room_a',
			tokenFactory: asyncFactory('t'),
			onEvent: () => {},
			eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
		})
		await flushMicrotasks()
		FakeEventSource.opened[0]!.emit({ type: 'reconnect' })
		await vi.advanceTimersByTimeAsync(MIN_BACKOFF_MS_FOR_TEST)
		await Promise.resolve()
		expect(FakeEventSource.opened.length).toBe(2)
		expect(FakeEventSource.opened[0]!.closed).toBe(true)
		client.close()
	})

	it('reconnects with exponential backoff when errors arrive before open', async () => {
		// Without an open event between errors, backoff doubles. Use a
		// SilentOpenES variant that never fires `open` so we can verify
		// the escalation deterministically.
		class SilentOpenES extends FakeEventSource {}
		const origFire = (
			SilentOpenES.prototype as unknown as { fire: (t: string, e: Event) => void }
		).fire
		;(SilentOpenES.prototype as unknown as { fire: (t: string, e: Event) => void }).fire =
			function (this: SilentOpenES, type: string, e: Event) {
				if (type === 'open') return
				origFire.call(this, type, e)
			}

		const client = new RoomEventClient({
			url: 'http://localhost/api/sync/room_a',
			tokenFactory: asyncFactory('t'),
			onEvent: () => {},
			eventSourceFactory: (u) => new SilentOpenES(u) as unknown as EventSource,
		})
		await flushMicrotasks()

		FakeEventSource.opened.slice(-1)[0]!.emitTransportError()
		await vi.advanceTimersByTimeAsync(250)
		await Promise.resolve()
		expect(FakeEventSource.opened.length).toBe(2)

		FakeEventSource.opened.slice(-1)[0]!.emitTransportError()
		await vi.advanceTimersByTimeAsync(499)
		await Promise.resolve()
		expect(FakeEventSource.opened.length).toBe(2) // 500ms backoff hasn't elapsed
		await vi.advanceTimersByTimeAsync(1)
		await Promise.resolve()
		expect(FakeEventSource.opened.length).toBe(3)

		client.close()
	})

	it('close() stops further reconnect attempts', async () => {
		const client = new RoomEventClient({
			url: 'http://localhost/api/sync/room_a',
			tokenFactory: asyncFactory('t'),
			onEvent: () => {},
			eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
		})
		await flushMicrotasks()
		FakeEventSource.opened[0]!.emit({ type: 'reconnect' })
		client.close()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(FakeEventSource.opened.length).toBe(1)
	})

	it('survives malformed JSON without crashing', async () => {
		const onEvent = vi.fn()
		const client = new RoomEventClient({
			url: 'http://localhost/api/sync/room_a',
			tokenFactory: asyncFactory('t'),
			onEvent,
			eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
		})
		await flushMicrotasks()
		const es = FakeEventSource.opened[0]!
		for (const fn of (es as unknown as { listeners: Map<string, Set<(e: Event) => void>> })
			.listeners.get('message') ?? []) {
			fn(new MessageEvent('message', { data: 'not-json' }))
		}
		expect(onEvent).not.toHaveBeenCalled()
		client.close()
	})

	it('surfaces tokenFactory errors via onError and retries', async () => {
		const onError = vi.fn()
		let attempts = 0
		const tokenFactory = async (): Promise<string> => {
			attempts += 1
			if (attempts < 2) throw new Error('mint_failed')
			return 'tok_recovered'
		}
		const client = new RoomEventClient({
			url: 'http://localhost/api/sync/room_a',
			tokenFactory,
			onEvent: () => {},
			onError,
			eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
		})
		await flushMicrotasks()
		expect(onError).toHaveBeenCalledTimes(1)
		expect(FakeEventSource.opened.length).toBe(0) // first attempt didn't get an EventSource
		await vi.advanceTimersByTimeAsync(MIN_BACKOFF_MS_FOR_TEST)
		await Promise.resolve()
		expect(FakeEventSource.opened.length).toBe(1)
		expect(FakeEventSource.opened[0]?.url).toContain('token=tok_recovered')
		client.close()
	})
})

const MIN_BACKOFF_MS_FOR_TEST = 250
