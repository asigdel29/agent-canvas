/**
 * yjsServer — in-process WebSocket backend for the collaborative canvas.
 *
 * The orchestrator runs as one long-lived Node process (Railway), so we
 * can hold a persistent WebSocket alongside the HTTP server rather than
 * tunnelling through serverless. Each workspace ("room") gets one
 * in-memory Y.Doc plus an Awareness instance; the wire format is the
 * standard y-websocket protocol (sync = 0, awareness = 1), so the
 * unmodified `y-websocket` client provider talks to it directly.
 *
 * Scope: only canvas *layout* (card positions) and *presence* (cursors,
 * who's online) travel over this channel. Agent run state stays on the
 * existing event-log + SSE pipeline and is never duplicated here.
 *
 * Auth: the upgrade requires the same room-scoped ephemeral token used
 * for SSE (`?token=`, minted at POST /api/auth/sse-token). We verify
 * signature + room scope but deliberately skip the single-use nonce
 * burn so a provider reconnecting with a fresh token is not mistaken
 * for a replay.
 *
 * Durability: a room's encoded state is debounce-saved to the
 * yjs_documents table when persistence is configured; on first warm-up
 * the room loads from there. Single-instance deployment means in-memory
 * room sharing is sufficient; multi-instance fan-out (over the existing
 * Postgres LISTEN/NOTIFY) is a future extension.
 * @author asigdel29
 */

import type { Server } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocketServer, type WebSocket } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

import { verifySseTokenSignatureAndScope } from '../auth/sseToken.js'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

/** Debounce window before an updated room's state is snapshotted. */
const SAVE_DEBOUNCE_MS = 2_000

/** Pluggable durability for room documents. */
export interface YjsPersistence {
	load(room: string): Promise<Uint8Array | null>
	store(room: string, state: Uint8Array): Promise<void>
}

interface Room {
	readonly doc: Y.Doc
	readonly awareness: awarenessProtocol.Awareness
	readonly conns: Map<WebSocket, Set<number>>
	readonly ready: Promise<void>
	saveTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Manages the live rooms and their WebSocket connections. One instance
 * is attached to the HTTP server via {@link attachYjsWebSocketServer}.
 */
export class YjsHub {
	private readonly rooms = new Map<string, Room>()

	constructor(private readonly persistence: YjsPersistence | null) {}

	private getRoom(name: string): Room {
		const existing = this.rooms.get(name)
		if (existing) return existing

		const doc = new Y.Doc()
		const awareness = new awarenessProtocol.Awareness(doc)
		// A server connection holds no awareness state of its own.
		awareness.setLocalState(null)

		const room: Room = { doc, awareness, conns: new Map(), ready: Promise.resolve(), saveTimer: null }
		const ready = this.persistence
			? this.persistence
					.load(name)
					.then((state) => {
						if (state && state.byteLength > 0) Y.applyUpdate(doc, state, 'persistence')
					})
					.catch(() => {
						/* a cold load failure must not wedge the room */
					})
			: Promise.resolve()
		const withReady: Room = { ...room, ready }
		this.rooms.set(name, withReady)

		doc.on('update', (update: Uint8Array, origin: unknown) => {
			this.broadcastDocUpdate(withReady, update)
			if (origin !== 'persistence') this.scheduleSave(name, withReady)
		})
		awareness.on(
			'update',
			(
				{ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
				origin: unknown
			) => {
				this.onAwarenessChange(withReady, { added, updated, removed }, origin)
			}
		)

		return withReady
	}

	/** Accept an authenticated socket into a room and wire its lifecycle. */
	async handleConnection(conn: WebSocket, roomName: string): Promise<void> {
		const room = this.getRoom(roomName)
		room.conns.set(conn, new Set())
		;(conn as unknown as { binaryType: string }).binaryType = 'arraybuffer'

		conn.on('message', (data: ArrayBuffer | Uint8Array) => {
			try {
				this.onMessage(room, conn, new Uint8Array(data as ArrayBuffer))
			} catch {
				/* a single malformed frame must not drop the connection */
			}
		})
		conn.on('close', () => this.onClose(room, roomName, conn))
		conn.on('error', () => this.onClose(room, roomName, conn))

		await room.ready

		// Initial sync: send SyncStep1 so the client reconciles, then the
		// current awareness states so cursors appear immediately.
		const sync = encoding.createEncoder()
		encoding.writeVarUint(sync, MESSAGE_SYNC)
		syncProtocol.writeSyncStep1(sync, room.doc)
		send(conn, encoding.toUint8Array(sync))

		const states = room.awareness.getStates()
		if (states.size > 0) {
			const aw = encoding.createEncoder()
			encoding.writeVarUint(aw, MESSAGE_AWARENESS)
			encoding.writeVarUint8Array(
				aw,
				awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys()))
			)
			send(conn, encoding.toUint8Array(aw))
		}
	}

	private onMessage(room: Room, conn: WebSocket, data: Uint8Array): void {
		const decoder = decoding.createDecoder(data)
		const messageType = decoding.readVarUint(decoder)
		if (messageType === MESSAGE_SYNC) {
			const encoder = encoding.createEncoder()
			encoding.writeVarUint(encoder, MESSAGE_SYNC)
			syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn)
			// A reply longer than the type byte means there is sync data to return.
			if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder))
		} else if (messageType === MESSAGE_AWARENESS) {
			awarenessProtocol.applyAwarenessUpdate(
				room.awareness,
				decoding.readVarUint8Array(decoder),
				conn
			)
		}
	}

	private broadcastDocUpdate(room: Room, update: Uint8Array): void {
		const encoder = encoding.createEncoder()
		encoding.writeVarUint(encoder, MESSAGE_SYNC)
		syncProtocol.writeUpdate(encoder, update)
		const message = encoding.toUint8Array(encoder)
		for (const conn of room.conns.keys()) send(conn, message)
	}

	private onAwarenessChange(
		room: Room,
		{ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown
	): void {
		// Track which awareness client ids each socket controls so we can
		// clear them when it disconnects.
		const controlled = room.conns.get(origin as WebSocket)
		if (controlled) {
			for (const id of added) controlled.add(id)
			for (const id of removed) controlled.delete(id)
		}
		const changed = [...added, ...updated, ...removed]
		const encoder = encoding.createEncoder()
		encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
		encoding.writeVarUint8Array(
			encoder,
			awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed)
		)
		const message = encoding.toUint8Array(encoder)
		for (const conn of room.conns.keys()) send(conn, message)
	}

	private onClose(room: Room, roomName: string, conn: WebSocket): void {
		const controlled = room.conns.get(conn)
		room.conns.delete(conn)
		if (controlled && controlled.size > 0) {
			awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(controlled), null)
		}
		try {
			conn.close()
		} catch {
			/* already closed */
		}
		// Snapshot promptly when a room goes cold so nothing is lost.
		if (room.conns.size === 0) this.flushSave(roomName, room)
	}

	private scheduleSave(roomName: string, room: Room): void {
		if (!this.persistence) return
		if (room.saveTimer) clearTimeout(room.saveTimer)
		room.saveTimer = setTimeout(() => this.flushSave(roomName, room), SAVE_DEBOUNCE_MS)
	}

	private flushSave(roomName: string, room: Room): void {
		if (!this.persistence) return
		if (room.saveTimer) {
			clearTimeout(room.saveTimer)
			room.saveTimer = null
		}
		const state = Y.encodeStateAsUpdate(room.doc)
		void this.persistence.store(roomName, state).catch(() => {
			/* a failed snapshot is retried on the next update */
		})
	}
}

function send(conn: WebSocket, message: Uint8Array): void {
	// 0 = CONNECTING, 1 = OPEN. Only send on an open socket.
	if (conn.readyState !== 1) return
	try {
		conn.send(message)
	} catch {
		try {
			conn.close()
		} catch {
			/* ignore */
		}
	}
}

/**
 * Attach the Yjs WebSocket endpoint to an existing HTTP server. Handles
 * upgrades on `/api/yjs/:room`, authenticating with the room-scoped SSE
 * token before accepting the socket. Other upgrade paths are left
 * untouched.
 *
 * @returns the hub, for tests or graceful shutdown.
 */
export function attachYjsWebSocketServer(
	server: Server,
	opts: { readonly secret: string; readonly persistence: YjsPersistence | null }
): YjsHub {
	const hub = new YjsHub(opts.persistence)
	const wss = new WebSocketServer({ noServer: true })

	server.on('upgrade', (req, socket: Duplex, head) => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
		const match = url.pathname.match(/^\/api\/yjs\/([^/]+)\/?$/)
		if (!match) return // not ours; leave for any other upgrade handler
		const room = decodeURIComponent(match[1]!)
		const token = url.searchParams.get('token') ?? ''
		try {
			// Signature + room scope only; the nonce is intentionally not
			// burned so provider reconnects with fresh tokens still work.
			verifySseTokenSignatureAndScope({ token, room_id: room, secret: opts.secret })
		} catch {
			socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
			socket.destroy()
			return
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			void hub.handleConnection(ws, room)
		})
	})

	return hub
}
