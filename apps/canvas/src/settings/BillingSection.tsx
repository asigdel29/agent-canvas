/**
 * BillingSection — display the workspace's billing status + offer
 * Subscribe / Manage CTAs.
 *
 * State machine:
 *
 *   status='none' & gate off    -> "Subscription not configured"
 *                                  banner + Subscribe button.
 *   status='none' & gate on     -> "Subscription required" warning +
 *                                  Subscribe button (more urgent
 *                                  copy since runs will be blocked).
 *   status='active'             -> green pill + period_end + Manage
 *                                  button -> portal session.
 *   status='trialing'           -> blue pill + period_end + Manage.
 *   status='past_due'           -> yellow pill + warning + Manage.
 *   any other live status       -> default pill + Manage.
 *
 * The Subscribe flow:
 *   - POST /api/billing/checkout-session with current page URLs as
 *     return + cancel.
 *   - On success, window.location.assign(url) to redirect to Stripe.
 *
 * The Manage flow:
 *   - POST /api/billing/portal-session with current page as return.
 *   - On success, window.location.assign(url) to redirect to portal.
 *
 * Errors surface inline. We do NOT poll the status endpoint while
 * the user is on Stripe — the webhook (P8) updates the local
 * subscription row asynchronously; the canvas refetches on next
 * mount.
 */

import { useEffect, useState } from 'react'
import { BillingApi, BillingApiError, type BillingStatus } from './billingApi.js'

export interface BillingSectionProps {
	readonly orchestratorUrl: string
	readonly session: string
}

export function BillingSection(props: BillingSectionProps) {
	const api = new BillingApi({ baseUrl: props.orchestratorUrl, session: props.session })
	const [status, setStatus] = useState<BillingStatus | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	async function refresh(): Promise<void> {
		try {
			const s = await api.status()
			setStatus(s)
			setError(null)
		} catch (err) {
			setError(err instanceof BillingApiError ? err.message : 'failed_to_load')
		}
	}

	useEffect(() => {
		void refresh()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.orchestratorUrl, props.session])

	async function handleSubscribe(): Promise<void> {
		setBusy(true)
		try {
			const here = window.location.href
			const sess = await api.checkoutSession({
				return_url: here,
				cancel_url: here,
			})
			window.location.assign(sess.url)
		} catch (err) {
			setError(err instanceof BillingApiError ? err.message : 'checkout_failed')
		} finally {
			setBusy(false)
		}
	}

	async function handleManage(): Promise<void> {
		setBusy(true)
		try {
			const here = window.location.href
			const sess = await api.portalSession({ return_url: here })
			window.location.assign(sess.url)
		} catch (err) {
			setError(err instanceof BillingApiError ? err.message : 'portal_failed')
		} finally {
			setBusy(false)
		}
	}

	return (
		<section style={{ display: 'grid', gap: 'var(--space-3)' }}>
			<header
				style={{
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'baseline',
				}}
			>
				<span style={sectionLabelStyle}>Billing</span>
			</header>

			{error && (
				<div role="alert" style={errorBoxStyle}>
					{error}
				</div>
			)}

			{status === null && !error && (
				<div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-12)' }}>Loading…</div>
			)}

			{status !== null && <BillingBody status={status} busy={busy} onSubscribe={handleSubscribe} onManage={handleManage} />}
		</section>
	)
}

function BillingBody(props: {
	status: BillingStatus
	busy: boolean
	onSubscribe: () => Promise<void>
	onManage: () => Promise<void>
}) {
	const { status } = props
	const isNone = status.status === 'none'
	const periodEndLabel = status.current_period_end
		? new Date(status.current_period_end).toLocaleDateString()
		: null

	return (
		<div style={{ display: 'grid', gap: 'var(--space-3)' }}>
			<StatusPill status={status.status} live={status.live} />

			{periodEndLabel && (
				<div style={{ fontSize: 'var(--font-12)', color: 'var(--text-muted)' }}>
					{status.cancel_at_period_end
						? `Cancels on ${periodEndLabel}`
						: `Renews on ${periodEndLabel}`}
				</div>
			)}

			{status.plan_lookup_key && (
				<div style={{ fontSize: 'var(--font-12)', color: 'var(--text-muted)' }}>
					Plan: <span style={{ fontFamily: 'var(--font-mono)' }}>{status.plan_lookup_key}</span>
				</div>
			)}

			{!status.live && status.gate_enabled && (
				<div style={warningBoxStyle}>
					This workspace cannot start new agent runs until a subscription is active.
				</div>
			)}
			{!status.live && !status.gate_enabled && (
				<div style={infoBoxStyle}>
					Billing is currently disabled on the orchestrator. Subscribe to lock in your plan
					before the gate flips on.
				</div>
			)}
			{status.status === 'past_due' && (
				<div style={warningBoxStyle}>
					Payment is past due. Update your payment method in the customer portal before the
					grace period ends.
				</div>
			)}

			<div style={{ display: 'flex', gap: 8 }}>
				{isNone ? (
					<button
						type="button"
						onClick={() => void props.onSubscribe()}
						disabled={props.busy}
						style={primaryButtonStyle}
					>
						{props.busy ? 'Opening Stripe…' : 'Subscribe'}
					</button>
				) : (
					<button
						type="button"
						onClick={() => void props.onManage()}
						disabled={props.busy}
						style={primaryButtonStyle}
					>
						{props.busy ? 'Opening portal…' : 'Manage billing'}
					</button>
				)}
			</div>
		</div>
	)
}

function StatusPill(props: { status: string; live: boolean }) {
	const palette = pillPalette(props.status)
	return (
		<div
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: 6,
				padding: '4px 10px',
				background: palette.background,
				border: `1px solid ${palette.border}`,
				borderRadius: 999,
				fontSize: 11,
				color: palette.text,
				width: 'fit-content',
				fontFamily: 'var(--font-mono)',
			}}
		>
			<span aria-hidden style={{
				width: 6,
				height: 6,
				borderRadius: '50%',
				background: palette.text,
			}} />
			{props.status === 'none' ? 'no subscription' : props.status}
		</div>
	)
}

function pillPalette(status: string): { background: string; border: string; text: string } {
	if (status === 'active') {
		return {
			background: 'rgba(80, 200, 120, 0.1)',
			border: 'rgba(80, 200, 120, 0.4)',
			text: 'rgb(120, 220, 150)',
		}
	}
	if (status === 'trialing') {
		return {
			background: 'rgba(100, 150, 255, 0.1)',
			border: 'rgba(100, 150, 255, 0.4)',
			text: 'rgb(140, 180, 255)',
		}
	}
	if (status === 'past_due') {
		return {
			background: 'rgba(255, 180, 60, 0.1)',
			border: 'rgba(255, 180, 60, 0.4)',
			text: 'rgb(255, 200, 100)',
		}
	}
	return {
		background: 'var(--surface-sunk)',
		border: 'var(--border)',
		text: 'var(--text-muted)',
	}
}

const sectionLabelStyle: React.CSSProperties = {
	fontSize: 11,
	color: 'var(--text-muted)',
	textTransform: 'uppercase',
	letterSpacing: 0.6,
}
const primaryButtonStyle: React.CSSProperties = {
	padding: '6px 12px',
	background: 'var(--accent)',
	border: 'none',
	borderRadius: 4,
	color: 'white',
	fontFamily: 'var(--font-ui)',
	fontSize: 'var(--font-12)',
	cursor: 'pointer',
}
const errorBoxStyle: React.CSSProperties = {
	padding: 8,
	background: 'rgba(255, 80, 80, 0.1)',
	border: '1px solid var(--text-danger)',
	borderRadius: 4,
	color: 'var(--text-danger)',
	fontSize: 'var(--font-12)',
}
const warningBoxStyle: React.CSSProperties = {
	padding: 8,
	background: 'rgba(255, 180, 60, 0.1)',
	border: '1px solid rgba(255, 180, 60, 0.4)',
	borderRadius: 4,
	color: 'rgb(255, 200, 100)',
	fontSize: 'var(--font-12)',
}
const infoBoxStyle: React.CSSProperties = {
	padding: 8,
	background: 'rgba(100, 150, 255, 0.05)',
	border: '1px solid rgba(100, 150, 255, 0.3)',
	borderRadius: 4,
	color: 'var(--text-muted)',
	fontSize: 'var(--font-12)',
}
