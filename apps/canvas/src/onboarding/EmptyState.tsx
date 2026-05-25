/**
 * EmptyState — first-run pane shown inside the canvas area when the
 * workspace has no connectors yet. Centered card, not a full-screen
 * takeover: the rails stay visible so the user understands the
 * shell while choosing a starter.
 *
 * Visual model: Framer-style card, hairline border, no shadow, eight
 * pixel radius. Four equal-width tiles in a 2x2 grid; each tile is a
 * pure white surface with a hairline border that turns accent-blue
 * on hover.
 */

export type StarterProvider = 'github' | 'linear' | 'slack' | 'vercel'

export interface EmptyStateProps {
	readonly onConnect: (provider: StarterProvider) => void
	/**
	 * Optional handler for the primary "Create your first agent"
	 * CTA. When supplied, the empty state shows the create-agent
	 * button as the top action and the connector tiles drop to a
	 * secondary "Or connect a tool" row. Without this prop, the
	 * empty state falls back to its original tiles-only layout.
	 */
	readonly onCreateAgent?: () => void
}

const TILES: { id: StarterProvider; label: string; tagline: string }[] = [
	{ id: 'github', label: 'GitHub', tagline: 'Issues, PRs, reviews' },
	{ id: 'linear', label: 'Linear', tagline: 'Issues and projects' },
	{ id: 'slack', label: 'Slack', tagline: 'Channels and threads' },
	{ id: 'vercel', label: 'Vercel', tagline: 'Deploys and previews' },
]

export function EmptyState({ onConnect, onCreateAgent }: EmptyStateProps) {
	const headline = onCreateAgent ? 'Drop your first agent' : 'Connect a tool to start'
	const sub = onCreateAgent
		? 'An agent is a Claude-driven worker that you wire to MCP servers, a browser, or a sandboxed desktop.'
		: 'You can add more after.'
	return (
		<div
			role="region"
			aria-label="Get started"
			style={{
				position: 'absolute',
				inset: 0,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				padding: 'var(--space-5)',
			}}
		>
			<div
				style={{
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					gap: 'var(--space-5)',
					maxWidth: 480,
				}}
			>
				<header style={{ textAlign: 'center', display: 'grid', gap: 6 }}>
					<h1
						style={{
							fontFamily: 'var(--font-display)',
							fontSize: 'var(--font-24)',
							fontWeight: 500,
							letterSpacing: -0.2,
							margin: 0,
						}}
					>
						{headline}
					</h1>
					<p
						style={{
							margin: 0,
							fontSize: 'var(--font-13)',
							color: 'var(--text-muted)',
							lineHeight: 1.5,
						}}
					>
						{sub}
					</p>
				</header>

				{/*
				 * Primary CTA: create an agent directly. Previously the
				 * EmptyState only offered connector tiles, leaving users
				 * who didn't have webhook secrets in a dead end. With
				 * onCreateAgent supplied, this becomes the primary path
				 * and the connector tiles drop to a secondary row.
				 */}
				{onCreateAgent && (
					<button
						type="button"
						onClick={onCreateAgent}
						style={{
							display: 'inline-flex',
							alignItems: 'center',
							justifyContent: 'center',
							gap: 'var(--space-2)',
							width: '100%',
							height: 44,
							padding: '0 var(--space-4)',
							background: 'var(--accent)',
							color: 'var(--text-on-accent)',
							border: 'none',
							borderRadius: 'var(--radius-md)',
							font: 'inherit',
							fontFamily: 'var(--font-ui)',
							fontSize: 'var(--font-14)',
							fontWeight: 500,
							cursor: 'pointer',
						}}
					>
						+ Create your first agent
					</button>
				)}

				{onCreateAgent && (
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 'var(--space-2)',
							color: 'var(--text-muted)',
							fontSize: 'var(--font-12)',
							width: '100%',
						}}
					>
						<span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
						<span>or wire a tool first</span>
						<span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
					</div>
				)}

				<div
					style={{
						display: 'grid',
						gridTemplateColumns: 'repeat(2, 1fr)',
						gap: 'var(--space-2)',
						width: '100%',
					}}
				>
					{TILES.map((tile) => (
						<Tile key={tile.id} {...tile} onClick={() => onConnect(tile.id)} />
					))}
				</div>
			</div>
		</div>
	)
}

function Tile({
	id,
	label,
	tagline,
	onClick,
}: {
	id: StarterProvider
	label: string
	tagline: string
	onClick: () => void
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			data-provider={id}
			style={{
				display: 'grid',
				gap: 4,
				justifyItems: 'flex-start',
				textAlign: 'left',
				padding: 'var(--space-3) var(--space-4)',
				background: 'var(--surface-elev)',
				border: '1px solid var(--border)',
				borderRadius: 'var(--radius-lg)',
				color: 'var(--text-strong)',
				font: 'inherit',
				fontFamily: 'var(--font-ui)',
				cursor: 'pointer',
				transition: 'border-color var(--motion-chip) var(--ease-default), background var(--motion-chip) var(--ease-default)',
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.borderColor = 'var(--accent)'
				e.currentTarget.style.background = 'var(--accent-soft)'
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.borderColor = 'var(--border)'
				e.currentTarget.style.background = 'var(--surface-elev)'
			}}
		>
			<span style={{ fontSize: 'var(--font-14)', fontWeight: 500 }}>{label}</span>
			<span style={{ fontSize: 'var(--font-12)', color: 'var(--text-muted)' }}>{tagline}</span>
		</button>
	)
}
