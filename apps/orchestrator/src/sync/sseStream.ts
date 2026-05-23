/**
 * Server-Sent Events stream helper.
 *
 * Wraps the Web Streams API into a clean SSE envelope. Each event is
 * sent as `data: <json>\n\n`. A keep-alive comment fires every 25 s
 * to defeat intermediary timeouts. Closing the sender ends the stream
 * and clears the keep-alive timer.
 *
 * Returns an SseSender + the Response to hand back to the runtime.
 */

export interface SseSender {
	send(data: unknown): void
	close(): void
	readonly closed: boolean
	readonly response: Response
}

export interface OpenSseOptions {
	readonly keepAliveMs?: number
	/** Headers merged into the SSE response. */
	readonly extraHeaders?: Readonly<Record<string, string>>
}

export function openSseStream(opts: OpenSseOptions = {}): SseSender {
	const encoder = new TextEncoder()
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null
	let closed = false
	let keepAlive: ReturnType<typeof setInterval> | null = null

	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c
		},
		cancel() {
			closed = true
			if (keepAlive) {
				clearInterval(keepAlive)
				keepAlive = null
			}
		},
	})

	function writeRaw(chunk: string): void {
		if (closed || !controller) return
		try {
			controller.enqueue(encoder.encode(chunk))
		} catch {
			closed = true
		}
	}

	keepAlive = setInterval(() => {
		writeRaw(': keep-alive\n\n')
	}, opts.keepAliveMs ?? 25_000)

	const sender: SseSender = {
		send(data: unknown) {
			writeRaw(`data: ${JSON.stringify(data)}\n\n`)
		},
		close() {
			if (closed) return
			closed = true
			if (keepAlive) {
				clearInterval(keepAlive)
				keepAlive = null
			}
			try {
				controller?.close()
			} catch {
				// already closed downstream; ignore
			}
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
				'x-accel-buffering': 'no',
				...(opts.extraHeaders ?? {}),
			},
		}),
	}

	return sender
}
