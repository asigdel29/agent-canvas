/**
 * In-memory store of canvas shapes with a tldraw-compatible editor shim.
 *
 * The store is the single source of truth for what sits on the canvas. It
 * is consumed by the view through {@link subscribe} / {@link getSnapshot}
 * (a `useSyncExternalStore` pair) and mutated from two sides:
 *
 *   - the app, imperatively, through {@link editor} — `getShape`,
 *     `createShape`, `updateShape` keep the exact names and shapes the
 *     code already called on the previous engine, so the surrounding app
 *     is untouched;
 *   - the view, through {@link moveShapes}, while the user drags cards.
 *
 * Card positions are persisted per workspace in `localStorage`, so a
 * reload restores the user's arrangement instead of re-flowing to the
 * default grid. Positions are the only canvas state persisted; everything
 * else is re-projected from the orchestrator on load.
 *
 * @author asigdel29
 */

import type { AgentShapeProps, CanvasShape } from './agentShape.js'

/** Input to {@link CanvasEditor.createShape}. */
export interface CreateShapeInput {
	readonly id: string
	readonly type: string
	readonly x: number
	readonly y: number
	readonly props: AgentShapeProps
}

/** Input to {@link CanvasEditor.updateShape}; props are merged shallowly. */
export interface UpdateShapeInput {
	readonly id: string
	readonly type: string
	readonly props: Partial<AgentShapeProps>
}

/**
 * The imperative surface the app drives. Intentionally the same method
 * names and argument shapes the app previously called on the tldraw
 * editor, so swapping engines needs no call-site changes.
 */
export interface CanvasEditor {
	/** Return the shape with `id`, or undefined when absent. */
	getShape(id: string): CanvasShape | undefined
	/** Number of shapes currently on the canvas (for default placement). */
	getShapeCount(): number
	/** Add a shape if `id` is new; positions may be overridden by a saved layout. */
	createShape(input: CreateShapeInput): void
	/** Shallow-merge new props into an existing shape; no-op when absent. */
	updateShape(input: UpdateShapeInput): void
}

type PositionMap = Record<string, { x: number; y: number }>

const POSITION_KEY_PREFIX = 'agent-canvas:positions:'

/**
 * Holds the canvas shapes for one workspace and exposes the editor shim.
 */
export class CanvasStore {
	private readonly shapes = new Map<string, CanvasShape>()
	private readonly listeners = new Set<() => void>()
	private snapshot: readonly CanvasShape[] = []
	private readonly savedPositions: PositionMap

	/**
	 * @param workspaceId scopes persisted positions; an empty id disables
	 *   persistence (positions stay in memory only).
	 */
	constructor(private readonly workspaceId: string) {
		this.savedPositions = this.loadPositions()
	}

	/** Register a change listener; returns an unsubscribe function. */
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	/** Current shapes as a stable array; identity changes on every mutation. */
	getSnapshot = (): readonly CanvasShape[] => this.snapshot

	/** The imperative editor shim handed to the app on mount. */
	readonly editor: CanvasEditor = {
		getShape: (id) => this.shapes.get(id),
		getShapeCount: () => this.shapes.size,
		createShape: (input) => {
			if (this.shapes.has(input.id)) return
			const saved = this.savedPositions[input.id]
			this.shapes.set(input.id, {
				id: input.id,
				type: input.type,
				x: saved ? saved.x : input.x,
				y: saved ? saved.y : input.y,
				props: input.props,
			})
			this.commit()
		},
		updateShape: (input) => {
			const existing = this.shapes.get(input.id)
			if (!existing) return
			this.shapes.set(input.id, {
				...existing,
				props: { ...existing.props, ...input.props },
			})
			this.commit()
		},
	}

	/**
	 * Move one or more shapes to absolute world positions.
	 *
	 * Called continuously by the view during a drag with `persist: false`,
	 * then once on drag-end with `persist: true` — so the layout is written
	 * to `localStorage` once per gesture rather than on every pointer move.
	 *
	 * @param moves the shapes and their new top-left coordinates.
	 * @param persist whether to write the new layout to storage (drag end).
	 */
	moveShapes(
		moves: ReadonlyArray<{ id: string; x: number; y: number }>,
		persist: boolean
	): void {
		let changed = false
		for (const move of moves) {
			const existing = this.shapes.get(move.id)
			if (!existing) continue
			this.shapes.set(move.id, { ...existing, x: move.x, y: move.y })
			if (persist) this.savedPositions[move.id] = { x: move.x, y: move.y }
			changed = true
		}
		if (!changed) return
		if (persist) this.persistPositions()
		this.commit()
	}

	/** Rebuild the snapshot and notify subscribers. */
	private commit(): void {
		this.snapshot = Array.from(this.shapes.values())
		for (const listener of this.listeners) listener()
	}

	private loadPositions(): PositionMap {
		if (!this.workspaceId || typeof window === 'undefined') return {}
		try {
			const raw = window.localStorage.getItem(POSITION_KEY_PREFIX + this.workspaceId)
			return raw ? (JSON.parse(raw) as PositionMap) : {}
		} catch {
			return {}
		}
	}

	private persistPositions(): void {
		if (!this.workspaceId || typeof window === 'undefined') return
		try {
			window.localStorage.setItem(
				POSITION_KEY_PREFIX + this.workspaceId,
				JSON.stringify(this.savedPositions)
			)
		} catch {
			// localStorage unavailable (private mode / quota) — positions
			// simply will not survive a reload; non-fatal.
		}
	}
}
