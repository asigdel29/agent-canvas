/**
 * ConnectorStrip — top-left compact tile row of configured connectors.
 *
 * Per design review 21: third in the visual hierarchy, ambient. Status
 * dot conveys health; click opens the connector settings.
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
	return (
		<nav
			aria-label="Configured connectors"
			style={{
				position: 'fixed',
				top: 12,
				left: 12,
				display: 'flex',
				gap: 8,
				zIndex: 10,
			}}
		>
			{tiles.map((tile) => (
				<button
					key={tile.id}
					type="button"
					onClick={() => onClick(tile)}
					style={{
						display: 'inline-flex',
						alignItems: 'center',
						gap: 6,
						padding: '4px 10px',
						border: '1px solid var(--border)',
						borderRadius: 'var(--radius-md)',
						background: 'var(--surface-elev)',
						font: 'inherit',
						fontSize: 13,
						color: 'var(--text-strong)',
						cursor: 'pointer',
					}}
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
					{tile.label}
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
