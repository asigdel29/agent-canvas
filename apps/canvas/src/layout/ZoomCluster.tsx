/**
 * ZoomCluster — bottom-right of the canvas, again mirroring Figma.
 * Three pills horizontally: zoom-out, zoom percent, zoom-in.
 *
 * The cluster also carries the density toggle as a fourth pill —
 * agent-canvas-specific affordance for collapsing far-away shapes
 * down to dots (per the design doc's compact-on-zoom-out decision).
 *
 * Click on the percent itself opens a fit-to-screen menu (deferred;
 * the click handler is wired but the menu lives in a follow-up).
 * @author asigdel29
 */

import type { ReactNode } from 'react'

export interface ZoomClusterProps {
	readonly zoomPercent: number
	readonly onZoomIn?: () => void
	readonly onZoomOut?: () => void
	readonly onZoomFit?: () => void
	readonly density?: 'compact' | 'full'
	readonly onDensityToggle?: () => void
}

export function ZoomCluster({
	zoomPercent,
	onZoomIn,
	onZoomOut,
	onZoomFit,
	density = 'full',
	onDensityToggle,
}: ZoomClusterProps) {
	return (
		<div
			role="toolbar"
			aria-label="Zoom and density"
			style={{
				position: 'absolute',
				bottom: 'var(--space-3)',
				right: 'var(--space-3)',
				display: 'inline-flex',
				alignItems: 'center',
				gap: 4,
				padding: 4,
				background: 'var(--surface-elev)',
				border: '1px solid var(--border)',
				borderRadius: 'var(--radius-pill)',
				boxShadow: 'var(--shadow-floating)',
				zIndex: 'var(--z-floating)',
			}}
		>
			<Pill onClick={onZoomOut} label="Zoom out" shortcut="⌘ −">
				−
			</Pill>
			<Pill
				onClick={onZoomFit}
				label="Fit to screen"
				shortcut="⇧ 1"
				style={{ minWidth: 56, fontVariantNumeric: 'tabular-nums' }}
			>
				{Math.round(zoomPercent)}%
			</Pill>
			<Pill onClick={onZoomIn} label="Zoom in" shortcut="⌘ =">
				+
			</Pill>
			<Divider />
			<Pill
				onClick={onDensityToggle}
				label={`Density: ${density}`}
				shortcut="D"
				active={density === 'compact'}
			>
				{density === 'compact' ? '◦◦' : '⋯'}
			</Pill>
		</div>
	)
}

function Pill({
	children,
	onClick,
	label,
	shortcut,
	active = false,
	style,
}: {
	children: ReactNode
	onClick?: (() => void) | undefined
	label: string
	shortcut?: string | undefined
	active?: boolean
	style?: React.CSSProperties | undefined
}) {
	const title = shortcut ? `${label} (${shortcut})` : label
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			aria-label={title}
			aria-pressed={active}
			style={{
				height: 24,
				minWidth: 24,
				padding: '0 var(--space-2)',
				background: active ? 'var(--accent-soft)' : 'transparent',
				color: active ? 'var(--accent)' : 'var(--text-strong)',
				border: 'none',
				borderRadius: 'var(--radius-pill)',
				fontFamily: 'var(--font-ui)',
				fontSize: 'var(--font-12)',
				fontWeight: 500,
				cursor: 'pointer',
				display: 'inline-flex',
				alignItems: 'center',
				justifyContent: 'center',
				...style,
			}}
			onMouseEnter={(e) => {
				if (!active) e.currentTarget.style.background = 'var(--surface-overlay)'
			}}
			onMouseLeave={(e) => {
				if (!active) e.currentTarget.style.background = 'transparent'
			}}
		>
			{children}
		</button>
	)
}

function Divider() {
	return (
		<span
			aria-hidden="true"
			style={{
				width: 1,
				height: 14,
				background: 'var(--border)',
				margin: '0 2px',
			}}
		/>
	)
}
