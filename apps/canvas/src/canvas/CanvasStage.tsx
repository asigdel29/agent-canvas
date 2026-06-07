/**
 * CanvasStage — the tldraw editor surface, isolated into its own module
 * so it can be code-split out of the initial bundle.
 *
 * tldraw and its stylesheet are the heaviest dependency in the canvas
 * (~2 MB). Most page loads start on the sign-in screen and never reach
 * the editor, so App lazy-imports this component behind a Suspense
 * boundary: the login/onboarding path ships almost none of tldraw, and
 * the editor chunk downloads only once a signed-in user lands on a
 * populated workspace.
 *
 * Everything tldraw-coupled lives here — the `Tldraw` component, the CSS,
 * and the custom `AgentShapeUtil` — so nothing in the eager graph imports
 * tldraw as a value.
 *
 * @author asigdel29
 */

import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'

import { AgentShapeUtil } from '../agent/AgentShapeUtil.js'

// Custom shape utilities the editor registers. Module-scope constant so
// the array identity is stable across renders.
const SHAPE_UTILS = [AgentShapeUtil]

export interface CanvasStageProps {
	/**
	 * Called once with the editor instance when tldraw mounts. The caller
	 * stashes the ref and projects agent records onto the canvas.
	 */
	readonly onMount: (editor: Editor) => void
}

/** Render the infinite-canvas editor with the agent shape registered. */
export default function CanvasStage({ onMount }: CanvasStageProps) {
	return <Tldraw shapeUtils={SHAPE_UTILS} onMount={onMount} />
}
