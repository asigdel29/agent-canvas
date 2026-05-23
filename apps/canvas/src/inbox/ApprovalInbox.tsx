/**
 * ApprovalInbox — top-right paginated stack of pending approval cards.
 *
 * Per design review 21 (visual hierarchy) + the "approvals as inbox"
 * decision: cards are equal-weight, paginated, expandable, with a count
 * badge. Each card surfaces the tool name + description from the
 * SafetyClassifier; Approve / Reject buttons emit commands.
 */

export interface ApprovalCard {
	readonly id: string
	readonly run_id: string
	readonly run_title: string
	readonly tool_name: string
	readonly tool_description: string
	readonly safety: 'destructive' | 'irreversible'
	readonly proposed_at: string
}

export interface ApprovalInboxProps {
	readonly cards: readonly ApprovalCard[]
	readonly onApprove: (card: ApprovalCard) => void
	readonly onReject: (card: ApprovalCard) => void
}

export function ApprovalInbox({ cards, onApprove, onReject }: ApprovalInboxProps) {
	return (
		<aside
			aria-label="Pending approvals"
			style={{
				position: 'fixed',
				top: 12,
				right: 12,
				width: 280,
				display: 'flex',
				flexDirection: 'column',
				gap: 8,
				pointerEvents: 'none',
				zIndex: 10,
			}}
		>
			<span
				style={{
					alignSelf: 'flex-end',
					pointerEvents: 'auto',
					padding: '4px 8px',
					border: '1px solid var(--border)',
					borderRadius: 999,
					background: 'var(--surface-elev)',
					color: 'var(--text-muted)',
					fontFamily: 'var(--font-mono)',
					fontSize: 11,
				}}
			>
				{cards.length} pending
			</span>
			{cards.map((card) => (
				<Card key={card.id} card={card} onApprove={onApprove} onReject={onReject} />
			))}
		</aside>
	)
}

function Card({
	card,
	onApprove,
	onReject,
}: {
	card: ApprovalCard
	onApprove: (c: ApprovalCard) => void
	onReject: (c: ApprovalCard) => void
}) {
	return (
		<article
			style={{
				pointerEvents: 'auto',
				padding: '10px 12px',
				border: '1px solid var(--border)',
				borderRadius: 'var(--radius-lg)',
				background: 'var(--surface-elev)',
				boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
				fontSize: 13,
				color: 'var(--text-strong)',
			}}
		>
			<header
				style={{
					display: 'flex',
					justifyContent: 'space-between',
					fontSize: 11,
					color: 'var(--text-muted)',
					marginBottom: 4,
				}}
			>
				<span style={{ fontWeight: 500, color: 'var(--text-strong)' }}>{card.run_title}</span>
				<time>{relative(card.proposed_at)}</time>
			</header>
			<div style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{card.tool_name}</div>
			<p style={{ margin: '6px 0 8px', fontSize: 12, color: 'var(--text-muted)' }}>
				{card.tool_description}
			</p>
			<div style={{ display: 'flex', gap: 6 }}>
				<button
					type="button"
					onClick={() => onReject(card)}
					style={{ flex: 1, ...buttonStyle(false) }}
				>
					Reject
				</button>
				<button
					type="button"
					onClick={() => onApprove(card)}
					style={{ flex: 1, ...buttonStyle(true) }}
				>
					Approve
				</button>
			</div>
		</article>
	)
}

function buttonStyle(primary: boolean): React.CSSProperties {
	return {
		padding: '6px 10px',
		fontSize: 12,
		font: 'inherit',
		borderRadius: 'var(--radius-sm)',
		border: `1px solid var(--${primary ? 'accent' : 'border'})`,
		background: primary ? 'var(--accent)' : 'var(--surface-elev)',
		color: primary ? 'white' : 'var(--text-strong)',
		cursor: 'pointer',
	}
}

function relative(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime()
	if (ms < 60_000) return 'now'
	if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m`
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
	return `${Math.floor(ms / 86_400_000)}d`
}
