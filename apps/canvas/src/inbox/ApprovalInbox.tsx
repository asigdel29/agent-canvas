/**
 * ApprovalInbox — pending approval cards. Now lives inside the right
 * rail (Activity mode) as a section above the live event feed.
 *
 * Previously a floating top-right stack; the right-rail placement
 * groups approvals with the activity feed because both are "things
 * the run wants the operator to look at right now". The visual model
 * stays: equal-weight cards, expandable, Approve / Reject buttons
 * that emit commands.
 *
 * Each card uses the live-soft tint when the underlying action is
 * irreversible — destructive-but-recoverable stays neutral so the
 * eye learns to read the pink tint as "no undo".
 * @author asigdel29
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
	if (cards.length === 0) return null
	return (
		<section
			aria-label="Pending approvals"
			style={{
				borderBottom: '1px solid var(--border)',
				background: 'var(--surface-elev)',
			}}
		>
			<header
				style={{
					padding: 'var(--space-2) var(--space-3)',
					fontSize: 11,
					fontWeight: 500,
					color: 'var(--text-muted)',
					textTransform: 'uppercase',
					letterSpacing: 0.6,
				}}
			>
				Pending · {cards.length}
			</header>
			<div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
				{cards.map((card) => (
					<Card key={card.id} card={card} onApprove={onApprove} onReject={onReject} />
				))}
			</div>
		</section>
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
	const isIrreversible = card.safety === 'irreversible'
	return (
		<article
			style={{
				padding: 'var(--space-3)',
				background: isIrreversible ? 'var(--live-soft)' : 'var(--surface-elev)',
				borderTop: '1px solid var(--border)',
				fontSize: 'var(--font-13)',
				color: 'var(--text-strong)',
				display: 'grid',
				gap: 'var(--space-2)',
			}}
		>
			<header
				style={{
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'baseline',
					gap: 'var(--space-2)',
				}}
			>
				<span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
					{card.run_title}
				</span>
				<time
					dateTime={card.proposed_at}
					style={{
						fontSize: 11,
						color: 'var(--text-muted)',
						fontVariantNumeric: 'tabular-nums',
					}}
				>
					{relative(card.proposed_at)}
				</time>
			</header>
			<div
				style={{
					fontFamily: 'var(--font-mono)',
					fontSize: 'var(--font-12)',
					color: isIrreversible ? 'var(--live)' : 'var(--text-strong)',
				}}
			>
				{card.tool_name}
				{isIrreversible && (
					<span
						aria-label="Irreversible action"
						style={{ marginLeft: 6, fontFamily: 'var(--font-ui)', fontSize: 11 }}
					>
						· irreversible
					</span>
				)}
			</div>
			<p
				style={{
					margin: 0,
					fontSize: 'var(--font-12)',
					color: 'var(--text-muted)',
					lineHeight: 1.5,
				}}
			>
				{card.tool_description}
			</p>
			<div style={{ display: 'flex', gap: 'var(--space-1)' }}>
				<button
					type="button"
					onClick={() => onReject(card)}
					style={{ flex: 1, ...buttonStyle('secondary') }}
				>
					Reject
				</button>
				<button
					type="button"
					onClick={() => onApprove(card)}
					style={{ flex: 1, ...buttonStyle('primary') }}
				>
					Approve
				</button>
			</div>
		</article>
	)
}

function buttonStyle(kind: 'primary' | 'secondary'): React.CSSProperties {
	const isPrimary = kind === 'primary'
	return {
		height: 28,
		padding: '0 var(--space-3)',
		fontSize: 'var(--font-12)',
		fontWeight: 500,
		font: 'inherit',
		fontFamily: 'var(--font-ui)',
		borderRadius: 'var(--radius-md)',
		border: isPrimary ? 'none' : '1px solid var(--border)',
		background: isPrimary ? 'var(--text-strong)' : 'var(--surface-elev)',
		color: isPrimary ? 'var(--text-on-accent)' : 'var(--text-strong)',
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
