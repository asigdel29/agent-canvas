/**
 * FloatingToolbar — the top-center cluster, mirroring Figma's
 * primary tool strip. Sits absolutely above the canvas, never inside
 * the canvas's own coordinate space.
 *
 * One tool at a time can be "active" (highlighted). The active
 * decision is the caller's — this component renders whatever it is
 * told and surfaces clicks. Doug Lea purpose-first: every prop has
 * exactly one job.
 *
 * Each button is keyboard-focusable. The active state uses the
 * accent-soft tint plus the accent ring; hover uses surface-overlay.
 */

import type { ReactNode } from 'react'

export interface ToolbarTool {
	readonly id: string
	readonly label: string
	readonly shortcut?: string
	readonly icon: ReactNode
}

export interface FloatingToolbarProps {
	readonly tools: readonly ToolbarTool[]
	readonly activeId?: string | null
	readonly onSelect?: (id: string) => void
}

export function FloatingToolbar({ tools, activeId = null, onSelect }: FloatingToolbarProps) {
	return (
		<div
			role="toolbar"
			aria-label="Canvas tools"
			style={{
				position: 'absolute',
				top: 'var(--space-3)',
				left: '50%',
				transform: 'translateX(-50%)',
				display: 'inline-flex',
				alignItems: 'center',
				gap: 2,
				padding: 4,
				background: 'var(--surface-elev)',
				border: '1px solid var(--border)',
				borderRadius: 'var(--radius-lg)',
				boxShadow: 'var(--shadow-floating)',
				zIndex: 'var(--z-floating)',
			}}
		>
			{tools.map((tool) => (
				<ToolButton
					key={tool.id}
					tool={tool}
					active={tool.id === activeId}
					onClick={() => onSelect?.(tool.id)}
				/>
			))}
		</div>
	)
}

function ToolButton({
	tool,
	active,
	onClick,
}: {
	tool: ToolbarTool
	active: boolean
	onClick: () => void
}) {
	const title = tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			aria-label={title}
			aria-pressed={active}
			style={{
				width: 32,
				height: 32,
				display: 'inline-flex',
				alignItems: 'center',
				justifyContent: 'center',
				background: active ? 'var(--accent-soft)' : 'transparent',
				color: active ? 'var(--accent)' : 'var(--text-strong)',
				border: 'none',
				borderRadius: 'var(--radius-md)',
				cursor: 'pointer',
				transition: `background var(--motion-chip) var(--ease-default)`,
			}}
			onMouseEnter={(e) => {
				if (!active) e.currentTarget.style.background = 'var(--surface-overlay)'
			}}
			onMouseLeave={(e) => {
				if (!active) e.currentTarget.style.background = 'transparent'
			}}
		>
			{tool.icon}
		</button>
	)
}

/*
 * The icon set. Each one is a 16x16 inline SVG, single-stroke,
 * 1.5px line weight. Inline so they ship without an extra request
 * and inherit currentColor from the surrounding ToolButton.
 */

export function IconHand() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M7 2.5v5M5 4.5v3.5M9 3v4.5M11 4.5v3M3 7.5c0 4 2 6.5 5 6.5s5-2 5-5.5V5.5" />
		</svg>
	)
}

export function IconSelect() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M3 2l4.5 11 2.2-4.6 4.3-1.9z" />
		</svg>
	)
}

export function IconAgent() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<rect x="2.5" y="3" width="11" height="8" rx="1.5" />
			<circle cx="6" cy="7" r="0.5" fill="currentColor" />
			<circle cx="10" cy="7" r="0.5" fill="currentColor" />
			<path d="M5 13l1.5-2M11 13l-1.5-2" />
		</svg>
	)
}

export function IconConnector() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<circle cx="4" cy="8" r="1.5" />
			<circle cx="12" cy="8" r="1.5" />
			<path d="M5.5 8h5" />
		</svg>
	)
}

export function IconComment() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M3 4h10v6H8.5L5.5 13v-3H3z" />
		</svg>
	)
}
