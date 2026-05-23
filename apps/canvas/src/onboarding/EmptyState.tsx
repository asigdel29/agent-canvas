/**
 * EmptyState — first-run E1 (no connectors yet).
 *
 * Per design review 22: centered "Connect a tool to start" + 4 tiles
 * (GitHub, Linear, Slack, Vercel). Subtitle: "You can add more after."
 */

export type StarterProvider = 'github' | 'linear' | 'slack' | 'vercel'

export interface EmptyStateProps {
	readonly onConnect: (provider: StarterProvider) => void
}

const TILES: { id: StarterProvider; label: string }[] = [
	{ id: 'github', label: 'GitHub' },
	{ id: 'linear', label: 'Linear' },
	{ id: 'slack', label: 'Slack' },
	{ id: 'vercel', label: 'Vercel' },
]

export function EmptyState({ onConnect }: EmptyStateProps) {
	return (
		<div
			role="region"
			aria-label="Get started"
			style={{
				position: 'absolute',
				inset: 0,
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				justifyContent: 'center',
				gap: 24,
				color: 'var(--text-strong)',
				background: 'var(--surface)',
			}}
		>
			<h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 500, margin: 0 }}>
				Connect a tool to start
			</h1>
			<div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 160px)', gap: 12 }}>
				{TILES.map((tile) => (
					<button
						key={tile.id}
						type="button"
						onClick={() => onConnect(tile.id)}
						style={{
							padding: 24,
							border: '1px solid var(--border)',
							borderRadius: 'var(--radius-lg)',
							background: 'var(--surface-elev)',
							font: 'inherit',
							fontSize: 16,
							fontWeight: 500,
							color: 'var(--text-strong)',
							cursor: 'pointer',
						}}
					>
						{tile.label}
					</button>
				))}
			</div>
			<p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
				You can add more after.
			</p>
		</div>
	)
}
