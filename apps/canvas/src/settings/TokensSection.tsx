/**
 * TokensSection — list / mint / revoke API tokens from inside the
 * Settings drawer.
 *
 * Display contract:
 *   - On mount, fetch /api/tokens. Render the list with token_prefix
 *     and human-readable timestamps.
 *   - "New token" expands an inline form: name + scope.
 *   - On mint success: surface the raw_token EXACTLY ONCE in a
 *     monospaced box with a Copy button. The user has to dismiss
 *     the reveal before the form resets.
 *   - "Revoke" confirms with window.confirm, then DELETE + refetch.
 *
 * Why session-only: the orchestrator's POST /api/tokens refuses an
 * API-token auth header. A leaked machine token must not be able
 * to mint another token.
 * @author asigdel29
 */

import { useEffect, useState } from 'react'
import {
	TokensApi,
	TokensApiError,
	type ApiTokenScope,
	type ApiTokenSummary,
} from './tokensApi.js'

export interface TokensSectionProps {
	readonly orchestratorUrl: string
	readonly session: string
}

export function TokensSection(props: TokensSectionProps) {
	const api = new TokensApi({ baseUrl: props.orchestratorUrl, session: props.session })
	const [tokens, setTokens] = useState<readonly ApiTokenSummary[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)
	const [reveal, setReveal] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)

	async function refresh(): Promise<void> {
		try {
			const items = await api.list()
			setTokens(items)
			setError(null)
		} catch (err) {
			setError(err instanceof TokensApiError ? err.message : 'failed_to_load')
		}
	}

	useEffect(() => {
		void refresh()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.orchestratorUrl, props.session])

	async function handleMint(name: string, scope: ApiTokenScope): Promise<void> {
		try {
			const issued = await api.mint({ name, scope })
			setReveal(issued.raw_token)
			setCreating(false)
			await refresh()
		} catch (err) {
			setError(err instanceof TokensApiError ? err.message : 'mint_failed')
		}
	}

	async function handleRevoke(id: string, prefix: string): Promise<void> {
		const ok = window.confirm(
			`Revoke ${prefix}? Any client using it will start failing immediately.`
		)
		if (!ok) return
		try {
			await api.revoke(id)
			await refresh()
		} catch (err) {
			setError(err instanceof TokensApiError ? err.message : 'revoke_failed')
		}
	}

	async function handleCopy(): Promise<void> {
		if (!reveal) return
		try {
			await navigator.clipboard.writeText(reveal)
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		} catch {
			setError('clipboard_unavailable')
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
				<span style={sectionLabelStyle}>API tokens</span>
				<button
					type="button"
					onClick={() => setCreating((c) => !c)}
					style={linkButtonStyle}
				>
					{creating ? 'Cancel' : '+ New token'}
				</button>
			</header>

			{error && (
				<div role="alert" style={errorBoxStyle}>
					{error}
				</div>
			)}

			{reveal && (
				<div style={revealBoxStyle}>
					<div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
						Copy this now — you won&apos;t see it again.
					</div>
					<div style={tokenMonoStyle}>{reveal}</div>
					<div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
						<button type="button" onClick={handleCopy} style={primaryButtonStyle}>
							{copied ? 'Copied' : 'Copy'}
						</button>
						<button
							type="button"
							onClick={() => {
								setReveal(null)
								setCopied(false)
							}}
							style={secondaryButtonStyle}
						>
							Dismiss
						</button>
					</div>
				</div>
			)}

			{creating && (
				<MintTokenForm onSubmit={handleMint} onCancel={() => setCreating(false)} />
			)}

			{tokens === null && !error && (
				<div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-12)' }}>Loading…</div>
			)}
			{tokens !== null && tokens.length === 0 && (
				<div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-12)' }}>
					No tokens yet.
				</div>
			)}
			{tokens !== null && tokens.length > 0 && (
				<ul
					style={{
						listStyle: 'none',
						padding: 0,
						margin: 0,
						display: 'grid',
						gap: 4,
					}}
				>
					{tokens.map((t) => (
						<TokenRow key={t.id} token={t} onRevoke={() => handleRevoke(t.id, t.token_prefix)} />
					))}
				</ul>
			)}
		</section>
	)
}

function MintTokenForm(props: {
	onSubmit: (name: string, scope: ApiTokenScope) => Promise<void>
	onCancel: () => void
}) {
	const [name, setName] = useState('')
	const [scope, setScope] = useState<ApiTokenScope>('read')
	const [busy, setBusy] = useState(false)
	return (
		<form
			onSubmit={async (ev) => {
				ev.preventDefault()
				const trimmed = name.trim()
				if (!trimmed) return
				setBusy(true)
				try {
					await props.onSubmit(trimmed, scope)
				} finally {
					setBusy(false)
				}
			}}
			style={{ display: 'grid', gap: 6, padding: 8, border: '1px solid var(--border)', borderRadius: 6 }}
		>
			<input
				autoFocus
				placeholder="Token name (e.g. 'cli', 'ci')"
				value={name}
				onChange={(e) => setName(e.target.value)}
				disabled={busy}
				maxLength={80}
				style={inputStyle}
			/>
			<select
				value={scope}
				onChange={(e) => setScope(e.target.value as ApiTokenScope)}
				disabled={busy}
				style={inputStyle}
			>
				<option value="read">read — viewer-level routes</option>
				<option value="write">write — member-level routes</option>
			</select>
			<div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
				<button
					type="button"
					onClick={props.onCancel}
					disabled={busy}
					style={secondaryButtonStyle}
				>
					Cancel
				</button>
				<button
					type="submit"
					disabled={busy || name.trim().length === 0}
					style={primaryButtonStyle}
				>
					{busy ? 'Creating…' : 'Create'}
				</button>
			</div>
		</form>
	)
}

function TokenRow(props: { token: ApiTokenSummary; onRevoke: () => Promise<void> }) {
	const { token } = props
	return (
		<li
			style={{
				display: 'flex',
				justifyContent: 'space-between',
				alignItems: 'center',
				padding: '6px 8px',
				background: 'var(--surface-sunk)',
				borderRadius: 4,
			}}
		>
			<div style={{ minWidth: 0, flex: 1 }}>
				<div style={{ fontSize: 'var(--font-12)', fontWeight: 500, color: 'var(--text-strong)' }}>
					{token.name}
				</div>
				<div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
					{token.token_prefix} · {token.scope}
				</div>
				<div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
					{token.last_used_at ? `used ${formatRel(token.last_used_at)}` : 'never used'}
					{' · created '}
					{formatRel(token.created_at)}
				</div>
			</div>
			<button
				type="button"
				onClick={() => void props.onRevoke()}
				style={dangerButtonStyle}
			>
				Revoke
			</button>
		</li>
	)
}

function formatRel(iso: string): string {
	const then = Date.parse(iso)
	if (Number.isNaN(then)) return iso
	const diffMs = Date.now() - then
	const sec = Math.floor(diffMs / 1000)
	if (sec < 60) return `${sec}s ago`
	const min = Math.floor(sec / 60)
	if (min < 60) return `${min}m ago`
	const hr = Math.floor(min / 60)
	if (hr < 24) return `${hr}h ago`
	const d = Math.floor(hr / 24)
	if (d < 30) return `${d}d ago`
	return new Date(then).toLocaleDateString()
}

const sectionLabelStyle: React.CSSProperties = {
	fontSize: 11,
	color: 'var(--text-muted)',
	textTransform: 'uppercase',
	letterSpacing: 0.6,
}
const linkButtonStyle: React.CSSProperties = {
	background: 'none',
	border: 'none',
	color: 'var(--accent)',
	fontSize: 'var(--font-12)',
	cursor: 'pointer',
	padding: 0,
}
const inputStyle: React.CSSProperties = {
	padding: '6px 8px',
	fontFamily: 'var(--font-ui)',
	fontSize: 'var(--font-12)',
	background: 'var(--surface-sunk)',
	border: '1px solid var(--border)',
	borderRadius: 4,
	color: 'var(--text-strong)',
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
const secondaryButtonStyle: React.CSSProperties = {
	padding: '6px 12px',
	background: 'transparent',
	border: '1px solid var(--border)',
	borderRadius: 4,
	color: 'var(--text-muted)',
	fontFamily: 'var(--font-ui)',
	fontSize: 'var(--font-12)',
	cursor: 'pointer',
}
const dangerButtonStyle: React.CSSProperties = {
	padding: '4px 10px',
	background: 'transparent',
	border: '1px solid var(--text-danger)',
	borderRadius: 4,
	color: 'var(--text-danger)',
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
const revealBoxStyle: React.CSSProperties = {
	padding: 10,
	background: 'rgba(80, 200, 120, 0.05)',
	border: '1px solid var(--accent)',
	borderRadius: 6,
}
const tokenMonoStyle: React.CSSProperties = {
	fontFamily: 'var(--font-mono)',
	fontSize: 11,
	color: 'var(--text-strong)',
	wordBreak: 'break-all',
	padding: '4px 6px',
	background: 'var(--surface-sunk)',
	borderRadius: 4,
}
