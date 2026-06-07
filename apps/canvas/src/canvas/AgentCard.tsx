/**
 * AgentCard — the visual representation of an agent on the canvas.
 *
 * Pure presentation: it renders the supplied {@link AgentShapeProps} and
 * owns no canvas state. The view positions and sizes the card; this
 * component fills that box. `renderMode` (decided by the density rule)
 * collapses the card to a compact header when the canvas is busy.
 *
 * @author asigdel29
 */

import type { RenderMode } from '../agent/density.js'
import type { AgentShapeProps, AgentStatus } from './agentShape.js'

export interface AgentCardProps {
	readonly props: AgentShapeProps
	/** Effective density mode for this card (overrides `props.render_mode`). */
	readonly renderMode: RenderMode
	/** Whether the card is part of the current selection. */
	readonly selected: boolean
}

/** Render an agent card filling its positioned container. */
export function AgentCard({ props, renderMode, selected }: AgentCardProps) {
	const isCompact = renderMode === 'compact'
	const isCrossRoom = props.origin_room_id !== props.current_room_id
	const isRunning = props.status === 'running'
	return (
		<div
			style={{
				width: '100%',
				height: '100%',
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
				outline: selected ? '2px solid var(--accent)' : 'none',
				outlineOffset: 2,
				boxShadow: selected ? 'var(--shadow-popover)' : 'none',
			}}
		>
			<header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
				<strong style={{ fontSize: 14, fontWeight: 500 }}>{props.title || props.run_id}</strong>
				<StatusBadge status={props.status} />
			</header>
			{isCrossRoom && (
				<span style={{ fontSize: 11, color: 'var(--text-muted)' }}>from {props.origin_room_id}</span>
			)}
			{!isCompact && (
				<>
					<div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
						<span style={{ fontFamily: 'var(--font-mono)' }}>seq {props.last_event_seq}</span>
						{props.vendor && <span> · {props.vendor}</span>}
					</div>
					<CapabilityRow props={props} />
					{props.last_screenshot_data_uri && (
						<ScreenshotThumb dataUri={props.last_screenshot_data_uri} />
					)}
				</>
			)}
		</div>
	)
}

/** Coloured status pill with a live dot while the agent is running. */
function StatusBadge({ status }: { status: AgentStatus }) {
	const colorMap: Record<AgentStatus, string> = {
		queued: 'var(--text-muted)',
		provisioning: 'var(--text-muted)',
		running: 'var(--live)',
		awaiting_input: 'var(--status-await)',
		succeeded: 'var(--status-succ)',
		failed: 'var(--status-fail)',
		cancelled: 'var(--text-muted)',
		unreachable: 'var(--status-unreach)',
	}
	const labelMap: Record<AgentStatus, string> = {
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
 * Inline row of capability chips, rendered only when the agent has at
 * least one capability — empty chrome is worse than no chrome.
 */
function CapabilityRow({ props }: { props: AgentShapeProps }) {
	const chips: { label: string; tone: 'neutral' | 'accent' | 'live' }[] = []
	if (props.cap_computer_use) chips.push({ label: 'computer', tone: 'live' })
	if (props.cap_browser_use) chips.push({ label: 'browser', tone: 'accent' })
	if (props.cap_mcp_server_ids.length > 0) {
		chips.push({
			label: props.cap_mcp_server_ids.length === 1 ? '1 MCP' : `${props.cap_mcp_server_ids.length} MCPs`,
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
 * Small live preview of the most recent computer-use screenshot. Pointer
 * events are disabled so the image never intercepts a canvas drag.
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

/** Tiny pill badge whose tone controls its colour wash. */
function Chip({ tone, children }: { tone: 'neutral' | 'accent' | 'live'; children: string }) {
	const toneMap = {
		neutral: { bg: 'var(--surface-overlay)', fg: 'var(--text-muted)' },
		accent: { bg: 'var(--accent-soft)', fg: 'var(--accent)' },
		live: { bg: 'var(--live-soft)', fg: 'var(--live)' },
	}
	const c = toneMap[tone]
	return (
		<span
			style={{
				padding: '1px 6px',
				borderRadius: 999,
				fontSize: 10,
				fontFamily: 'var(--font-mono)',
				fontWeight: 500,
				letterSpacing: 0.2,
				background: c.bg,
				color: c.fg,
			}}
		>
			{children}
		</span>
	)
}
