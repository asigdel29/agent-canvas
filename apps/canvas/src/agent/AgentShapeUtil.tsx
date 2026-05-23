/**
 * AgentShapeUtil — custom tldraw shape for an agent run.
 *
 * The agent shape on the canvas is a projection of the authoritative
 * run living in the orchestrator. Its props mirror ProjectedRunRecord
 * from @agent-canvas/orchestrator-types. The shape's child event nodes
 * are NOT a sub-shape hierarchy; they're separate AgentEventShape
 * instances connected by edges (kept simple for Phase 1).
 *
 * Render mode (full | compact) is decided by density.ts and applied at
 * the render-tree level — the shape doesn't own that decision.
 */

import {
	HTMLContainer,
	Rectangle2d,
	type RecordProps,
	ShapeUtil,
	type TLBaseShape,
	T,
} from 'tldraw'

import type { RenderMode } from './density.js'

export interface AgentShapeProps {
	run_id: string
	status:
		| 'queued'
		| 'provisioning'
		| 'running'
		| 'awaiting_input'
		| 'succeeded'
		| 'failed'
		| 'cancelled'
		| 'unreachable'
	title: string
	vendor: string | null
	origin_room_id: string
	current_room_id: string
	last_event_seq: number
	last_event_at: string
	w: number
	h: number
	render_mode: RenderMode
}

export type AgentShape = TLBaseShape<'agent', AgentShapeProps>

// Register the custom shape with tldraw's type registry. tldraw v5 maps
// `TLShape` from `TLGlobalShapePropsMap`, an empty interface designed for
// declaration-merging. Adding `agent: AgentShapeProps` makes ShapeUtil<AgentShape>
// satisfy the abstract class's `Shape extends TLShape` constraint.
declare module '@tldraw/tlschema' {
	interface TLGlobalShapePropsMap {
		agent: AgentShapeProps
	}
}

const STATUS_VALUES = [
	'queued',
	'provisioning',
	'running',
	'awaiting_input',
	'succeeded',
	'failed',
	'cancelled',
	'unreachable',
] as const

export class AgentShapeUtil extends ShapeUtil<AgentShape> {
	static override type = 'agent' as const

	static override props: RecordProps<AgentShape> = {
		run_id: T.string,
		status: T.literalEnum(...STATUS_VALUES),
		title: T.string,
		vendor: T.string.nullable(),
		origin_room_id: T.string,
		current_room_id: T.string,
		last_event_seq: T.number,
		last_event_at: T.string,
		w: T.nonZeroNumber,
		h: T.nonZeroNumber,
		render_mode: T.literalEnum('full', 'compact'),
	}

	override getDefaultProps(): AgentShape['props'] {
		return {
			run_id: '',
			status: 'queued',
			title: '',
			vendor: null,
			origin_room_id: '',
			current_room_id: '',
			last_event_seq: 0,
			last_event_at: new Date().toISOString(),
			w: 320,
			h: 120,
			render_mode: 'full',
		}
	}

	override getGeometry(shape: AgentShape) {
		return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
	}

	override component(shape: AgentShape) {
		const isCompact = shape.props.render_mode === 'compact'
		const isCrossRoom = shape.props.origin_room_id !== shape.props.current_room_id
		return (
			<HTMLContainer
				style={{
					display: 'flex',
					flexDirection: 'column',
					padding: 'var(--space-3)',
					border: '1px solid var(--border)',
					borderRadius: 'var(--radius-lg)',
					background: 'var(--surface-elev)',
					fontFamily: 'var(--font-ui)',
					color: 'var(--text-strong)',
					boxSizing: 'border-box',
					overflow: 'hidden',
				}}
			>
				<header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
					<strong style={{ fontSize: 14, fontWeight: 500 }}>{shape.props.title || shape.props.run_id}</strong>
					<StatusBadge status={shape.props.status} />
				</header>
				{isCrossRoom ? (
					<span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 'var(--space-1)' }}>
						from {shape.props.origin_room_id}
					</span>
				) : null}
				{!isCompact ? (
					<div style={{ marginTop: 'var(--space-2)', fontSize: 12, color: 'var(--text-muted)' }}>
						<span style={{ fontFamily: 'var(--font-mono)' }}>seq {shape.props.last_event_seq}</span>
						{shape.props.vendor ? <span> · {shape.props.vendor}</span> : null}
					</div>
				) : null}
			</HTMLContainer>
		)
	}

	override getIndicatorPath(shape: AgentShape) {
		const path = new Path2D()
		path.roundRect(0, 0, shape.props.w, shape.props.h, 12)
		return path
	}
}

function StatusBadge({ status }: { status: AgentShape['props']['status'] }) {
	const colorMap: Record<AgentShape['props']['status'], string> = {
		queued: 'var(--text-muted)',
		provisioning: 'var(--text-muted)',
		running: 'var(--text-strong)',
		awaiting_input: 'var(--status-await)',
		succeeded: 'var(--status-succ)',
		failed: 'var(--status-fail)',
		cancelled: 'var(--text-muted)',
		unreachable: 'var(--status-unreach)',
	}
	const labelMap: Record<AgentShape['props']['status'], string> = {
		queued: 'Queued',
		provisioning: 'Provisioning',
		running: 'Running',
		awaiting_input: 'Awaiting input',
		succeeded: 'Succeeded',
		failed: 'Failed',
		cancelled: 'Cancelled',
		unreachable: 'Unreachable',
	}
	return (
		<span
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: 4,
				padding: '2px 8px',
				borderRadius: 999,
				fontSize: 11,
				fontWeight: 500,
				background: 'rgba(0,0,0,0.04)',
				color: colorMap[status],
			}}
		>
			{labelMap[status]}
		</span>
	)
}
