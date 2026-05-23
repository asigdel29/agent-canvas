/**
 * SpendBanner — bottom-right ambient compute-budget banner.
 *
 * Per design review 21 and the billing-gate (orchestrator) plan
 * addition: amber at 80%, red and "Budget reached" at 100%. Bottom-
 * right placement keeps it out of the way of the top-right inbox stack.
 */

export interface SpendBannerProps {
	readonly accrued_micros: number
	readonly ceiling_micros: number
}

export function SpendBanner({ accrued_micros, ceiling_micros }: SpendBannerProps) {
	const fraction = ceiling_micros > 0 ? accrued_micros / ceiling_micros : 0
	const accent = bannerColor(fraction)
	return (
		<aside
			aria-label="Spend"
			style={{
				position: 'fixed',
				bottom: 12,
				right: 12,
				display: 'flex',
				alignItems: 'center',
				gap: 8,
				padding: '6px 12px',
				border: '1px solid var(--border)',
				borderRadius: 'var(--radius-md)',
				background: 'var(--surface-elev)',
				color: accent,
				fontFamily: 'var(--font-mono)',
				fontSize: 12,
				zIndex: 10,
			}}
		>
			<span>
				{usd(accrued_micros)} / {usd(ceiling_micros)} today
			</span>
			<span
				aria-hidden="true"
				style={{
					width: 60,
					height: 4,
					borderRadius: 2,
					background: 'var(--border)',
					overflow: 'hidden',
					position: 'relative',
				}}
			>
				<span
					style={{
						display: 'block',
						width: `${Math.min(100, fraction * 100)}%`,
						height: '100%',
						background: accent,
					}}
				/>
			</span>
			{fraction >= 1 ? <span style={{ color: 'var(--status-fail)' }}>Budget reached</span> : null}
		</aside>
	)
}

function usd(micros: number): string {
	return `$${(micros / 1_000_000).toFixed(2)}`
}

function bannerColor(fraction: number): string {
	if (fraction >= 1) return 'var(--status-fail)'
	if (fraction >= 0.8) return 'var(--status-await)'
	return 'var(--text-muted)'
}
