/**
 * Shape model for an agent on the canvas.
 *
 * An agent card is a projection of the authoritative agent/run living in
 * the orchestrator. These types are the canvas's own — they carry no
 * dependency on any rendering engine — so the data model is shared by the
 * store, the view, and the record→shape mapping without coupling to a
 * third-party canvas library.
 *
 * @author asigdel29
 */

import type { RenderMode } from '../agent/density.js'

/** Lifecycle states an agent card can display. */
export type AgentStatus =
	| 'queued'
	| 'provisioning'
	| 'running'
	| 'awaiting_input'
	| 'succeeded'
	| 'failed'
	| 'cancelled'
	| 'unreachable'

/**
 * The display properties of an agent card. Flat primitives so the value
 * is trivial to serialize, diff, and persist. `render_mode` is advisory
 * here; the live density decision is applied by the view at draw time.
 */
export interface AgentShapeProps {
	/** Agent id (or run id) the card represents. */
	run_id: string
	status: AgentStatus
	/** Display name shown in the card header. */
	title: string
	/** Model vendor/provider label, or null when unknown. */
	vendor: string | null
	/** Workspace the card originated in. */
	origin_room_id: string
	/** Workspace currently viewing the card (drives the cross-room note). */
	current_room_id: string
	last_event_seq: number
	/** ISO 8601 timestamp of the most recent event. */
	last_event_at: string
	/** Card width in world units. */
	w: number
	/** Card height in world units. */
	h: number
	render_mode: RenderMode
	cap_computer_use: boolean
	cap_browser_use: boolean
	cap_mcp_server_ids: string[]
	/** One-line capability summary for the compact footer. */
	cap_summary: string
	/** Most recent computer-use screenshot as a data: URI; '' when none. */
	last_screenshot_data_uri: string
}

/** A positioned shape on the canvas. Today every shape is an agent card. */
export interface CanvasShape {
	/** Stable id, conventionally `shape:<agentId>`. */
	readonly id: string
	/** Discriminator; currently always `'agent'`. */
	readonly type: string
	/** World-space top-left. */
	x: number
	y: number
	readonly props: AgentShapeProps
}

/** Default card dimensions, in world units. */
export const DEFAULT_AGENT_WIDTH = 320
export const DEFAULT_AGENT_HEIGHT = 140
