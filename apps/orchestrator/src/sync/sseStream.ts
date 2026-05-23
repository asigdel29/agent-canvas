/**
 * Server-Sent Events stream helper.
 *
 * A small utility that wraps the Web Streams API into a clean SSE
 * envelope. Each event is sent as `data: <json>\n\n`. Keep-alive
 * comments fire every 25 s to defeat intermediary timeouts.
 */

export interface SseSender {
	send(data: unknown): void
	close(): void
	readonly closed: boolean
	readonly response: Response
}

export function openSseStream(): SseSender {
	let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
	const encoder = new TextEncoder()
	let closed = false
	let keepAlive: ReturnType<typeof setInterval> | null = null

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			writer = {
				write: (chunk: Uint8Array) => {
					controller.enqueue(chunk)
					return Promise.resolve()
				},
				close: () => {
					controller.close()
					return Promise.resolve()
				},
				abort: () => Promise.resolve(),
				releaseLock: () => {},
				closed: Promise.resolve(undefined),
				desiredSize: null,
				ready: Promise.resolve(undefined),
			} as unknown as WritableStreamDefaultWriter<Uint8Array>
		},
	})

	const sender: SseSender = {
		send(data: unknown) {
			if (closed || !writer) return
			const payload = `data: ${JSON.stringify(data)}\n\n`
			void writer.write(encoder.encode(payload))
		},
		close() {
			if (closed) return
			closed = true
			if (keepAlive) clearInterval(keepAlive)
			if (writer) void writer.close()
		},
		get closed() {
			return closed
		},
		response: new Response(body, {
			status: 200,
			headers: {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache, no-transform',
				connection: 'keep-alive',
			},
		}),
	}

	// Best-effort keep-alive. The SSE spec uses `:`-prefixed comments,
	// which clients ignore but proxies treat as activity.
	keepAlive = setInterval(() => {
		if (closed || !writer) return
		void writer.write(encoder.encode(': keep-alive\n\n'))
	}, 25_000)

	return sender
}
