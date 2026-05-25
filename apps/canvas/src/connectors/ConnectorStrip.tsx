/**
 * ConnectorStrip — list of configured connectors. Now lives as a
 * section inside the LeftRail (below the workflows list). Previously
 * a floating top-left chip strip; moved into the rail so the chrome
 * stays out of the canvas itself, matching Figma's "navigation is in
 * the rail, canvas is uncluttered" rule.
 *
 * Each row: status dot + label, with hover + click handlers. The
 * status dot reuses the run-state palette so the visual vocabulary
 * stays consistent ("green = healthy, amber = needs attention, red
 * = broken") across both connectors and runs.
 */

export interface ConnectorTile {
	readonly id: string
	readonly label: string
	readonly status: 'connected' | 'reconnect_needed' | 'error'
}

export interface ConnectorStripProps {
	readonly tiles: readonly ConnectorTile[]
	readonly onClick: (tile: ConnectorTile) => void
}

export function ConnectorStrip({ tiles, onClick }: ConnectorStripProps) {
	if (tiles.length === 0) return null
	return (
		<nav
			aria-label="Configured connectors"
			style={{
				borderTop: '1px solid var(--border)',
				padding: 'var(--space-2) 0',
			}}
		>
			<header
				style={{
					padding: '2px var(--space-3) 6px',
					fontSize: 11,
					fontWeight: 500,
					color: 'var(--text-muted)',
					textTransform: 'uppercase',
					letterSpacing: 0.6,
				}}
			>
				Connectors · {tiles.length}
			</header>
			{tiles.map((tile) => (
				<button
					key={tile.id}
					type="button"
					onClick={() => onClick(tile)}
					style={{
						display: 'grid',
						gridTemplateColumns: 'auto 1fr auto',
						alignItems: 'center',
						gap: 'var(--space-2)',
						width: '100%',
						padding: '6px var(--space-3)',
						border: 'none',
						background: 'transparent',
						color: 'var(--text-strong)',
						font: 'inherit',
						fontFamily: 'var(--font-ui)',
						fontSize: 'var(--font-13)',
						textAlign: 'left',
						cursor: 'pointer',
					}}
					onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-overlay)')}
					onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
				>
					<span
						aria-hidden="true"
						style={{
							width: 6,
							height: 6,
							borderRadius: '50%',
							background: dotColor(tile.status),
						}}
					/>
					<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
						{tile.label}
					</span>
					{tile.status !== 'connected' && (
						<span
							style={{
								fontSize: 11,
								color: tile.status === 'error' ? 'var(--status-fail)' : 'var(--status-await)',
							}}
						>
							{tile.status === 'error' ? 'error' : 'reconnect'}
						</span>
					)}
				</button>
			))}
		</nav>
	)
}

function dotColor(status: ConnectorTile['status']): string {
	switch (status) {
		case 'connected':
			return 'var(--status-succ)'
		case 'reconnect_needed':
			return 'var(--status-await)'
		case 'error':
			return 'var(--status-fail)'
	}
}
