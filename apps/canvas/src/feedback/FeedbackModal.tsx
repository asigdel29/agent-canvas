/**
 * FeedbackModal — single-textarea "tell us what broke" dialog.
 *
 * The goal is the lowest-friction path from "something is wrong" to
 * "the operator can see it". No triage form, no category dropdown.
 * The recent SSE event tail is attached automatically so the
 * operator reading the audit log has the context the user couldn't
 * articulate.
 *
 * Submits to /api/feedback with the session bearer. Success
 * collapses to a 1.5s confirmation banner then auto-closes.
 *
 * Escape closes; backdrop click closes; Cmd/Ctrl+Enter submits.
 */

import { useEffect, useState } from 'react'

export interface FeedbackModalProps {
	readonly open: boolean
	readonly orchestratorUrl: string
	readonly session: string
	readonly recentEvents?: readonly Record<string, unknown>[]
	readonly onClose: () => void
}

export function FeedbackModal({
	open,
	orchestratorUrl,
	session,
	recentEvents = [],
	onClose,
}: FeedbackModalProps) {
	const [message, setMessage] = useState('')
	const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (!open) {
			setMessage('')
			setState('idle')
			setError(null)
		}
	}, [open])

	useEffect(() => {
		if (!open) return
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') {
				e.preventDefault()
				onClose()
			}
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
				e.preventDefault()
				void submit()
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, message])

	useEffect(() => {
		if (state !== 'sent') return
		const t = setTimeout(onClose, 1500)
		return () => clearTimeout(t)
	}, [state, onClose])

	async function submit() {
		const trimmed = message.trim()
		if (!trimmed) return
		setState('sending')
		setError(null)
		try {
			const res = await fetch(`${orchestratorUrl}/api/feedback`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${session}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					message: trimmed,
					recent_events: recentEvents.slice(-20),
					url: typeof window !== 'undefined' ? window.location.href : null,
				}),
			})
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { detail?: string }
				setState('error')
				setError(body.detail ?? `HTTP ${res.status}`)
				return
			}
			setState('sent')
		} catch (err) {
			setState('error')
			setError(err instanceof Error ? err.message : String(err))
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
				aria-labelledby="feedback-title"
				style={{
					width: 'min(480px, 100%)',
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
						id="feedback-title"
						style={{
							margin: 0,
							fontSize: 'var(--font-20)',
							fontWeight: 500,
							letterSpacing: -0.2,
						}}
					>
						Tell us what broke
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

				<div style={{ padding: 'var(--space-5)', display: 'grid', gap: 'var(--space-3)' }}>
					{state === 'sent' ? (
						<div
							role="status"
							style={{
								padding: 'var(--space-3)',
								background: 'var(--accent-soft)',
								border: '1px solid var(--accent)',
								borderRadius: 'var(--radius-md)',
								fontSize: 'var(--font-13)',
								color: 'var(--text-strong)',
							}}
						>
							Thanks — sent. Closing.
						</div>
					) : (
						<>
							<p
								style={{
									margin: 0,
									fontSize: 'var(--font-12)',
									color: 'var(--text-muted)',
									lineHeight: 1.5,
								}}
							>
								The most recent {recentEvents.length} events on this room are attached
								automatically so we can see what was happening when you hit Send.
							</p>
							<textarea
								value={message}
								onChange={(e) => setMessage(e.target.value)}
								autoFocus
								placeholder="What happened? What did you expect? What did you see?"
								rows={6}
								style={{
									width: '100%',
									padding: '8px var(--space-3)',
									background: 'var(--surface-sunk)',
									border: '1px solid var(--border)',
									borderRadius: 'var(--radius-md)',
									color: 'var(--text-strong)',
									font: 'inherit',
									fontFamily: 'var(--font-ui)',
									fontSize: 'var(--font-13)',
									resize: 'vertical',
								}}
							/>
							{state === 'error' && error && (
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
									Send failed: {error}
								</div>
							)}
							<footer
								style={{
									display: 'flex',
									justifyContent: 'space-between',
									alignItems: 'center',
									gap: 'var(--space-2)',
								}}
							>
								<span style={{ fontSize: 'var(--font-12)', color: 'var(--text-muted)' }}>
									⌘ Enter to send
								</span>
								<div style={{ display: 'flex', gap: 'var(--space-2)' }}>
									<button
										type="button"
										onClick={onClose}
										style={{
											height: 32,
											padding: '0 var(--space-4)',
											background: 'transparent',
											color: 'var(--text-strong)',
											border: '1px solid var(--border)',
											borderRadius: 'var(--radius-md)',
											font: 'inherit',
											fontFamily: 'var(--font-ui)',
											fontSize: 'var(--font-13)',
											cursor: 'pointer',
										}}
									>
										Cancel
									</button>
									<button
										type="button"
										onClick={() => void submit()}
										disabled={!message.trim() || state === 'sending'}
										style={{
											height: 32,
											padding: '0 var(--space-4)',
											background:
												message.trim() && state !== 'sending'
													? 'var(--accent)'
													: 'var(--surface-sunk)',
											color:
												message.trim() && state !== 'sending'
													? 'var(--text-on-accent)'
													: 'var(--text-muted)',
											border: 'none',
											borderRadius: 'var(--radius-md)',
											font: 'inherit',
											fontFamily: 'var(--font-ui)',
											fontSize: 'var(--font-13)',
											fontWeight: 500,
											cursor:
												message.trim() && state !== 'sending' ? 'pointer' : 'not-allowed',
										}}
									>
										{state === 'sending' ? 'Sending…' : 'Send'}
									</button>
								</div>
							</footer>
						</>
					)}
				</div>
			</div>
		</div>
	)
}
