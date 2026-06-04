/**
 * Helpers for translating between the API record and the
 * AgentShape on the canvas.
 *
 * Two directions:
 *
 *   recordToShapeProps    take what /api/agents returned and produce
 *                         the props blob for editor.createShape
 *   shapePropsToPatch     when the user renames or edits the shape
 *                         on the canvas, derive the PATCH body
 *
 * The agent id becomes the tldraw shape id (with the `shape:`
 * prefix tldraw requires). This makes lookups O(1) when an event
 * arrives for an agent: the canvas knows exactly which shape to
 * update.
 * @author asigdel29
 */

import type { AgentShapeProps } from './AgentShapeUtil.js'
import type { AgentApiRecord } from './agentApi.js'
import {
	type AgentCapabilities,
	summarizeCapabilities,
} from './capabilities.js'

export type ShapeIdString = `shape:${string}`

/**
 * Wraps an agent id with the tldraw `shape:` prefix. Stable so the
 * canvas can look up the shape by agent id without an extra map.
 */
export function agentShapeId(agentId: string): ShapeIdString {
	return `shape:${agentId}` as ShapeIdString
}

/**
 * Translate an /api/agents record into the props blob expected by
 * the AgentShape tlschema. Capability fields are flattened to the
 * shape's serialized columns; the human-readable cap_summary is
 * recomputed from the capability bundle so it never diverges.
 */
export function recordToShapeProps(
	record: AgentApiRecord,
	roomId: string
): AgentShapeProps {
	const caps = record.capabilities as AgentCapabilities
	return {
		run_id: record.id, // until a real run exists, the shape stands in for the agent itself
		status: 'queued',
		title: record.name,
		vendor: null,
		origin_room_id: roomId,
		current_room_id: roomId,
		last_event_seq: 0,
		last_event_at: record.updated_at,
		w: 320,
		h: 140,
		render_mode: 'full',
		cap_computer_use: caps.computer_use.enabled,
		cap_browser_use: caps.browser_use.enabled,
		cap_mcp_server_ids: caps.mcp_servers.map((s) => s.id),
		cap_summary: summarizeCapabilities(caps),
		last_screenshot_data_uri: '',
	}
}
