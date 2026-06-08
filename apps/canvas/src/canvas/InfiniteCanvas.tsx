/**
 * InfiniteCanvas — a small pan/zoom canvas that renders agent cards.
 *
 * This is the rendering and interaction engine that replaces the former
 * third-party canvas. It owns a camera `{x, y, z}` (world point at the
 * viewport origin, plus a zoom factor) and projects each shape from the
 * {@link CanvasStore} into screen space through a single CSS transform on
 * a world layer. tldraw's interaction model is the behavioural reference.
 *
 * Interactions:
 *   - pan (hand tool, space-drag, or middle button) and cursor-anchored
 *     wheel zoom (ctrl/⌘ + wheel); plain wheel scrolls/pans;
 *   - select (click), additive/toggle (shift-click), and marquee select;
 *   - drag to move the selection, with edge/center snapping + guides;
 *   - keyboard nudge of the selection, zoom (+/-/0), and Escape to clear;
 *   - density: when many cards are visible they auto-collapse to compact
 *     via {@link decideDensity}; the zoom cluster can force-expand.
 *   - double-click a card to open it.
 *
 * The component exposes a {@link CanvasController} (the store editor plus
 * camera controls) through `onMount`, so the surrounding app drives shape
 * creation/updates and the zoom cluster exactly as before.
 *
 * @author asigdel29
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import type { RunId } from '@agent-canvas/orchestrator-types'
import { decideDensity, type RenderMode } from '../agent/density.js'
import { AgentCard } from './AgentCard.js'
import type { CanvasShape } from './agentShape.js'
import { CanvasStore, type CanvasEditor } from './canvasStore.js'
import { createCanvasCollab, type CanvasCollab, type PresenceState } from './collab.js'

/** A peer's live cursor, in world coordinates, for the overlay. */
interface RemoteCursor {
	readonly id: number
	readonly name: string
	readonly color: string
	readonly x: number
	readonly y: number
}

/** A present collaborator, surfaced to the app for the presence stack. */
export interface PresencePeer {
	readonly id: string
	readonly label: string
	readonly color: string
}

/** Throttle window for broadcasting the local cursor over awareness. */
const CURSOR_BROADCAST_MS = 50

/** The camera: `(x, y)` is the world point at the viewport's top-left. */
interface Camera {
	readonly x: number
	readonly y: number
	readonly z: number
}

/** The editor shim plus camera controls handed to the app on mount. */
export interface CanvasController extends CanvasEditor {
	zoomIn(): void
	zoomOut(): void
	zoomToFit(): void
}

/** Which background-drag gesture the toolbar selects. */
export type CanvasTool = 'select' | 'hand'

export interface InfiniteCanvasProps {
	/** Scopes persisted card positions. */
	readonly workspaceId: string
	/** Active toolbar tool; `hand` pans on background drag, `select` marquees. */
	readonly tool: CanvasTool
	/** When true, every card renders full; otherwise density is automatic. */
	readonly forceExpand: boolean
	/** Receives the controller once, on mount. */
	readonly onMount: (controller: CanvasController) => void
	/** Called with the bare agent id when a card is double-clicked. */
	readonly onShapeClick?: (agentId: string) => void
	/** Reports the current zoom as a percentage for the zoom cluster. */
	readonly onCameraChange?: (zoomPercent: number) => void
	/** Orchestrator base URL — opens the collaborative session when set. */
	readonly orchestratorUrl?: string | undefined
	/** Session JWT used to authenticate the collaborative WebSocket. */
	readonly session?: string | undefined
	/** This user's display label and cursor colour for presence. */
	readonly userLabel?: string | undefined
	readonly userColor?: string | undefined
	/** Read-only viewers see peers but never publish layout changes. */
	readonly readOnly?: boolean | undefined
	/** Reports the live set of present collaborators (including self). */
	readonly onPresenceChange?: ((peers: readonly PresencePeer[]) => void) | undefined
}

const MIN_ZOOM = 0.1
const MAX_ZOOM = 4
const ZOOM_STEP = 1.2
const SNAP_THRESHOLD = 6
const CLICK_MOVE_THRESHOLD = 4
const DENSITY_THRESHOLD = 3
const NUDGE_STEP = 1
const NUDGE_STEP_LARGE = 10
const EMPTY_FORCE: ReadonlySet<RunId> = new Set()

type Interaction =
	| { kind: 'idle' }
	| { kind: 'pan'; startX: number; startY: number; cam: Camera }
	| {
			kind: 'drag'
			startX: number
			startY: number
			ids: string[]
			primary: string
			start: Map<string, { x: number; y: number }>
			moved: boolean
	  }
	| { kind: 'marquee'; startX: number; startY: number; base: ReadonlySet<string> }

interface Guide {
	readonly axis: 'x' | 'y'
	readonly world: number
}

/** Render the agent canvas. */
export function InfiniteCanvas({
	workspaceId,
	tool,
	forceExpand,
	onMount,
	onShapeClick,
	onCameraChange,
	orchestratorUrl,
	session,
	userLabel,
	userColor,
	readOnly,
	onPresenceChange,
}: InfiniteCanvasProps) {
	const store = useMemo(() => new CanvasStore(workspaceId), [workspaceId])
	const [remoteCursors, setRemoteCursors] = useState<readonly RemoteCursor[]>([])
	const collabRef = useRef<CanvasCollab | null>(null)
	const lastCursorBroadcast = useRef(0)
	const shapes = useSyncExternalStore(store.subscribe, store.getSnapshot)
	const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, z: 1 })
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
	const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
	const [guides, setGuides] = useState<readonly Guide[]>([])
	const [size, setSize] = useState({ w: 0, h: 0 })

	const viewportRef = useRef<HTMLDivElement | null>(null)
	const interaction = useRef<Interaction>({ kind: 'idle' })
	const cameraRef = useRef(camera)
	cameraRef.current = camera
	const shapesRef = useRef(shapes)
	shapesRef.current = shapes
	const selectedRef = useRef(selected)
	selectedRef.current = selected
	const toolRef = useRef(tool)
	toolRef.current = tool
	const spaceRef = useRef(false)
	const sizeRef = useRef(size)
	sizeRef.current = size

	// Track viewport size for centre-zoom and visibility/density.
	useEffect(() => {
		const el = viewportRef.current
		if (!el) return
		const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
		measure()
		const ro = new ResizeObserver(measure)
		ro.observe(el)
		return () => ro.disconnect()
	}, [])

	// Report zoom for the cluster display.
	useEffect(() => {
		onCameraChange?.(Math.round(camera.z * 100))
	}, [camera.z, onCameraChange])

	// Hand the controller to the app once per store.
	useEffect(() => {
		const controller: CanvasController = {
			...store.editor,
			zoomIn: () => setCamera((c) => zoomAt(c, ZOOM_STEP, sizeRef.current.w / 2, sizeRef.current.h / 2)),
			zoomOut: () => setCamera((c) => zoomAt(c, 1 / ZOOM_STEP, sizeRef.current.w / 2, sizeRef.current.h / 2)),
			zoomToFit: () => setCamera(fitCamera(shapesRef.current, sizeRef.current)),
		}
		onMount(controller)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [store])

	// Stable refs for values the collab effect reads but should not
	// re-subscribe on (a new inline callback or label every render).
	const onPresenceRef = useRef(onPresenceChange)
	onPresenceRef.current = onPresenceChange
	const userLabelRef = useRef(userLabel)
	userLabelRef.current = userLabel
	const userColorRef = useRef(userColor)
	userColorRef.current = userColor

	// Collaborative session: shared layout + presence/cursors. Opens once
	// per (workspace, session); falls back to single-player when it can't
	// connect.
	useEffect(() => {
		if (!orchestratorUrl || !session || !workspaceId) return
		let disposed = false
		let detachShared: (() => void) | null = null
		let detachAwareness: (() => void) | null = null
		void (async () => {
			const collab = await createCanvasCollab({ workspaceId, orchestratorUrl, session })
			if (!collab) return
			if (disposed) {
				collab.dispose()
				return
			}
			collabRef.current = collab
			detachShared = store.attachSharedPositions(collab.positions, !readOnly)

			const awareness = collab.awareness
			awareness.setLocalStateField('user', {
				name: userLabelRef.current ?? 'You',
				color: userColorRef.current ?? '#8888ff',
			})

			const recompute = () => {
				const cursors: RemoteCursor[] = []
				const peers: PresencePeer[] = []
				awareness.getStates().forEach((raw, clientId) => {
					const state = raw as Partial<PresenceState>
					if (state.user) {
						peers.push({ id: String(clientId), label: state.user.name, color: state.user.color })
					}
					if (clientId !== awareness.clientID && state.cursor && state.user) {
						cursors.push({
							id: clientId,
							name: state.user.name,
							color: state.user.color,
							x: state.cursor.x,
							y: state.cursor.y,
						})
					}
				})
				setRemoteCursors(cursors)
				onPresenceRef.current?.(peers)
			}
			awareness.on('change', recompute)
			detachAwareness = () => awareness.off('change', recompute)
			recompute()
		})()
		return () => {
			disposed = true
			detachShared?.()
			detachAwareness?.()
			collabRef.current?.dispose()
			collabRef.current = null
			setRemoteCursors([])
			onPresenceRef.current?.([])
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [store, workspaceId, orchestratorUrl, session, readOnly])

	/** Broadcast the local cursor (world coords) over awareness, throttled. */
	function broadcastCursor(e: { clientX: number; clientY: number }): void {
		const collab = collabRef.current
		if (!collab) return
		const now = Date.now()
		if (now - lastCursorBroadcast.current < CURSOR_BROADCAST_MS) return
		lastCursorBroadcast.current = now
		const p = localPoint(e)
		const cam = cameraRef.current
		collab.awareness.setLocalStateField('cursor', {
			x: cam.x + p.x / cam.z,
			y: cam.y + p.y / cam.z,
		})
	}

	// Track the space bar for temporary panning regardless of tool.
	useEffect(() => {
		const down = (e: KeyboardEvent) => {
			if (e.code === 'Space') spaceRef.current = true
		}
		const up = (e: KeyboardEvent) => {
			if (e.code === 'Space') spaceRef.current = false
		}
		window.addEventListener('keydown', down)
		window.addEventListener('keyup', up)
		return () => {
			window.removeEventListener('keydown', down)
			window.removeEventListener('keyup', up)
		}
	}, [])

	function localPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
		const rect = viewportRef.current!.getBoundingClientRect()
		return { x: e.clientX - rect.left, y: e.clientY - rect.top }
	}

	function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
		if (e.button !== 0 && e.button !== 1) return
		viewportRef.current?.setPointerCapture(e.pointerId)
		const p = localPoint(e)
		const shapeId = findShapeId(e.target as HTMLElement)
		const panMode = toolRef.current === 'hand' || spaceRef.current || e.button === 1

		if (shapeId && !panMode) {
			let next = new Set(selectedRef.current)
			if (e.shiftKey) {
				next.has(shapeId) ? next.delete(shapeId) : next.add(shapeId)
			} else if (!next.has(shapeId)) {
				next = new Set([shapeId])
			}
			applySelection(next)
			const ids = [...next]
			const start = new Map<string, { x: number; y: number }>()
			for (const id of ids) {
				const s = shapesRef.current.find((x) => x.id === id)
				if (s) start.set(id, { x: s.x, y: s.y })
			}
			interaction.current = { kind: 'drag', startX: e.clientX, startY: e.clientY, ids, primary: shapeId, start, moved: false }
			return
		}
		if (panMode) {
			interaction.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, cam: cameraRef.current }
			return
		}
		// Empty background with the select tool: marquee.
		const base = e.shiftKey ? new Set(selectedRef.current) : new Set<string>()
		if (!e.shiftKey) applySelection(base)
		interaction.current = { kind: 'marquee', startX: p.x, startY: p.y, base }
		setMarquee({ x: p.x, y: p.y, w: 0, h: 0 })
	}

	function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
		broadcastCursor(e)
		const it = interaction.current
		if (it.kind === 'pan') {
			const dx = e.clientX - it.startX
			const dy = e.clientY - it.startY
			setCamera({ x: it.cam.x - dx / it.cam.z, y: it.cam.y - dy / it.cam.z, z: it.cam.z })
			return
		}
		if (it.kind === 'drag') {
			const z = cameraRef.current.z
			let wdx = (e.clientX - it.startX) / z
			let wdy = (e.clientY - it.startY) / z
			const primaryStart = it.start.get(it.primary)!
			const snap = computeSnap(
				{ x: primaryStart.x + wdx, y: primaryStart.y + wdy, w: widthOf(it.primary, shapesRef.current), h: heightOf(it.primary, shapesRef.current) },
				shapesRef.current.filter((s) => !it.ids.includes(s.id))
			)
			wdx += snap.dx
			wdy += snap.dy
			if (Math.abs(e.clientX - it.startX) > CLICK_MOVE_THRESHOLD || Math.abs(e.clientY - it.startY) > CLICK_MOVE_THRESHOLD) {
				it.moved = true
			}
			const moves = it.ids.map((id) => {
				const p = it.start.get(id)!
				return { id, x: p.x + wdx, y: p.y + wdy }
			})
			store.moveShapes(moves, false)
			setGuides(snap.guides)
			return
		}
		if (it.kind === 'marquee') {
			const p = localPoint(e)
			const x = Math.min(it.startX, p.x)
			const y = Math.min(it.startY, p.y)
			const w = Math.abs(p.x - it.startX)
			const h = Math.abs(p.y - it.startY)
			setMarquee({ x, y, w, h })
			const cam = cameraRef.current
			const hit = new Set(it.base)
			for (const s of shapesRef.current) {
				const sx = (s.x - cam.x) * cam.z
				const sy = (s.y - cam.y) * cam.z
				const sw = s.props.w * cam.z
				const sh = s.props.h * cam.z
				if (sx < x + w && sx + sw > x && sy < y + h && sy + sh > y) hit.add(s.id)
			}
			applySelection(hit)
		}
	}

	function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
		const it = interaction.current
		if (it.kind === 'drag' && it.moved) {
			const moves = it.ids.map((id) => {
				const s = shapesRef.current.find((x) => x.id === id)
				return { id, x: s ? s.x : 0, y: s ? s.y : 0 }
			})
			store.moveShapes(moves, true)
		}
		viewportRef.current?.releasePointerCapture(e.pointerId)
		interaction.current = { kind: 'idle' }
		setGuides([])
		setMarquee(null)
	}

	function onWheel(e: React.WheelEvent<HTMLDivElement>) {
		const p = localPoint(e)
		if (e.ctrlKey || e.metaKey) {
			const factor = Math.exp(-e.deltaY * 0.01)
			setCamera((c) => zoomAt(c, factor, p.x, p.y))
		} else {
			setCamera((c) => ({ x: c.x + e.deltaX / c.z, y: c.y + e.deltaY / c.z, z: c.z }))
		}
	}

	function onDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
		const shapeId = findShapeId(e.target as HTMLElement)
		if (shapeId && onShapeClick) onShapeClick(shapeId.replace(/^shape:/, ''))
	}

	function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
		if (e.key === 'Escape') {
			applySelection(new Set())
			return
		}
		if (e.key === '0') {
			setCamera(fitCamera(shapesRef.current, sizeRef.current))
			return
		}
		if (e.key === '+' || e.key === '=') {
			setCamera((c) => zoomAt(c, ZOOM_STEP, sizeRef.current.w / 2, sizeRef.current.h / 2))
			return
		}
		if (e.key === '-') {
			setCamera((c) => zoomAt(c, 1 / ZOOM_STEP, sizeRef.current.w / 2, sizeRef.current.h / 2))
			return
		}
		const delta = arrowDelta(e.key)
		if (delta && selectedRef.current.size > 0) {
			e.preventDefault()
			const step = e.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP
			const moves = [...selectedRef.current].map((id) => {
				const s = shapesRef.current.find((x) => x.id === id)!
				return { id, x: s.x + delta.x * step, y: s.y + delta.y * step }
			})
			store.moveShapes(moves, true)
		}
	}

	function applySelection(next: ReadonlySet<string>) {
		selectedRef.current = next
		setSelected(next)
	}

	// Density: collapse cards when many are visible at the current zoom.
	const visible = useMemo(() => computeVisible(shapes, camera, size), [shapes, camera, size])
	const density = useMemo(
		() =>
			decideDensity({
				visible: visible as unknown as RunId[],
				forceExpanded: EMPTY_FORCE,
				threshold: DENSITY_THRESHOLD,
			}),
		[visible]
	)
	const modeFor = (id: string): RenderMode => (forceExpand ? 'full' : density.mode_by_run.get(id as RunId) ?? 'full')

	return (
		<div
			ref={viewportRef}
			role="application"
			aria-label="Agent canvas"
			tabIndex={0}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerLeave={() => collabRef.current?.awareness.setLocalStateField('cursor', null)}
			onWheel={onWheel}
			onDoubleClick={onDoubleClick}
			onKeyDown={onKeyDown}
			style={{
				position: 'absolute',
				inset: 0,
				overflow: 'hidden',
				background: 'var(--surface)',
				touchAction: 'none',
				cursor: tool === 'hand' ? 'grab' : 'default',
				outline: 'none',
			}}
		>
			<div
				style={{
					position: 'absolute',
					left: 0,
					top: 0,
					transformOrigin: '0 0',
					transform: `translate(${-camera.x * camera.z}px, ${-camera.y * camera.z}px) scale(${camera.z})`,
				}}
			>
				{shapes.map((s) => (
					<div
						key={s.id}
						data-shape-id={s.id}
						style={{
							position: 'absolute',
							left: s.x,
							top: s.y,
							width: s.props.w,
							height: s.props.h,
							cursor: 'grab',
						}}
					>
						<AgentCard props={s.props} renderMode={modeFor(s.id)} selected={selected.has(s.id)} />
					</div>
				))}
			</div>

			{guides.map((g, i) => (
				<div
					key={i}
					aria-hidden="true"
					style={
						g.axis === 'x'
							? { position: 'absolute', left: (g.world - camera.x) * camera.z, top: 0, width: 1, height: '100%', background: 'var(--accent)', pointerEvents: 'none' }
							: { position: 'absolute', top: (g.world - camera.y) * camera.z, left: 0, height: 1, width: '100%', background: 'var(--accent)', pointerEvents: 'none' }
					}
				/>
			))}

			{marquee && (
				<div
					aria-hidden="true"
					style={{
						position: 'absolute',
						left: marquee.x,
						top: marquee.y,
						width: marquee.w,
						height: marquee.h,
						border: '1px solid var(--accent)',
						background: 'var(--accent-soft)',
						pointerEvents: 'none',
					}}
				/>
			)}

			{remoteCursors.map((c) => (
				<RemoteCursorMarker
					key={c.id}
					name={c.name}
					color={c.color}
					left={(c.x - camera.x) * camera.z}
					top={(c.y - camera.y) * camera.z}
				/>
			))}
		</div>
	)
}

/** A peer's cursor rendered in screen space so it stays a constant size. */
function RemoteCursorMarker({
	name,
	color,
	left,
	top,
}: {
	name: string
	color: string
	left: number
	top: number
}) {
	return (
		<div
			aria-hidden="true"
			style={{
				position: 'absolute',
				left,
				top,
				transform: 'translate(-2px, -2px)',
				pointerEvents: 'none',
				zIndex: 5,
			}}
		>
			<svg width="16" height="16" viewBox="0 0 16 16" style={{ display: 'block' }}>
				<path d="M1 1 L1 12 L4.5 8.8 L7 14 L9 13 L6.5 8 L11 8 Z" fill={color} stroke="white" strokeWidth="1" />
			</svg>
			<span
				style={{
					position: 'absolute',
					left: 14,
					top: 0,
					padding: '1px 6px',
					borderRadius: 'var(--radius-pill)',
					background: color,
					color: 'white',
					fontSize: 11,
					fontFamily: 'var(--font-ui)',
					whiteSpace: 'nowrap',
				}}
			>
				{name}
			</span>
		</div>
	)
}

/* -------------------------------------------------------------- *
 * Pure helpers                                                   *
 * -------------------------------------------------------------- */

/** Clamp a zoom factor to the supported range. */
function clampZoom(z: number): number {
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}

/**
 * Zoom by `factor` while keeping the world point under viewport-local
 * `(lx, ly)` fixed on screen.
 */
function zoomAt(cam: Camera, factor: number, lx: number, ly: number): Camera {
	const z = clampZoom(cam.z * factor)
	return { x: lx / cam.z + cam.x - lx / z, y: ly / cam.z + cam.y - ly / z, z }
}

/** Compute a camera that frames all shapes within `size`, with padding. */
function fitCamera(shapes: readonly CanvasShape[], size: { w: number; h: number }): Camera {
	if (shapes.length === 0 || size.w === 0 || size.h === 0) return { x: 0, y: 0, z: 1 }
	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity
	for (const s of shapes) {
		minX = Math.min(minX, s.x)
		minY = Math.min(minY, s.y)
		maxX = Math.max(maxX, s.x + s.props.w)
		maxY = Math.max(maxY, s.y + s.props.h)
	}
	const pad = 80
	const bw = maxX - minX + pad * 2
	const bh = maxY - minY + pad * 2
	const z = clampZoom(Math.min(size.w / bw, size.h / bh))
	// Centre the content.
	const cx = (minX + maxX) / 2
	const cy = (minY + maxY) / 2
	return { x: cx - size.w / 2 / z, y: cy - size.h / 2 / z, z }
}

/** Ids of shapes whose world bounds intersect the current viewport. */
function computeVisible(shapes: readonly CanvasShape[], cam: Camera, size: { w: number; h: number }): string[] {
	if (size.w === 0 || size.h === 0) return shapes.map((s) => s.id)
	const left = cam.x
	const top = cam.y
	const right = cam.x + size.w / cam.z
	const bottom = cam.y + size.h / cam.z
	const out: string[] = []
	for (const s of shapes) {
		if (s.x < right && s.x + s.props.w > left && s.y < bottom && s.y + s.props.h > top) out.push(s.id)
	}
	return out
}

/**
 * Snap a moving rectangle's edges/centres to nearby static shapes.
 *
 * @returns the `(dx, dy)` adjustment to apply and the guide lines to draw.
 */
function computeSnap(
	rect: { x: number; y: number; w: number; h: number },
	others: readonly CanvasShape[]
): { dx: number; dy: number; guides: Guide[] } {
	const guides: Guide[] = []
	const xEdges = [rect.x, rect.x + rect.w / 2, rect.x + rect.w]
	const yEdges = [rect.y, rect.y + rect.h / 2, rect.y + rect.h]
	let bestDx = 0
	let bestDxDist = SNAP_THRESHOLD
	let bestDy = 0
	let bestDyDist = SNAP_THRESHOLD
	let guideX: number | null = null
	let guideY: number | null = null
	for (const o of others) {
		const ox = [o.x, o.x + o.props.w / 2, o.x + o.props.w]
		const oy = [o.y, o.y + o.props.h / 2, o.y + o.props.h]
		for (const e of xEdges) {
			for (const t of ox) {
				const d = Math.abs(t - e)
				if (d < bestDxDist) {
					bestDxDist = d
					bestDx = t - e
					guideX = t
				}
			}
		}
		for (const e of yEdges) {
			for (const t of oy) {
				const d = Math.abs(t - e)
				if (d < bestDyDist) {
					bestDyDist = d
					bestDy = t - e
					guideY = t
				}
			}
		}
	}
	if (guideX !== null) guides.push({ axis: 'x', world: guideX })
	if (guideY !== null) guides.push({ axis: 'y', world: guideY })
	return { dx: bestDx, dy: bestDy, guides }
}

/** Walk up from `el` to the nearest element carrying `data-shape-id`. */
function findShapeId(el: HTMLElement | null): string | null {
	let node: HTMLElement | null = el
	for (let i = 0; node && i < 12; i += 1) {
		const id = node.getAttribute?.('data-shape-id')
		if (id) return id
		node = node.parentElement
	}
	return null
}

/** Map an arrow key to a unit direction, or null. */
function arrowDelta(key: string): { x: number; y: number } | null {
	switch (key) {
		case 'ArrowLeft':
			return { x: -1, y: 0 }
		case 'ArrowRight':
			return { x: 1, y: 0 }
		case 'ArrowUp':
			return { x: 0, y: -1 }
		case 'ArrowDown':
			return { x: 0, y: 1 }
		default:
			return null
	}
}

function widthOf(id: string, shapes: readonly CanvasShape[]): number {
	return shapes.find((s) => s.id === id)?.props.w ?? 0
}
function heightOf(id: string, shapes: readonly CanvasShape[]): number {
	return shapes.find((s) => s.id === id)?.props.h ?? 0
}
