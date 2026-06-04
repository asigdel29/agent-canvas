/**
 * Shell — the three-zone layout frame.
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │  TopBar                                                   │  44px
 *   ├──────┬────────────────────────────────────────┬───────────┤
 *   │      │                                        │           │
 *   │ Left │      Canvas (children prop)            │  Right    │
 *   │ Rail │      with FloatingToolbar overlay      │  Rail     │
 *   │      │      and ZoomCluster bottom-right      │           │
 *   │ 260  │                                        │  300      │
 *   │      │                                        │           │
 *   └──────┴────────────────────────────────────────┴───────────┘
 *
 * Both rails can be hidden via the `leftRail` / `rightRail` props
 * returning null — the canvas reclaims the space automatically.
 * No internal scroll containers; each rail manages its own overflow.
 *
 * The shell is intentionally chrome-only: it never renders the
 * canvas itself, only the surrounding frame and an overlay slot.
 * The caller composes the canvas via `children` so this file stays
 * agnostic to whatever Tldraw / EmptyState / placeholder lives in
 * the centre.
 * @author asigdel29
 */

import type { ReactNode } from 'react'

export interface ShellProps {
	readonly topBar: ReactNode
	readonly leftRail: ReactNode | null
	readonly rightRail: ReactNode | null
	/** Overlay chrome that floats on top of the canvas (toolbar, zoom). */
	readonly overlays?: ReactNode
	/** The canvas — typically <Tldraw> or <EmptyState>. */
	readonly children: ReactNode
}

export function Shell({ topBar, leftRail, rightRail, overlays, children }: ShellProps) {
	const hasLeft = leftRail !== null
	const hasRight = rightRail !== null
	return (
		<div
			style={{
				display: 'grid',
				gridTemplateRows: 'var(--topbar-h) 1fr',
				gridTemplateColumns: `${hasLeft ? 'var(--rail-w-left)' : '0'} 1fr ${
					hasRight ? 'var(--rail-w-right)' : '0'
				}`,
				gridTemplateAreas: `
					"topbar topbar topbar"
					"left   canvas right"
				`,
				width: '100vw',
				height: '100vh',
				background: 'var(--surface)',
			}}
		>
			<header
				style={{
					gridArea: 'topbar',
					borderBottom: '1px solid var(--border)',
					background: 'var(--surface-elev)',
					zIndex: 'var(--z-shell)',
				}}
			>
				{topBar}
			</header>

			{hasLeft && (
				<aside
					aria-label="Workflows and runs"
					style={{
						gridArea: 'left',
						borderRight: '1px solid var(--border)',
						background: 'var(--surface-elev)',
						overflow: 'hidden',
						display: 'flex',
						flexDirection: 'column',
						zIndex: 'var(--z-shell)',
					}}
				>
					{leftRail}
				</aside>
			)}

			<main
				style={{
					gridArea: 'canvas',
					position: 'relative',
					overflow: 'hidden',
					background: 'var(--surface)',
				}}
			>
				{children}
				{overlays}
			</main>

			{hasRight && (
				<aside
					aria-label="Inspector"
					style={{
						gridArea: 'right',
						borderLeft: '1px solid var(--border)',
						background: 'var(--surface-elev)',
						overflow: 'hidden',
						display: 'flex',
						flexDirection: 'column',
						zIndex: 'var(--z-shell)',
					}}
				>
					{rightRail}
				</aside>
			)}
		</div>
	)
}
