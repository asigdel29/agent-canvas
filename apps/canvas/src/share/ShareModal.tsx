/**
 * ShareModal — create and manage public links to this workspace.
 *
 * An admin picks an access level (view or edit), mints a link, and
 * copies the URL. The raw token is returned by the server exactly
 * once, so the just-created link is surfaced prominently for copying;
 * existing links list as metadata only and can be revoked.
 *
 * Share URLs are built against the page's own origin, never an
 * internal host, and every error collapses to a short generic
 * message — internal URLs, statuses, and ids never reach the DOM.
 *
 * Escape closes; backdrop click closes.
 * @author asigdel29
 */

import { useEffect, useState } from 'react'
import {
	WorkspaceApi,
	WorkspaceApiError,
	type ShareLinkSummary,
	type ShareRole,
} from '../workspaces/workspaceApi.js'

export interface ShareModalProps {
	readonly open: boolean
	readonly orchestratorUrl: string
	readonly session: string
	readonly workspaceId: string
	readonly onClose: () => void
}

/** Build the public, copyable URL for a share token from this origin. */
function shareUrlForToken(token: string): string {
	if (typeof window === 'undefined') return ''
	return `${window.location.origin}/?share=${encodeURIComponent(token)}`
}

const ROLE_LABEL: Record<ShareRole, string> = {
	viewer: 'Can view',
	member: 'Can edit',
}

export function ShareModal({ open, orchestratorUrl, session, workspaceId, onClose }: ShareModalProps) {
	const api = new WorkspaceApi({ baseUrl: orchestratorUrl, session })
	const [links, setLinks] = useState<readonly ShareLinkSummary[] | null>(null)
	const [role, setRole] = useState<ShareRole>('viewer')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [freshUrl, setFreshUrl] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)

	useEffect(() => {
		if (!open) {
			setFreshUrl(null)
			setError(null)
			setCopied(false)
			return
		}
		void refresh()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, workspaceId])

	useEffect(() => {
		if (!open) return
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') {
				e.preventDefault()
				onClose()
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [open, onClose])

	async function refresh(): Promise<void> {
		try {
			setLinks(await api.listShareLinks(workspaceId))
			setError(null)
		} catch (err) {
			setError(friendly(err, 'Could not load share links.'))
		}
	}

	async function handleCreate(): Promise<void> {
		setBusy(true)
		setError(null)
		try {
			const { token } = await api.createShareLink(workspaceId, role)
			setFreshUrl(shareUrlForToken(token))
			setCopied(false)
			await refresh()
		} catch (err) {
			setError(friendly(err, 'Could not create the link.'))
		} finally {
			setBusy(false)
		}
	}

	async function handleCopy(): Promise<void> {
		if (!freshUrl) return
		try {
			await navigator.clipboard.writeText(freshUrl)
			setCopied(true)
		} catch {
			// Clipboard blocked (permissions/insecure context): leave the
			// URL visible so the user can copy it by hand.
			setCopied(false)
		}
	}

	async function handleRevoke(id: string): Promise<void> {
		try {
			await api.revokeShareLink(workspaceId, id)
			await refresh()
		} catch (err) {
			setError(friendly(err, 'Could not revoke the link.'))
		}
	}

	if (!open) return null

	return (
		<div
			role="presentation"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose()
			}}
			style={{
				position: 'fixed',
				inset: 0,
				background: 'rgba(0, 0, 0, 0.6)',
				display: 'grid',
				placeItems: 'center',
				zIndex: 'var(--z-modal)',
				padding: 'var(--space-5)',
			}}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="share-title"
				style={{
					width: 'min(520px, 100%)',
					background: 'var(--surface-elev)',
					border: '1px solid var(--border)',
					borderRadius: 'var(--radius-lg)',
					boxShadow: 'var(--shadow-popover)',
					display: 'grid',
				}}
			>
				<header
					style={{
						display: 'grid',
						gridTemplateColumns: '1fr auto',
						alignItems: 'baseline',
						padding: 'var(--space-4) var(--space-5)',
						borderBottom: '1px solid var(--border)',
					}}
				>
					<h2
						id="share-title"
						style={{ margin: 0, fontSize: 'var(--font-20)', fontWeight: 500, letterSpacing: -0.2 }}
					>
						Share this canvas
					</h2>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close"
						style={{
							background: 'transparent',
							border: 'none',
							color: 'var(--text-muted)',
							fontSize: 18,
							cursor: 'pointer',
							lineHeight: 1,
						}}
					>
						×
					</button>
				</header>

				<div style={{ padding: 'var(--space-5)', display: 'grid', gap: 'var(--space-4)' }}>
					<p style={{ margin: 0, fontSize: 'var(--font-12)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
						Anyone with the link can open this workspace at the access level you choose. Revoke a
						link any time to cut its access immediately.
					</p>

					<div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
						<select
							value={role}
							onChange={(e) => setRole(e.target.value as ShareRole)}
							disabled={busy}
							aria-label="Access level"
							style={controlStyle}
						>
							<option value="viewer">{ROLE_LABEL.viewer}</option>
							<option value="member">{ROLE_LABEL.member}</option>
						</select>
						<button
							type="button"
							onClick={() => void handleCreate()}
							disabled={busy}
							style={{
								...controlStyle,
								background: busy ? 'var(--surface-sunk)' : 'var(--accent)',
								color: busy ? 'var(--text-muted)' : 'var(--text-on-accent)',
								border: 'none',
								fontWeight: 500,
								cursor: busy ? 'not-allowed' : 'pointer',
							}}
						>
							{busy ? 'Creating…' : 'Create link'}
						</button>
					</div>

					{freshUrl && (
						<div
							role="status"
							style={{
								display: 'grid',
								gap: 'var(--space-2)',
								padding: 'var(--space-3)',
								background: 'var(--accent-soft)',
								border: '1px solid var(--accent)',
								borderRadius: 'var(--radius-md)',
							}}
						>
							<span style={{ fontSize: 'var(--font-12)', color: 'var(--text-strong)' }}>
								Copy this link now — you won't be able to see it again.
							</span>
							<div style={{ display: 'flex', gap: 'var(--space-2)' }}>
								<input
									readOnly
									value={freshUrl}
									onFocus={(e) => e.currentTarget.select()}
									style={{ ...controlStyle, flex: 1, fontFamily: 'var(--font-mono)' }}
								/>
								<button type="button" onClick={() => void handleCopy()} style={controlStyle}>
									{copied ? 'Copied' : 'Copy'}
								</button>
							</div>
						</div>
					)}

					{error && (
						<div
							role="alert"
							style={{
								padding: 'var(--space-2) var(--space-3)',
								background: 'var(--live-soft)',
								border: '1px solid var(--live)',
								borderRadius: 'var(--radius-md)',
								fontSize: 'var(--font-12)',
								color: 'var(--text-strong)',
							}}
						>
							{error}
						</div>
					)}

					<section style={{ display: 'grid', gap: 'var(--space-2)' }}>
						<h3 style={{ margin: 0, fontSize: 'var(--font-13)', fontWeight: 500 }}>
							Active links ({links?.length ?? 0})
						</h3>
						{!links && <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--font-12)' }}>Loading…</p>}
						{links && links.length === 0 && (
							<p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--font-12)' }}>
								No active links.
							</p>
						)}
						{links?.map((l) => (
							<div
								key={l.id}
								style={{
									display: 'grid',
									gridTemplateColumns: '1fr auto',
									alignItems: 'center',
									gap: 'var(--space-2)',
									padding: 'var(--space-2) var(--space-3)',
									background: 'var(--surface-sunk)',
									border: '1px solid var(--border)',
									borderRadius: 'var(--radius-md)',
									fontSize: 'var(--font-12)',
								}}
							>
								<span>
									{ROLE_LABEL[l.role]} · created{' '}
									{new Date(l.created_at).toLocaleDateString()}
								</span>
								<button
									type="button"
									onClick={() => void handleRevoke(l.id)}
									style={{
										background: 'transparent',
										border: '1px solid var(--border)',
										borderRadius: 'var(--radius-md)',
										color: 'var(--text-muted)',
										padding: '4px 10px',
										fontSize: 'var(--font-12)',
										cursor: 'pointer',
									}}
								>
									Revoke
								</button>
							</div>
						))}
					</section>
				</div>
			</div>
		</div>
	)
}

const controlStyle: React.CSSProperties = {
	height: 32,
	padding: '0 var(--space-3)',
	background: 'var(--surface-sunk)',
	border: '1px solid var(--border)',
	borderRadius: 'var(--radius-md)',
	color: 'var(--text-strong)',
	font: 'inherit',
	fontFamily: 'var(--font-ui)',
	fontSize: 'var(--font-13)',
}

/**
 * Reduce any thrown value to a short, user-facing message. Known API
 * errors map by code; everything else falls back to `fallback`. We
 * never surface raw URLs, HTTP statuses, or server detail strings.
 */
function friendly(err: unknown, fallback: string): string {
	if (err instanceof WorkspaceApiError) {
		if (err.status === 403) return 'You need admin access to manage share links.'
		if (err.status === 429) return 'Too many attempts. Try again in a moment.'
	}
	return fallback
}
