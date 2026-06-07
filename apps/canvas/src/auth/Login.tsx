/**
 * Login — full-viewport sign-in screen rendered when no session is
 * present.
 *
 * The action adapts to the deployment's auth mode, fetched once from
 * GET /api/auth/config:
 *
 *   github (default)  Single action: Sign in with GitHub. The button
 *                     hands off to /api/auth/login/github, which mints a
 *                     state JWT and redirects to GitHub. On success the
 *                     orchestrator redirects back with ?session=&room=.
 *   open              Trusted internal deploy: a teammate joins with just
 *                     a display name via POST /api/auth/anon-session. No
 *                     external login. The returned session + room are put
 *                     on the URL exactly as the GitHub callback does, so
 *                     App's intakeAndStashCredentials handles both paths
 *                     identically.
 *
 * Visual model: centered card on the dark surface, generous padding,
 * Framer-pink accent on the mark. The component owns its auth-mode fetch
 * but is otherwise driven by the orchestrator URL passed in from App.
 *
 * @author asigdel29
 */

import { type FormEvent, useEffect, useState } from 'react'
import { track } from '../analytics/posthog.js'

export interface LoginProps {
	readonly orchestratorUrl: string
	/**
	 * If the URL carries ?auth=cancelled we surface a small inline
	 * message so the user knows their cancel landed.
	 */
	readonly cancelled?: boolean
}

type AuthMode = 'loading' | 'github' | 'open' | 'error'

export function Login({ orchestratorUrl, cancelled = false }: LoginProps) {
	const [loading, setLoading] = useState(false)
	const [mode, setMode] = useState<AuthMode>('loading')
	const [handle, setHandle] = useState('')
	const [joinError, setJoinError] = useState<string | null>(null)
	// Bumped by the Retry button to re-run the auth-config fetch.
	const [reloadKey, setReloadKey] = useState(0)

	useEffect(() => {
		// If the URL has the cancelled flag, strip it so a refresh
		// doesn't keep showing the banner.
		if (cancelled && typeof window !== 'undefined') {
			const url = new URL(window.location.href)
			url.searchParams.delete('auth')
			window.history.replaceState({}, '', url.toString())
		}
	}, [cancelled])

	useEffect(() => {
		// Resolve the deployment's auth mode. A failure here means the
		// orchestrator is unreachable or misconfigured; surface that as a
		// distinct 'error' state with a retry rather than silently showing
		// a GitHub button that cannot complete.
		let cancelledFetch = false
		setMode('loading')
		fetch(`${orchestratorUrl}/api/auth/config`)
			.then((r) => {
				if (!r.ok) throw new Error(`auth config ${r.status}`)
				return r.json()
			})
			.then((cfg: { auth_mode?: string }) => {
				if (!cancelledFetch) setMode(cfg.auth_mode === 'open' ? 'open' : 'github')
			})
			.catch(() => {
				if (!cancelledFetch) setMode('error')
			})
		return () => {
			cancelledFetch = true
		}
	}, [orchestratorUrl, reloadKey])

	function handleSignIn() {
		setLoading(true)
		track('login_started', { provider: 'github' })
		const url = new URL(`${orchestratorUrl}/api/auth/login/github`)
		url.searchParams.set('redirect_to', window.location.origin + '/')
		window.location.href = url.toString()
	}

	async function handleJoin(event: FormEvent) {
		event.preventDefault()
		setLoading(true)
		setJoinError(null)
		track('login_started', { provider: 'open' })
		try {
			const res = await fetch(`${orchestratorUrl}/api/auth/anon-session`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ handle }),
			})
			if (!res.ok) {
				setJoinError('Could not join. Check with whoever set up this workspace.')
				setLoading(false)
				return
			}
			const data = (await res.json()) as { session: string; room: string; workspace_id: string }
			// Hand off through the URL exactly like the GitHub callback, so
			// App's intake logic stashes the session and strips the params.
			const dest = new URL(window.location.origin + '/')
			dest.searchParams.set('session', data.session)
			dest.searchParams.set('room', data.room)
			dest.searchParams.set('workspace_id', data.workspace_id)
			dest.searchParams.set('login_provider', 'open')
			dest.searchParams.set('login_handle', handle)
			window.location.href = dest.toString()
		} catch {
			setJoinError('Could not reach the orchestrator. Is it running?')
			setLoading(false)
		}
	}

	return (
		<div
			role="main"
			style={{
				position: 'fixed',
				inset: 0,
				display: 'grid',
				placeItems: 'center',
				background: 'var(--surface)',
				color: 'var(--text-strong)',
			}}
		>
			<section
				style={{
					width: 'min(420px, 92vw)',
					padding: 'var(--space-6) var(--space-5)',
					background: 'var(--surface-elev)',
					border: '1px solid var(--border)',
					borderRadius: 'var(--radius-lg)',
					boxShadow: 'var(--shadow-popover)',
					display: 'grid',
					gap: 'var(--space-5)',
				}}
			>
				<header style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}>
					<Mark />
					<h1
						style={{
							margin: 0,
							fontSize: 'var(--font-24)',
							fontWeight: 500,
							letterSpacing: -0.2,
						}}
					>
						Sign in to agent canvas
					</h1>
					<p
						style={{
							margin: 0,
							fontSize: 'var(--font-13)',
							color: 'var(--text-muted)',
							lineHeight: 1.5,
						}}
					>
						Run cloud agents on an infinite canvas. Connect your tools, configure
						capabilities, watch every step.
					</p>
				</header>

				{cancelled && (
					<div
						role="status"
						style={{
							padding: 'var(--space-2) var(--space-3)',
							background: 'var(--live-soft)',
							border: '1px solid var(--live)',
							borderRadius: 'var(--radius-md)',
							fontSize: 'var(--font-12)',
							color: 'var(--text-strong)',
						}}
					>
						Sign-in was cancelled. Try again whenever you are ready.
					</div>
				)}

				{mode === 'error' ? (
					<div style={{ display: 'grid', gap: 'var(--space-3)' }}>
						<div
							role="alert"
							style={{
								padding: 'var(--space-3)',
								background: 'var(--live-soft)',
								border: '1px solid var(--live)',
								borderRadius: 'var(--radius-md)',
								fontSize: 'var(--font-12)',
								color: 'var(--text-strong)',
								lineHeight: 1.5,
							}}
						>
							Can’t reach the orchestrator at{' '}
							<code style={{ fontFamily: 'var(--font-mono)' }}>{orchestratorUrl}</code>. Make
							sure it is running and reachable, then retry.
						</div>
						<button
							type="button"
							onClick={() => setReloadKey((k) => k + 1)}
							style={{
								height: 44,
								padding: '0 var(--space-4)',
								background: 'var(--text-strong)',
								color: '#0A0A0A',
								border: 'none',
								borderRadius: 'var(--radius-md)',
								fontFamily: 'var(--font-ui)',
								fontSize: 'var(--font-14)',
								fontWeight: 500,
								cursor: 'pointer',
							}}
						>
							Retry
						</button>
					</div>
				) : mode === 'open' ? (
					<form onSubmit={handleJoin} style={{ display: 'grid', gap: 'var(--space-3)' }}>
						<input
							type="text"
							value={handle}
							onChange={(e) => setHandle(e.target.value)}
							placeholder="Your name"
							aria-label="Your name"
							autoFocus
							maxLength={40}
							style={{
								height: 44,
								padding: '0 var(--space-3)',
								background: 'var(--surface-sunk)',
								color: 'var(--text-strong)',
								border: '1px solid var(--border)',
								borderRadius: 'var(--radius-md)',
								fontFamily: 'var(--font-ui)',
								fontSize: 'var(--font-14)',
							}}
						/>
						<button
							type="submit"
							disabled={loading || handle.trim().length === 0}
							style={{
								height: 44,
								padding: '0 var(--space-4)',
								background:
									loading || handle.trim().length === 0
										? 'var(--surface-sunk)'
										: 'var(--text-strong)',
								color:
									loading || handle.trim().length === 0
										? 'var(--text-muted)'
										: '#0A0A0A',
								border: 'none',
								borderRadius: 'var(--radius-md)',
								fontFamily: 'var(--font-ui)',
								fontSize: 'var(--font-14)',
								fontWeight: 500,
								cursor:
									loading || handle.trim().length === 0 ? 'not-allowed' : 'pointer',
							}}
						>
							{loading ? 'Joining…' : 'Join the workspace'}
						</button>
						{joinError && (
							<p style={{ margin: 0, fontSize: 'var(--font-12)', color: 'var(--live)' }}>
								{joinError}
							</p>
						)}
					</form>
				) : (
					<button
						type="button"
						onClick={handleSignIn}
						disabled={loading || mode === 'loading'}
						style={{
							display: 'inline-flex',
							alignItems: 'center',
							justifyContent: 'center',
							gap: 'var(--space-2)',
							height: 44,
							padding: '0 var(--space-4)',
							background:
								loading || mode === 'loading' ? 'var(--surface-sunk)' : 'var(--text-strong)',
							color: loading || mode === 'loading' ? 'var(--text-muted)' : '#0A0A0A',
							border: 'none',
							borderRadius: 'var(--radius-md)',
							fontFamily: 'var(--font-ui)',
							fontSize: 'var(--font-14)',
							fontWeight: 500,
							cursor: loading || mode === 'loading' ? 'not-allowed' : 'pointer',
						}}
					>
						<GitHubMark />
						{loading ? 'Redirecting to GitHub…' : 'Sign in with GitHub'}
					</button>
				)}

				<footer
					style={{
						margin: 0,
						fontSize: 11,
						color: 'var(--text-muted)',
						lineHeight: 1.5,
					}}
				>
					{mode === 'open' ? (
						<>
							Internal workspace — pick a name your teammates will recognize. Your
							Claude key stays in this browser; no account required.
						</>
					) : (
						<>
							We request <code style={{ fontFamily: 'var(--font-mono)' }}>read:user</code> and{' '}
							<code style={{ fontFamily: 'var(--font-mono)' }}>user:email</code> from GitHub —
							only enough to identify you. No repos read, no code written.
						</>
					)}
					<br />
					<br />
					By continuing you agree to the{' '}
					<a
						href="/tos"
						style={{ color: 'var(--accent)', textDecoration: 'underline' }}
					>
						Terms
					</a>{' '}
					and{' '}
					<a
						href="/privacy"
						style={{ color: 'var(--accent)', textDecoration: 'underline' }}
					>
						Privacy Policy
					</a>
					.
				</footer>
			</section>
		</div>
	)
}

function Mark() {
	return (
		<svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
			<rect x="4" y="4" width="24" height="24" rx="2" transform="rotate(45 16 16)" fill="var(--live)" />
		</svg>
	)
}

function GitHubMark() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 16 16"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
		</svg>
	)
}
