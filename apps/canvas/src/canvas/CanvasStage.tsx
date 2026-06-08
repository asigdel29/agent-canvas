/**
 * CanvasStage — the lazily-loaded entry point for the canvas surface.
 *
 * App imports this behind a Suspense boundary so the sign-in / onboarding
 * path ships none of the canvas code. It is a thin forwarder to
 * {@link InfiniteCanvas}, which owns all rendering and interaction.
 *
 * @author asigdel29
 */

import {
	InfiniteCanvas,
	type CanvasController,
	type CanvasTool,
	type PresencePeer,
} from './InfiniteCanvas.js'

export type { CanvasController, CanvasTool, PresencePeer } from './InfiniteCanvas.js'

export interface CanvasStageProps {
	/** Scopes persisted card positions. */
	readonly workspaceId: string
	/** Active toolbar tool. */
	readonly tool: CanvasTool
	/** When true, every card renders full; otherwise density is automatic. */
	readonly forceExpand: boolean
	/** Receives the controller once, on mount. */
	readonly onMount: (controller: CanvasController) => void
	/** Called with the bare agent id when a card is double-clicked. */
	readonly onShapeClick?: (agentId: string) => void
	/** Reports the current zoom as a percentage for the zoom cluster. */
	readonly onCameraChange?: (zoomPercent: number) => void
	/** Orchestrator base URL — enables the collaborative session. */
	readonly orchestratorUrl?: string | undefined
	/** Session JWT for the collaborative WebSocket. */
	readonly session?: string | undefined
	/** This user's display label and cursor colour. */
	readonly userLabel?: string | undefined
	readonly userColor?: string | undefined
	/** Read-only viewers see peers but never publish layout changes. */
	readonly readOnly?: boolean | undefined
	/** Reports the live set of present collaborators. */
	readonly onPresenceChange?: ((peers: readonly PresencePeer[]) => void) | undefined
}

/** Render the canvas surface. */
export default function CanvasStage(props: CanvasStageProps) {
	return (
		<InfiniteCanvas
			workspaceId={props.workspaceId}
			tool={props.tool}
			forceExpand={props.forceExpand}
			onMount={props.onMount}
			orchestratorUrl={props.orchestratorUrl}
			session={props.session}
			userLabel={props.userLabel}
			userColor={props.userColor}
			readOnly={props.readOnly}
			onPresenceChange={props.onPresenceChange}
			{...(props.onShapeClick ? { onShapeClick: props.onShapeClick } : {})}
			{...(props.onCameraChange ? { onCameraChange: props.onCameraChange } : {})}
		/>
	)
}
