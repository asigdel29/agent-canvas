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

import { summarizeCapabilities } from './capabilities.js'
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
	/**
	 * Capability flags serialized in tlschema-compatible primitives. We
	 * keep them flat rather than a nested object because tldraw's
	 * RecordProps validator chain is awkward to use with nested unions;
	 * the canvas-side capabilities.ts type does the reassembly.
	 */
	cap_computer_use: boolean
	cap_browser_use: boolean
	cap_mcp_server_ids: string[]
	/** One-line summary shown in the compact mode footer; recomputed on capability change. */
	cap_summary: string
	/**
	 * Most recent screenshot from a computer-use run, as a data: URI.
	 * Empty string means no screenshot yet. The shape renders a small
	 * thumbnail in the card when set.
	 */
	last_screenshot_data_uri: string
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
		cap_computer_use: T.boolean,
		cap_browser_use: T.boolean,
		cap_mcp_server_ids: T.arrayOf(T.string),
		cap_summary: T.string,
		last_screenshot_data_uri: T.string,
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
			h: 140,
			render_mode: 'full',
			cap_computer_use: false,
			cap_browser_use: false,
			cap_mcp_server_ids: [],
			cap_summary: 'no capabilities',
			last_screenshot_data_uri: '',
		}
	}

	override getGeometry(shape: AgentShape) {
		return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
	}

	override component(shape: AgentShape) {
		const isCompact = shape.props.render_mode === 'compact'
		const isCrossRoom = shape.props.origin_room_id !== shape.props.current_room_id
		const isRunning = shape.props.status === 'running'
		return (
			<HTMLContainer
				style={{
					display: 'flex',
					flexDirection: 'column',
					padding: 'var(--space-3)',
					border: `1px solid ${isRunning ? 'var(--live)' : 'var(--border)'}`,
					borderRadius: 'var(--radius-lg)',
					background: 'var(--surface-elev)',
					fontFamily: 'var(--font-ui)',
					color: 'var(--text-strong)',
					boxSizing: 'border-box',
					overflow: 'hidden',
					gap: 'var(--space-1)',
				}}
			>
				<header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
					<strong style={{ fontSize: 14, fontWeight: 500 }}>
						{shape.props.title || shape.props.run_id}
					</strong>
					<StatusBadge status={shape.props.status} />
				</header>
				{isCrossRoom && (
					<span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
						from {shape.props.origin_room_id}
					</span>
				)}
				{!isCompact && (
					<>
						<div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
							<span style={{ fontFamily: 'var(--font-mono)' }}>seq {shape.props.last_event_seq}</span>
							{shape.props.vendor && <span> · {shape.props.vendor}</span>}
						</div>
						<CapabilityRow shape={shape} />
						{shape.props.last_screenshot_data_uri && (
							<ScreenshotThumb dataUri={shape.props.last_screenshot_data_uri} />
						)}
					</>
				)}
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
		running: 'var(--live)',
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
	const isLive = status === 'running'
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
				background: isLive ? 'var(--live-soft)' : 'var(--surface-overlay)',
				color: colorMap[status],
			}}
		>
			{isLive && <span className="ac-live-dot" aria-hidden="true" />}
			{labelMap[status]}
		</span>
	)
}

/**
 * Inline row of capability chips rendered in non-compact mode. Each
 * chip uses the surface-overlay wash so they sit quietly under the
 * primary status badge. We deliberately do not render the row when
 * the agent has no capabilities — empty chrome is worse than no
 * chrome.
 */
function CapabilityRow({ shape }: { shape: AgentShape }) {
	const chips: { label: string; tone: 'neutral' | 'accent' | 'live' }[] = []
	if (shape.props.cap_computer_use) chips.push({ label: 'computer', tone: 'live' })
	if (shape.props.cap_browser_use) chips.push({ label: 'browser', tone: 'accent' })
	if (shape.props.cap_mcp_server_ids.length > 0) {
		chips.push({
			label:
				shape.props.cap_mcp_server_ids.length === 1
					? '1 MCP'
					: `${shape.props.cap_mcp_server_ids.length} MCPs`,
			tone: 'neutral',
		})
	}
	if (chips.length === 0) return null
	return (
		<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 'var(--space-1)' }}>
			{chips.map((c) => (
				<Chip key={c.label} tone={c.tone}>
					{c.label}
				</Chip>
			))}
		</div>
	)
}

/**
 * ScreenshotThumb — small live preview of the most recent
 * computer-use screenshot. Width fills the card; height is capped
 * so the shape stays compact. Pointer-events are disabled so the
 * image doesn't intercept canvas drags.
 */
function ScreenshotThumb({ dataUri }: { dataUri: string }) {
	return (
		<img
			src={dataUri}
			alt="Latest computer-use screenshot"
			draggable={false}
			style={{
				marginTop: 'var(--space-1)',
				width: '100%',
				maxHeight: 180,
				objectFit: 'cover',
				borderRadius: 'var(--radius-md)',
				border: '1px solid var(--border)',
				pointerEvents: 'none',
				background: 'var(--surface-sunk)',
			}}
		/>
	)
}

function Chip({
	tone,
	children,
}: {
	tone: 'neutral' | 'accent' | 'live'
	children: React.ReactNode
}) {
	const palette: Record<typeof tone, { bg: string; fg: string }> = {
		neutral: { bg: 'var(--surface-overlay)', fg: 'var(--text-muted)' },
		accent: { bg: 'var(--accent-soft)', fg: 'var(--accent)' },
		live: { bg: 'var(--live-soft)', fg: 'var(--live)' },
	}
	return (
		<span
			style={{
				padding: '1px 6px',
				borderRadius: 999,
				background: palette[tone].bg,
				color: palette[tone].fg,
				fontSize: 10,
				fontFamily: 'var(--font-mono)',
				fontWeight: 500,
				letterSpacing: 0.2,
			}}
		>
			{children}
		</span>
	)
}
