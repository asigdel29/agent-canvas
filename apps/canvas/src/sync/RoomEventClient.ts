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
			this.opts.onError?.(err instanceof Error ? err : new Error('token_factory_failed'))
			this.scheduleReconnect()
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
				this.scheduleReconnect()
				break
		}
	}

	private handleTransportError(err: Event): void {
		this.opts.onError?.(err)
		this.scheduleReconnect()
	}

	private scheduleReconnect(): void {
		if (this.closed) return
		this.es?.close()
		this.es = null
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			void this.connect()
		}, this.backoffMs)
		this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
	}
}
