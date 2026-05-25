/**
 * ErrorToast — stacked, structured error cards in the bottom-left
 * corner of the canvas.
 *
 * Previously the app surfaced errors via a single raw string toast
 * ("Failed to create agent: [502 anthropic_not_configured]"). That
 * gave the user a code without a remediation path. This component
 * replaces that with the three-tier error pattern from the DX
 * review:
 *
 *   1. Problem    — what the user can't do, in plain English
 *   2. Cause      — why it failed, with the relevant identifier
 *   3. Fix        — one button that takes them to the resolution
 *
 * Cards stack newest-on-top. Each carries its own id so the parent
 * can dismiss by id. Auto-dismiss is intentionally OFF — errors
 * remain until the user acknowledges them, because the worst UX is
 * an error flashing past while the user looks elsewhere.
 *
 * Severity:
 *   warn  — amber border. Capability degradation (e.g. computer-use
 *           unavailable). The run still works without it.
 *   error — live-pink border. The action failed; user input needed.
 *
 * Position is fixed to the canvas viewport, not the app viewport,
 * so the toast doesn't overlap the RightRail.
 */

import type { ReactNode } from 'react'

export interface ErrorAction {
	readonly label: string
	readonly onClick: () => void
}

export interface ErrorCard {
	readonly id: string
	readonly title: string
	readonly cause: ReactNode
	readonly fix?: ErrorAction | undefined
	readonly docsUrl?: string | undefined
	readonly severity?: 'warn' | 'error' | undefined
}

export interface ErrorToastProps {
	readonly cards: readonly ErrorCard[]
	readonly onDismiss: (id: string) => void
}

export function ErrorToast({ cards, onDismiss }: ErrorToastProps) {
	if (cards.length === 0) return null
	return (
		<aside
			role="alert"
			aria-live="polite"
			style={{
				position: 'fixed',
				bottom: 'var(--space-3)',
				left: 'var(--space-3)',
				display: 'flex',
				flexDirection: 'column-reverse',
				gap: 'var(--space-2)',
				zIndex: 'var(--z-floating)',
				maxWidth: 380,
			}}
		>
			{cards.map((card) => (
				<Card key={card.id} card={card} onDismiss={onDismiss} />
			))}
		</aside>
	)
}

function Card({
	card,
	onDismiss,
}: {
	card: ErrorCard
	onDismiss: (id: string) => void
}) {
	const severity = card.severity ?? 'error'
	const accent = severity === 'warn' ? 'var(--status-await)' : 'var(--live)'
	const wash = severity === 'warn' ? 'rgba(245, 158, 11, 0.10)' : 'var(--live-soft)'
	return (
		<div
			style={{
				display: 'grid',
				gridTemplateColumns: '1fr auto',
				gap: 'var(--space-2)',
				padding: 'var(--space-3)',
				background: wash,
				border: `1px solid ${accent}`,
				borderRadius: 'var(--radius-md)',
				boxShadow: 'var(--shadow-floating)',
				color: 'var(--text-strong)',
				fontSize: 'var(--font-12)',
				lineHeight: 1.5,
			}}
		>
			<div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
				<strong style={{ fontSize: 'var(--font-13)' }}>{card.title}</strong>
				<div style={{ color: 'var(--text-muted)' }}>{card.cause}</div>
				{(card.fix || card.docsUrl) && (
					<div
						style={{
							display: 'flex',
							gap: 'var(--space-3)',
							marginTop: 4,
							alignItems: 'center',
						}}
					>
						{card.fix && (
							<button
								type="button"
								onClick={card.fix.onClick}
								style={{
									background: 'transparent',
									border: 'none',
									padding: 0,
									color: accent,
									fontFamily: 'var(--font-ui)',
									font: 'inherit',
									fontSize: 'var(--font-12)',
									fontWeight: 500,
									textDecoration: 'underline',
									cursor: 'pointer',
								}}
							>
								{card.fix.label} →
							</button>
						)}
						{card.docsUrl && (
							<a
								href={card.docsUrl}
								target="_blank"
								rel="noreferrer noopener"
								style={{
									color: 'var(--text-muted)',
									fontSize: 'var(--font-12)',
									textDecoration: 'underline',
								}}
							>
								Docs
							</a>
						)}
					</div>
				)}
			</div>
			<button
				type="button"
				onClick={() => onDismiss(card.id)}
				aria-label="Dismiss"
				style={{
					alignSelf: 'flex-start',
					width: 20,
					height: 20,
					padding: 0,
					background: 'transparent',
					border: 'none',
					color: 'var(--text-muted)',
					cursor: 'pointer',
					fontSize: 14,
					lineHeight: 1,
				}}
			>
				×
			</button>
		</div>
	)
}
