/**
 * TopBar — workspace name on the left, collab/spend/share cluster on
 * the right. Mirrors Figma's persistent header in spatial layout.
 *
 *   [ ◇ Untitled workspace  · canvas / starter ]   [ $3.42 ] [ ●●● ] [ Share ▼ ]
 *
 * The left cluster doubles as a breadcrumb so the user always knows
 * which workspace, project, and run-board they are looking at. The
 * right cluster carries always-visible affordances: spend pill,
 * presence avatars, and the primary Share dropdown.
 *
 * The TopBar is presentation-only. Real wiring (rename, navigate,
 * invite collaborators, change billing) belongs to the consumer.
 */

import type { ReactNode } from 'react'

export interface TopBarProps {
	readonly workspaceName: string
	readonly breadcrumbs?: readonly string[]
	readonly presenceAvatars?: readonly { id: string; label: string; color: string }[]
	/**
	 * Spend pill content. Pass null to hide. A string renders inside
	 * a default neutral pill; a ReactNode renders verbatim so callers
	 * can provide a richer component (e.g. SpendIndicator with progress
	 * bar and colour state).
	 */
	readonly spend?: ReactNode | string | null
	readonly onShareClick?: () => void
}

export function TopBar({
	workspaceName,
	breadcrumbs = [],
	presenceAvatars = [],
	spend = null,
	onShareClick,
}: TopBarProps) {
	return (
		<div
			style={{
				display: 'grid',
				gridTemplateColumns: '1fr auto',
				alignItems: 'center',
				height: '100%',
				padding: '0 var(--space-3)',
				gap: 'var(--space-3)',
			}}
		>
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 'var(--space-2)',
					fontSize: 'var(--font-13)',
					color: 'var(--text-strong)',
					minWidth: 0,
				}}
			>
				<WorkspaceMark />
				<span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{workspaceName}</span>
				{breadcrumbs.map((crumb, i) => (
					<span key={`${i}:${crumb}`} style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
						<span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>
							/
						</span>
						<span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{crumb}</span>
					</span>
				))}
			</div>

			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 'var(--space-2)',
				}}
			>
				{spend !== null && spend !== undefined && (
					typeof spend === 'string' ? <SpendPill text={spend} /> : spend
				)}
				{presenceAvatars.length > 0 && <PresenceStack avatars={presenceAvatars} />}
				<ShareButton onClick={onShareClick} />
			</div>
		</div>
	)
}

/** Tiny diamond mark; placeholder for a real logo. */
function WorkspaceMark() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			aria-hidden="true"
			style={{ display: 'block', flexShrink: 0 }}
		>
			<rect x="2" y="2" width="12" height="12" transform="rotate(45 8 8)" fill="var(--text-strong)" />
		</svg>
	)
}

function SpendPill({ text }: { text: string }) {
	return (
		<div
			aria-label="Workspace spend"
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: 'var(--space-1)',
				height: 28,
				padding: '0 var(--space-3)',
				background: 'var(--surface-sunk)',
				border: '1px solid var(--border)',
				borderRadius: 'var(--radius-pill)',
				fontSize: 'var(--font-12)',
				fontVariantNumeric: 'tabular-nums',
				color: 'var(--text-strong)',
			}}
		>
			{text}
		</div>
	)
}

function PresenceStack({ avatars }: { avatars: readonly { id: string; label: string; color: string }[] }) {
	const visible = avatars.slice(0, 3)
	const overflow = avatars.length - visible.length
	return (
		<div
			aria-label="Active collaborators"
			style={{
				display: 'inline-flex',
				alignItems: 'center',
			}}
		>
			{visible.map((a, i) => (
				<span
					key={a.id}
					title={a.label}
					aria-label={a.label}
					style={{
						width: 24,
						height: 24,
						borderRadius: '50%',
						background: a.color,
						color: '#FFFFFF',
						fontSize: 11,
						fontWeight: 500,
						display: 'inline-flex',
						alignItems: 'center',
						justifyContent: 'center',
						border: '2px solid var(--surface-elev)',
						marginLeft: i === 0 ? 0 : -6,
					}}
				>
					{a.label.charAt(0).toUpperCase()}
				</span>
			))}
			{overflow > 0 && (
				<span
					style={{
						width: 24,
						height: 24,
						borderRadius: '50%',
						background: 'var(--surface-sunk)',
						color: 'var(--text-muted)',
						fontSize: 11,
						fontWeight: 500,
						display: 'inline-flex',
						alignItems: 'center',
						justifyContent: 'center',
						border: '2px solid var(--surface-elev)',
						marginLeft: -6,
					}}
				>
					+{overflow}
				</span>
			)}
		</div>
	)
}

function ShareButton({ onClick }: { onClick?: (() => void) | undefined }) {
	return (
		<button
			type="button"
			onClick={onClick}
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: 'var(--space-1)',
				height: 28,
				padding: '0 var(--space-3)',
				background: 'var(--accent)',
				color: 'var(--text-on-accent)',
				border: 'none',
				borderRadius: 'var(--radius-md)',
				fontSize: 'var(--font-12)',
				fontWeight: 500,
				font: 'inherit',
				fontFamily: 'var(--font-ui)',
				cursor: 'pointer',
			}}
		>
			Share
		</button>
	)
}
