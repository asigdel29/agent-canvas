/**
 * SpendIndicator — compute-budget pill, embedded in the TopBar's
 * right cluster. Previously a floating bottom-right banner; moved to
 * the top bar because spend is a primary fact about the workspace
 * (not an ambient afterthought) and the top bar is where workspace
 * facts live in Figma's vocabulary.
 *
 * Visual model: tabular-num figures inside a hairline-bordered pill,
 * a thin progress bar across the bottom, colour shifts to amber at
 * 80% and Framer pink at 100%. The pink reuses --live deliberately —
 * "out of budget" is the same kind of attention-demanding state as
 * "agent is running".
 * @author asigdel29
 */

export interface SpendIndicatorProps {
	readonly accrued_micros: number
	readonly ceiling_micros: number
}

/**
 * Plain text label for the spend, suitable for callers that want
 * just the number (e.g. the TopBar passing a plain string into a
 * generic pill slot).
 */
export function formatSpend(accrued_micros: number, ceiling_micros: number): string {
	return `${usd(accrued_micros)} / ${usd(ceiling_micros)}`
}

/**
 * Full pill with progress bar and colour state. Renders inline so it
 * fits inside the TopBar right cluster.
 */
export function SpendIndicator({ accrued_micros, ceiling_micros }: SpendIndicatorProps) {
	const fraction = ceiling_micros > 0 ? accrued_micros / ceiling_micros : 0
	const isOver = fraction >= 1
	const isWarn = fraction >= 0.8
	const accent = isOver
		? 'var(--live)'
		: isWarn
			? 'var(--status-await)'
			: 'var(--text-muted)'
	return (
		<div
			aria-label="Workspace spend"
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: 'var(--space-2)',
				height: 28,
				padding: '0 var(--space-3)',
				background: isOver ? 'var(--live-soft)' : 'var(--surface-sunk)',
				border: `1px solid ${isOver ? 'var(--live)' : 'var(--border)'}`,
				borderRadius: 'var(--radius-pill)',
				fontSize: 'var(--font-12)',
				fontFamily: 'var(--font-mono)',
				fontVariantNumeric: 'tabular-nums',
				color: accent,
			}}
		>
			<span>{formatSpend(accrued_micros, ceiling_micros)}</span>
			<ProgressTrack fraction={fraction} accent={accent} />
			{isOver && (
				<span style={{ fontFamily: 'var(--font-ui)', fontWeight: 500 }}>
					Over budget
				</span>
			)}
		</div>
	)
}

function ProgressTrack({ fraction, accent }: { fraction: number; accent: string }) {
	return (
		<span
			aria-hidden="true"
			style={{
				display: 'inline-block',
				width: 48,
				height: 3,
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
					transition: 'width var(--motion-card) var(--ease-default)',
				}}
			/>
		</span>
	)
}

function usd(micros: number): string {
	return `$${(micros / 1_000_000).toFixed(2)}`
}

// Backwards compatibility — older imports of `SpendBanner` continue to work.
export const SpendBanner = SpendIndicator
