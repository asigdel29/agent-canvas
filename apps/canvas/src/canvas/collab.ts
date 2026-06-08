/**
 * collab.ts — the canvas's multiplayer session.
 *
 * Opens a Yjs document over the orchestrator's in-process WebSocket
 * (src/yjs/yjsServer.ts) for one workspace/room. The shared `positions`
 * map is the multiplayer source of truth for card layout; awareness
 * carries live cursors and presence. Agent run state is NOT here — it
 * keeps flowing over the existing SSE pipeline.
 *
 * The WebSocket is authenticated with a room-scoped token minted at
 * POST /api/auth/yjs-token (longer-lived than the SSE token because the
 * provider reuses its connect URL across reconnects).
 * @author asigdel29
 */

import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { Awareness } from 'y-protocols/awareness'

import type { SharedPositions } from './canvasStore.js'

export interface CanvasCollab {
	readonly positions: SharedPositions
	readonly awareness: Awareness
	readonly clientId: number
	dispose(): void
}

/** What each peer publishes about itself for cursors + presence. */
export interface PresenceState {
	readonly user: { readonly name: string; readonly color: string }
	readonly cursor: { readonly x: number; readonly y: number } | null
}

type PositionValue = { x: number; y: number }

/** Wrap a Yjs map as the store's transport-agnostic SharedPositions. */
function sharedPositionsFromYMap(map: Y.Map<PositionValue>): SharedPositions {
	return {
		get: (id) => map.get(id),
		set: (id, pos) => map.set(id, { x: pos.x, y: pos.y }),
		entries: () => Array.from(map.entries()).map(([k, v]) => [k, v] as const),
		observe: (onChange) => {
			const handler = (event: Y.YMapEvent<PositionValue>) => {
				onChange(Array.from(event.keysChanged))
			}
			map.observe(handler)
			return () => map.unobserve(handler)
		},
	}
}

/**
 * Open a collaborative session for a room. Resolves to null when there
 * is no workspace, the environment is non-browser, or the auth token
 * cannot be minted — in which case the canvas runs single-player off
 * localStorage and simply has no peers.
 */
export async function createCanvasCollab(opts: {
	readonly workspaceId: string
	readonly orchestratorUrl: string
	readonly session: string
}): Promise<CanvasCollab | null> {
	if (typeof window === 'undefined' || !opts.workspaceId) return null

	let token: string
	try {
		const res = await fetch(`${opts.orchestratorUrl}/api/auth/yjs-token`, {
			method: 'POST',
			headers: { authorization: `Bearer ${opts.session}`, 'content-type': 'application/json' },
			body: JSON.stringify({ room_id: opts.workspaceId }),
		})
		if (!res.ok) return null
		token = ((await res.json()) as { token: string }).token
	} catch {
		return null
	}

	const wsBase = opts.orchestratorUrl.replace(/^http/, 'ws')
	const doc = new Y.Doc()
	const provider = new WebsocketProvider(`${wsBase}/api/yjs`, opts.workspaceId, doc, {
		params: { token },
	})
	const map = doc.getMap<PositionValue>('positions')

	return {
		positions: sharedPositionsFromYMap(map),
		awareness: provider.awareness,
		clientId: doc.clientID,
		dispose: () => {
			provider.destroy()
			doc.destroy()
		},
	}
}
