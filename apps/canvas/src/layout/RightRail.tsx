/**
 * RightRail — Figma's contextual inspector. Three modes:
 *
 *   inspector  An item is selected on the canvas. Render its
 *              fields (run id, status, last event, vendor, output).
 *   activity   Nothing selected. Show the live event feed plus any
 *              pending approvals as an inbox.
 *   empty      Nothing selected AND nothing happening. Render the
 *              copy that explains what the rail will show once
 *              there is.
 *
 * The mode is computed by the parent (App) from {selectedId,
 * liveEvents.length, approvals.length}. This component is pure
 * presentation — it takes the chosen mode and the data it needs.
 * @author asigdel29
 */

import type { ReactNode } from 'react'
import type { RunEventPayload } from '../sync/RoomEventClient.js'

export type RightRailMode = 'inspector' | 'activity' | 'settings' | 'empty'

export interface RightRailProps {
	readonly mode: RightRailMode
	readonly inspectorContent?: ReactNode
	readonly activityEvents?: readonly RunEventPayload[]
	readonly approvalsContent?: ReactNode
	readonly settingsContent?: ReactNode
}

export function RightRail({
	mode,
	inspectorContent,
	activityEvents = [],
	approvalsContent,
	settingsContent,
}: RightRailProps) {
	return (
		<>
			<RailHeader mode={mode} />
			<div style={{ flex: 1, overflowY: 'auto' }}>
				{mode === 'inspector' && inspectorContent}
				{mode === 'activity' && (
					<>
						{approvalsContent}
						<ActivityFeed events={activityEvents} />
					</>
				)}
				{mode === 'settings' && settingsContent}
				{mode === 'empty' && <EmptyInspector />}
			</div>
		</>
	)
}

function RailHeader({ mode }: { mode: RightRailMode }) {
	const label =
		mode === 'inspector'
			? 'Inspector'
			: mode === 'activity'
				? 'Activity'
				: mode === 'settings'
					? 'Settings'
					: 'Inspector'
	return (
		<div
			style={{
				padding: 'var(--space-2) var(--space-3)',
				borderBottom: '1px solid var(--border)',
				fontSize: 'var(--font-12)',
				fontWeight: 500,
				color: 'var(--text-muted)',
				textTransform: 'uppercase',
				letterSpacing: 0.6,
			}}
		>
			{label}
		</div>
	)
}

function EmptyInspector() {
	return (
		<div
			style={{
				padding: 'var(--space-5) var(--space-3)',
				color: 'var(--text-muted)',
				fontSize: 'var(--font-12)',
				lineHeight: 1.5,
			}}
		>
			Select an agent on the canvas to see its run details, recent events, and output.
			Approvals and live events also appear here.
		</div>
	)
}

function ActivityFeed({ events }: { events: readonly RunEventPayload[] }) {
	if (events.length === 0) {
		return (
			<div
				style={{
					padding: 'var(--space-4) var(--space-3)',
					fontSize: 'var(--font-12)',
					color: 'var(--text-muted)',
				}}
			>
				No live events yet.
			</div>
		)
	}
	return (
		<div role="log" aria-label="Live events" aria-live="polite">
			<SectionLabel>Live · {events.length}</SectionLabel>
			{events.slice(-30).reverse().map((e, i) => (
				<EventRow key={`${e.run_id}:${e.seq}:${i}`} event={e} />
			))}
		</div>
	)
}

function EventRow({ event }: { event: RunEventPayload }) {
	const isFailed = event.kind === 'failed'
	const isRunning = event.kind === 'running' || event.kind === 'progress'
	return (
		<div
			style={{
				display: 'grid',
				gridTemplateColumns: 'auto 1fr auto',
				gap: 'var(--space-2)',
				alignItems: 'center',
				padding: '6px var(--space-3)',
				borderBottom: '1px solid var(--border)',
				fontSize: 'var(--font-12)',
			}}
		>
			{isRunning ? (
				<span className="ac-live-dot" aria-label="live" />
			) : (
				<span
					aria-hidden="true"
					style={{
						width: 6,
						height: 6,
						borderRadius: '50%',
						background: isFailed ? 'var(--status-fail)' : 'var(--status-succ)',
					}}
				/>
			)}
			<span
				style={{
					display: 'grid',
					gap: 2,
					minWidth: 0,
				}}
			>
				<span
					style={{
						fontFamily: 'var(--font-mono)',
						fontSize: 11,
						color: 'var(--text-muted)',
					}}
				>
					{event.run_id.slice(-8)}
					{event.vendor && ` · ${event.vendor}`}
				</span>
				<span
					style={{
						color: isFailed ? 'var(--status-fail)' : 'var(--text-strong)',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
					}}
				>
					{event.kind}
				</span>
			</span>
			<span
				style={{
					fontFamily: 'var(--font-mono)',
					fontSize: 11,
					color: 'var(--text-muted)',
					fontVariantNumeric: 'tabular-nums',
				}}
			>
				#{event.seq}
			</span>
		</div>
	)
}

function SectionLabel({ children }: { children: ReactNode }) {
	return (
		<div
			style={{
				padding: 'var(--space-2) var(--space-3)',
				fontSize: 11,
				fontWeight: 500,
				color: 'var(--text-muted)',
				textTransform: 'uppercase',
				letterSpacing: 0.6,
			}}
		>
			{children}
		</div>
	)
}
