/**
 * RoomEventClient — connects to the orchestrator's /api/sync/:room SSE
 * stream and surfaces typed events to the canvas.
 *
 * The client auto-reconnects on the orchestrator's `reconnect` hint
 * (sent before the function timeout) and on transport errors with a
 * backoff capped at 30 s. Disposal stops both the EventSource and any
 * pending reconnect timer.
 *
 * Authentication: each connect mints a FRESH single-use 60-second SSE
 * token via the supplied `tokenFactory`. The factory typically POSTs
 * to /api/auth/sse-token with the session bearer; the token returned
 * gets appended to the SSE URL as `?token=`. URL-borne tokens leak via
 * logs/Referer; the short TTL collapses the exposure window to seconds
 * and replay is server-rejected.
 *
 * Reconnect budget: `maxConsecutiveFailures` caps how many failed
 * attempts in a row the client will tolerate before giving up and
 * calling `onGiveUp`. A successful open resets the counter to zero.
 * Defaults to `Infinity` — the historical retry-forever behavior — but
 * production canvases should set a finite cap (e.g. 20 attempts ≈ 10
 * minutes at 30 s max backoff) so a phone left on a dead network
 * eventually stops draining battery.
 */

export type RoomEventClientMessage =
	| { type: 'hello'; room_id: string; ts: string }
	| { type: 'event'; room_id: string; event: RunEventPayload }
	| { type: 'reconnect' }

export interface RunEventPayload {
	seq: number
	run_id: string
	kind: string
	ts: string
	schema_version: number
	payload: Record<string, unknown>
	provider_event_id?: string
	vendor?: string
}

export interface RoomEventClientOptions {
	readonly url: string
	/**
	 * Mints an ephemeral SSE token. Called on every connect — tokens are
	 * single-use and 60-second TTL, so reconnect needs a fresh one.
	 */
	readonly tokenFactory: () => Promise<string>
	readonly onEvent: (event: RunEventPayload) => void
	readonly onHello?: () => void
	readonly onError?: (err: Event | Error) => void
	/**
	 * Cap on consecutive failed connect attempts before giving up.
	 * Counts a failure on either: (a) `tokenFactory` throws, or
	 * (b) the EventSource fires `error` before `open`. A successful
	 * `open` resets the counter to zero. Default: `Infinity`.
	 */
	readonly maxConsecutiveFailures?: number
	/**
	 * Fired once when the failure counter reaches `maxConsecutiveFailures`.
	 * After this fires the client transitions to a closed state and will
	 * not attempt any further reconnects — the caller must construct a
	 * fresh client (e.g. after a user-initiated retry).
	 */
	readonly onGiveUp?: (reason: { attempts: number; lastError: Error | Event }) => void
	/** Used by tests to inject a fake EventSource implementation. */
	readonly eventSourceFactory?: (url: string) => EventSource
}

type EventSourceLike = EventSource

const MIN_BACKOFF_MS = 250
const MAX_BACKOFF_MS = 30_000

export class RoomEventClient {
	private es: EventSourceLike | null = null
	private backoffMs = MIN_BACKOFF_MS
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null
	private closed = false
	private consecutiveFailures = 0
	private lastError: Error | Event | null = null
	private gaveUp = false

	constructor(private readonly opts: RoomEventClientOptions) {
		void this.connect()
	}

	close(): void {
		this.closed = true
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		this.es?.close()
		this.es = null
	}

	private async connect(): Promise<void> {
		if (this.closed) return
		let token: string
		try {
			token = await this.opts.tokenFactory()
		} catch (err) {
			const wrapped = err instanceof Error ? err : new Error('token_factory_failed')
			this.lastError = wrapped
			this.opts.onError?.(wrapped)
			this.recordFailureAndMaybeReconnect()
			return
		}
		if (this.closed) return
		const u = new URL(this.opts.url)
		u.searchParams.set('token', token)
		const factory = this.opts.eventSourceFactory ?? ((url: string) => new EventSource(url))
		this.es = factory(u.toString())
		this.es.addEventListener('message', (raw) => this.handleMessage(raw))
		this.es.addEventListener('error', (err) => this.handleTransportError(err))
		this.es.addEventListener('open', () => {
			this.backoffMs = MIN_BACKOFF_MS
			this.consecutiveFailures = 0
			this.lastError = null
		})
	}

	private handleMessage(raw: MessageEvent): void {
		let msg: RoomEventClientMessage
		try {
			msg = JSON.parse(raw.data) as RoomEventClientMessage
		} catch {
			return
		}
		switch (msg.type) {
			case 'hello':
				this.opts.onHello?.()
				break
			case 'event':
				this.opts.onEvent(msg.event)
				break
			case 'reconnect':
				// Server-initiated reconnect is NOT a failure — the orchestrator
				// closes the stream before its function timeout. Do not bump
				// the failure counter; just schedule the next connect.
				this.es?.close()
				this.es = null
				if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
				this.reconnectTimer = setTimeout(() => {
					this.reconnectTimer = null
					void this.connect()
				}, this.backoffMs)
				this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
				break
		}
	}

	private handleTransportError(err: Event): void {
		this.lastError = err
		this.opts.onError?.(err)
		this.recordFailureAndMaybeReconnect()
	}

	/**
	 * Bump the consecutive-failure counter, then either schedule the
	 * next reconnect attempt or, if the cap is hit, call `onGiveUp` and
	 * lock the client into the closed state.
	 */
	private recordFailureAndMaybeReconnect(): void {
		if (this.closed) return
		this.es?.close()
		this.es = null
		this.consecutiveFailures += 1
		const max = this.opts.maxConsecutiveFailures ?? Infinity
		if (this.consecutiveFailures >= max && !this.gaveUp) {
			this.gaveUp = true
			this.closed = true
			if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
			const last = this.lastError ?? new Error('unknown_failure')
			this.opts.onGiveUp?.({ attempts: this.consecutiveFailures, lastError: last })
			return
		}
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			void this.connect()
		}, this.backoffMs)
		this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
	}
}
