/**
 * EmptyState — first-run pane shown inside the canvas area when the
 * workspace has no agents or connectors. Centered card, not a
 * full-screen takeover: the rails stay visible so the user
 * understands the shell while choosing a starter.
 *
 * Three layout modes selected from props:
 *   1. With onPickStarter: starter agent gallery up top, then the
 *      'Create your first agent' CTA, then connector tiles. This
 *      is the post-DX-review layout — pick a template and go.
 *   2. With onCreateAgent only: CTA up top, then connector tiles.
 *   3. Neither: original connector-tiles-only layout (back-compat).
 * @author asigdel29
 */

import { STARTERS, type Starter } from '../agent/starterAgents.js'

export type StarterProvider = 'github'

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
	/**
	 * When supplied, the empty state shows a row of starter tiles
	 * above the create-agent CTA. Each tile is one of the predefined
	 * `STARTERS`; clicking a tile opens the New Agent modal pre-
	 * filled with that starter's draft.
	 */
	readonly onPickStarter?: (starter: Starter) => void
}

const TILES: { id: StarterProvider; label: string; tagline: string }[] = [
	{ id: 'github', label: 'GitHub', tagline: 'Issues, PRs, reviews' },
]

export function EmptyState({
	onConnect,
	onCreateAgent,
	onPickStarter,
}: EmptyStateProps) {
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
				 * Starter gallery — three pre-canned agent templates.
				 * Clicking one opens NewAgentModal pre-filled. The
				 * intent: most tinkerers don't know what an agent
				 * "should" look like; cloning a known-good template
				 * gets them past the blank-page problem.
				 */}
				{onPickStarter && (
					<div
						style={{
							display: 'grid',
							gridTemplateColumns: 'repeat(3, 1fr)',
							gap: 'var(--space-2)',
							width: '100%',
						}}
					>
						{STARTERS.map((starter) => (
							<StarterTile
								key={starter.id}
								starter={starter}
								onClick={() => onPickStarter(starter)}
							/>
						))}
					</div>
				)}

				{/*
				 * Primary CTA: create an agent directly (blank form).
				 * Sits below the starter tiles so the gallery is the
				 * first thing the user sees.
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
						{onPickStarter ? '+ Or start from blank' : '+ Create your first agent'}
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

/**
 * StarterTile — one entry in the starter agent gallery row.
 * Visual model matches the connector tiles below but uses an
 * emoji icon up top so a tinkerer can pattern-match what each
 * starter does in under a second.
 */
function StarterTile({
	starter,
	onClick,
}: {
	starter: Starter
	onClick: () => void
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			data-starter={starter.id}
			style={{
				display: 'grid',
				gap: 4,
				justifyItems: 'flex-start',
				textAlign: 'left',
				padding: 'var(--space-3)',
				background: 'var(--surface-elev)',
				border: '1px solid var(--border)',
				borderRadius: 'var(--radius-lg)',
				color: 'var(--text-strong)',
				font: 'inherit',
				fontFamily: 'var(--font-ui)',
				cursor: 'pointer',
				transition:
					'border-color var(--motion-chip) var(--ease-default), background var(--motion-chip) var(--ease-default)',
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
			<span style={{ fontSize: 20, lineHeight: 1 }} aria-hidden="true">
				{starter.icon}
			</span>
			<span style={{ fontSize: 'var(--font-13)', fontWeight: 500 }}>
				{starter.label}
			</span>
			<span style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>
				{starter.tagline}
			</span>
		</button>
	)
}
