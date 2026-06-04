/**
 * LeftRail — the persistent navigator. Two top-level tabs:
 *
 *   Workflows   the saved automation templates the user owns
 *   Runs        recent and live executions of those templates
 *
 * Tab switching is local to this component; the parent passes both
 * lists and chooses which one to populate. An empty list renders the
 * EmptyRail copy ("Connect a tool to start") rather than an empty
 * scroll well, because an empty rail is dispiriting.
 *
 * Visual model echoes Figma's left panel: tight rows, hairline
 * separators, hover highlight that lifts the row without a border.
 * Selected row gets the accent-soft tint plus a 2px accent strip on
 * the left edge.
 * @author asigdel29
 */

import { useState } from 'react'

export type LeftRailTab = 'workflows' | 'runs'

export interface RailItem {
	readonly id: string
	readonly label: string
	/**
	 * Optional sub-label: "running 2m", "12 runs today", a connector
	 * name, anything. Renders as muted text on a second line.
	 */
	readonly sublabel?: string
	/**
	 * If true the row pulses the live dot. Reserved for items in an
	 * actively executing state.
	 */
	readonly isLive?: boolean
}

export interface LeftRailProps {
	readonly workflows: readonly RailItem[]
	readonly runs: readonly RailItem[]
	readonly selectedId?: string | null
	readonly onSelect?: (id: string) => void
	readonly onNewWorkflow?: () => void
}

export function LeftRail({
	workflows,
	runs,
	selectedId = null,
	onSelect,
	onNewWorkflow,
}: LeftRailProps) {
	const [tab, setTab] = useState<LeftRailTab>('workflows')
	const items = tab === 'workflows' ? workflows : runs
	return (
		<>
			<TabStrip
				tab={tab}
				onTabChange={setTab}
				workflowsCount={workflows.length}
				runsCount={runs.length}
				onNewWorkflow={onNewWorkflow}
			/>
			<div
				style={{
					flex: 1,
					overflowY: 'auto',
					padding: 'var(--space-1) 0',
				}}
			>
				{items.length === 0 ? (
					<EmptyRail tab={tab} />
				) : (
					items.map((item) => (
						<RailRow
							key={item.id}
							item={item}
							selected={item.id === selectedId}
							onSelect={onSelect}
						/>
					))
				)}
			</div>
		</>
	)
}

function TabStrip({
	tab,
	onTabChange,
	workflowsCount,
	runsCount,
	onNewWorkflow,
}: {
	tab: LeftRailTab
	onTabChange: (t: LeftRailTab) => void
	workflowsCount: number
	runsCount: number
	onNewWorkflow?: (() => void) | undefined
}) {
	return (
		<div
			style={{
				display: 'grid',
				gridTemplateColumns: '1fr auto',
				alignItems: 'center',
				padding: 'var(--space-2) var(--space-3)',
				borderBottom: '1px solid var(--border)',
				gap: 'var(--space-2)',
			}}
		>
			<div role="tablist" style={{ display: 'inline-flex', gap: 'var(--space-3)' }}>
				<TabButton
					selected={tab === 'workflows'}
					onClick={() => onTabChange('workflows')}
					label="Workflows"
					count={workflowsCount}
				/>
				<TabButton
					selected={tab === 'runs'}
					onClick={() => onTabChange('runs')}
					label="Runs"
					count={runsCount}
				/>
			</div>
			<button
				type="button"
				onClick={onNewWorkflow}
				aria-label="New workflow"
				title="New workflow"
				style={{
					width: 24,
					height: 24,
					padding: 0,
					display: 'inline-flex',
					alignItems: 'center',
					justifyContent: 'center',
					background: 'transparent',
					border: '1px solid var(--border)',
					borderRadius: 'var(--radius-md)',
					color: 'var(--text-strong)',
					cursor: 'pointer',
					fontFamily: 'var(--font-ui)',
				}}
			>
				+
			</button>
		</div>
	)
}

function TabButton({
	selected,
	onClick,
	label,
	count,
}: {
	selected: boolean
	onClick: () => void
	label: string
	count: number
}) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={selected}
			onClick={onClick}
			style={{
				background: 'transparent',
				border: 'none',
				padding: 'var(--space-1) 0',
				font: 'inherit',
				fontFamily: 'var(--font-ui)',
				fontSize: 'var(--font-13)',
				fontWeight: selected ? 500 : 400,
				color: selected ? 'var(--text-strong)' : 'var(--text-muted)',
				borderBottom: selected ? '2px solid var(--accent)' : '2px solid transparent',
				marginBottom: -1,
				cursor: 'pointer',
			}}
		>
			{label}
			{count > 0 && (
				<span
					style={{
						marginLeft: 6,
						fontSize: 'var(--font-12)',
						fontVariantNumeric: 'tabular-nums',
						color: 'var(--text-muted)',
					}}
				>
					{count}
				</span>
			)}
		</button>
	)
}

function RailRow({
	item,
	selected,
	onSelect,
}: {
	item: RailItem
	selected: boolean
	onSelect?: ((id: string) => void) | undefined
}) {
	return (
		<button
			type="button"
			onClick={() => onSelect?.(item.id)}
			style={{
				display: 'grid',
				gridTemplateColumns: 'auto 1fr auto',
				alignItems: 'center',
				gap: 'var(--space-2)',
				width: '100%',
				padding: '6px var(--space-3)',
				border: 'none',
				borderLeft: selected
					? '2px solid var(--accent)'
					: '2px solid transparent',
				background: selected ? 'var(--accent-soft)' : 'transparent',
				color: 'var(--text-strong)',
				font: 'inherit',
				fontFamily: 'var(--font-ui)',
				fontSize: 'var(--font-13)',
				textAlign: 'left',
				cursor: 'pointer',
			}}
			onMouseEnter={(e) => {
				if (!selected) e.currentTarget.style.background = 'var(--surface-overlay)'
			}}
			onMouseLeave={(e) => {
				if (!selected) e.currentTarget.style.background = 'transparent'
			}}
		>
			{item.isLive ? <span className="ac-live-dot" aria-label="live" /> : <span style={{ width: 6 }} />}
			<span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
				<span
					style={{
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
						fontWeight: 500,
					}}
				>
					{item.label}
				</span>
				{item.sublabel && (
					<span
						style={{
							fontSize: 'var(--font-12)',
							color: 'var(--text-muted)',
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
						}}
					>
						{item.sublabel}
					</span>
				)}
			</span>
		</button>
	)
}

function EmptyRail({ tab }: { tab: LeftRailTab }) {
	return (
		<div
			style={{
				padding: 'var(--space-5) var(--space-3)',
				color: 'var(--text-muted)',
				fontSize: 'var(--font-12)',
				lineHeight: 1.5,
			}}
		>
			{tab === 'workflows'
				? 'No workflows yet. Connect a tool from the canvas to create your first one.'
				: 'No runs yet. Trigger a workflow to see it execute here.'}
		</div>
	)
}
