/**
 * Tests for RoomEventClient.
 *
 * @author asigdel29
 */

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

	describe('maxConsecutiveFailures + onGiveUp', () => {
		it('calls onGiveUp once after N consecutive transport errors and stops reconnecting', async () => {
			const onGiveUp = vi.fn()
			// Use SilentOpenES so transport errors are not interleaved with
			// successful opens that would reset the counter.
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
				maxConsecutiveFailures: 3,
				onGiveUp,
				eventSourceFactory: (u) => new SilentOpenES(u) as unknown as EventSource,
			})
			await flushMicrotasks()

			// Fire 3 transport errors. After the 3rd, onGiveUp must fire and
			// no further EventSource should be constructed.
			FakeEventSource.opened.slice(-1)[0]!.emitTransportError() // 1st failure
			await vi.advanceTimersByTimeAsync(250)
			await Promise.resolve()
			FakeEventSource.opened.slice(-1)[0]!.emitTransportError() // 2nd failure
			await vi.advanceTimersByTimeAsync(500)
			await Promise.resolve()
			expect(onGiveUp).not.toHaveBeenCalled() // still under cap
			FakeEventSource.opened.slice(-1)[0]!.emitTransportError() // 3rd failure — cap hit

			expect(onGiveUp).toHaveBeenCalledTimes(1)
			expect(onGiveUp.mock.calls[0]![0].attempts).toBe(3)

			// Further time advancement must NOT create a new EventSource.
			const beforeCount = FakeEventSource.opened.length
			await vi.advanceTimersByTimeAsync(30_000)
			await Promise.resolve()
			expect(FakeEventSource.opened.length).toBe(beforeCount)
		})

		it('successful open resets the consecutive-failure counter', async () => {
			const onGiveUp = vi.fn()
			// Mixed-mode ES: open fires only on every OTHER instance, so we
			// alternate failure-success-failure-... without ever hitting the cap.
			let constructed = 0
			class ToggleES extends FakeEventSource {
				constructor(url: string) {
					super(url)
					constructed += 1
				}
			}
			const origFire = (
				ToggleES.prototype as unknown as { fire: (t: string, e: Event) => void }
			).fire
			;(ToggleES.prototype as unknown as { fire: (t: string, e: Event) => void }).fire =
				function (this: ToggleES, type: string, e: Event) {
					// Suppress open on every other ES so failures don't get reset.
					if (type === 'open' && constructed % 2 === 1) return
					origFire.call(this, type, e)
				}

			const client = new RoomEventClient({
				url: 'http://localhost/api/sync/room_a',
				tokenFactory: asyncFactory('t'),
				onEvent: () => {},
				maxConsecutiveFailures: 3,
				onGiveUp,
				eventSourceFactory: (u) => new ToggleES(u) as unknown as EventSource,
			})
			await flushMicrotasks()

			// ES #1 (no open) → error → counter=1
			FakeEventSource.opened.slice(-1)[0]!.emitTransportError()
			await vi.advanceTimersByTimeAsync(250)
			await Promise.resolve()
			// ES #2 (open fires) → counter reset to 0 via open handler
			// ES #2 then error → counter=1
			FakeEventSource.opened.slice(-1)[0]!.emitTransportError()
			await vi.advanceTimersByTimeAsync(500)
			await Promise.resolve()
			// ES #3 (no open) → error → counter=2
			FakeEventSource.opened.slice(-1)[0]!.emitTransportError()
			await vi.advanceTimersByTimeAsync(1000)
			await Promise.resolve()
			// ES #4 (open fires) → counter reset to 0

			// Despite 3 transport errors over the run, onGiveUp must NOT fire
			// because the counter was reset between failures by successful opens.
			expect(onGiveUp).not.toHaveBeenCalled()
			client.close()
		})

		it('server-initiated reconnect does NOT count as a failure', async () => {
			const onGiveUp = vi.fn()
			const client = new RoomEventClient({
				url: 'http://localhost/api/sync/room_a',
				tokenFactory: asyncFactory('t'),
				onEvent: () => {},
				maxConsecutiveFailures: 3,
				onGiveUp,
				eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
			})
			await flushMicrotasks()

			// Fire 5 server-initiated reconnects with no transport errors.
			// Even with cap=3, onGiveUp must never fire — these are normal.
			for (let i = 0; i < 5; i++) {
				FakeEventSource.opened.slice(-1)[0]!.emit({ type: 'reconnect' })
				await vi.advanceTimersByTimeAsync(30_000) // backoff long since maxed
				await Promise.resolve()
			}

			expect(onGiveUp).not.toHaveBeenCalled()
			expect(FakeEventSource.opened.length).toBeGreaterThanOrEqual(5)
			client.close()
		})

		it('tokenFactory failures count against the cap (network down counts)', async () => {
			const onGiveUp = vi.fn()
			const tokenFactory = async (): Promise<string> => {
				throw new Error('network_down')
			}
			new RoomEventClient({
				url: 'http://localhost/api/sync/room_a',
				tokenFactory,
				onEvent: () => {},
				maxConsecutiveFailures: 2,
				onGiveUp,
				eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
			})
			await flushMicrotasks() // first failure
			await vi.advanceTimersByTimeAsync(250)
			await flushMicrotasks() // second failure → cap hit
			expect(onGiveUp).toHaveBeenCalledTimes(1)
			expect(onGiveUp.mock.calls[0]![0].lastError.message).toBe('network_down')
		})

		it('default (no maxConsecutiveFailures) preserves retry-forever behavior', async () => {
			const onGiveUp = vi.fn()
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
				onGiveUp, // provided but no cap — must never fire
				eventSourceFactory: (u) => new SilentOpenES(u) as unknown as EventSource,
			})
			await flushMicrotasks()

			for (let i = 0; i < 50; i++) {
				FakeEventSource.opened.slice(-1)[0]!.emitTransportError()
				await vi.advanceTimersByTimeAsync(30_000)
				await Promise.resolve()
			}
			expect(onGiveUp).not.toHaveBeenCalled()
			expect(FakeEventSource.opened.length).toBeGreaterThan(40)
			client.close()
		})
	})
})

const MIN_BACKOFF_MS_FOR_TEST = 250
