/**
 * LiveEvents — bottom-left panel showing the most recent orchestration
 * events streaming in over SSE.
 *
 * Useful as a Phase 2 demo: a teammate can watch the panel and see the
 * agent's run unfold. Phase 3 folds these into the AgentShape's
 * event-graph children directly.
 */

import type { RunEventPayload } from './RoomEventClient.js'

export interface LiveEventsProps {
	readonly events: readonly RunEventPayload[]
}

export function LiveEvents({ events }: LiveEventsProps) {
	if (events.length === 0) return null
	return (
		<aside
			aria-label="Recent orchestration events"
			style={{
				position: 'fixed',
				bottom: 12,
				left: 12,
				width: 320,
				maxHeight: 240,
				overflowY: 'auto',
				padding: '8px 10px',
				border: '1px solid var(--border)',
				borderRadius: 'var(--radius-md)',
				background: 'var(--surface-elev)',
				fontFamily: 'var(--font-mono)',
				fontSize: 11,
				color: 'var(--text-strong)',
				zIndex: 10,
			}}
		>
			<header
				style={{
					marginBottom: 6,
					color: 'var(--text-muted)',
					fontFamily: 'var(--font-ui)',
					fontSize: 11,
					textTransform: 'uppercase',
					letterSpacing: 0.6,
				}}
			>
				Live · {events.length}
			</header>
			{events.slice(-10).reverse().map((e, i) => (
				<div
					key={`${e.run_id}:${e.seq}:${i}`}
					style={{
						display: 'grid',
						gridTemplateColumns: '52px 64px 1fr',
						gap: 6,
						padding: '2px 0',
						color: e.kind === 'failed' ? 'var(--status-fail)' : 'var(--text-strong)',
					}}
				>
					<span style={{ color: 'var(--text-muted)' }}>{e.run_id.slice(-6)}</span>
					<span>{e.kind}</span>
					<span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
						seq {e.seq}
					</span>
				</div>
			))}
		</aside>
	)
}
