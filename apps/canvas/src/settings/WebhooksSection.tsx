/**
 * WebhooksSection — list / register / revoke outbound webhook
 * endpoints inline in the Settings drawer.
 *
 * Mint reveal is one-shot just like tokens: the signing_secret
 * appears in a monospaced box with a Copy button and the user has
 * to dismiss the reveal before the form resets. There is no
 * recovery path — losing the secret means re-registering the
 * endpoint with a new one.
 *
 * Event subscription UX: a multi-select checkbox list of known
 * audit actions plus a top "All events (*)" toggle. Wildcard is
 * the default for foundation (matches what most receivers want);
 * exact subscriptions cut delivery cost for high-traffic events.
 */

import { useEffect, useState } from 'react'
import {
	AVAILABLE_EVENTS,
	WebhooksApi,
	WebhooksApiError,
	type WebhookEndpointSummary,
} from './webhooksApi.js'

export interface WebhooksSectionProps {
	readonly orchestratorUrl: string
	readonly session: string
}

export function WebhooksSection(props: WebhooksSectionProps) {
	const api = new WebhooksApi({ baseUrl: props.orchestratorUrl, session: props.session })
	const [endpoints, setEndpoints] = useState<readonly WebhookEndpointSummary[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)
	const [reveal, setReveal] = useState<{ url: string; secret: string } | null>(null)
	const [copied, setCopied] = useState(false)

	async function refresh(): Promise<void> {
		try {
			const items = await api.list()
			setEndpoints(items)
			setError(null)
		} catch (err) {
			setError(err instanceof WebhooksApiError ? err.message : 'failed_to_load')
		}
	}

	useEffect(() => {
		void refresh()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.orchestratorUrl, props.session])

	async function handleRegister(input: {
		url: string
		events: readonly string[]
		description: string
	}): Promise<void> {
		try {
			const issued = await api.register({
				url: input.url,
				events: input.events,
				description: input.description,
			})
			setReveal({ url: issued.record.url, secret: issued.signing_secret })
			setCreating(false)
			await refresh()
		} catch (err) {
			setError(err instanceof WebhooksApiError ? err.message : 'register_failed')
		}
	}

	async function handleRevoke(id: string, url: string): Promise<void> {
		const ok = window.confirm(`Revoke the endpoint for ${url}? Deliveries stop immediately.`)
		if (!ok) return
		try {
			await api.revoke(id)
			await refresh()
		} catch (err) {
			setError(err instanceof WebhooksApiError ? err.message : 'revoke_failed')
		}
	}

	async function handleCopy(): Promise<void> {
		if (!reveal) return
		try {
			await navigator.clipboard.writeText(reveal.secret)
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
				<span style={sectionLabelStyle}>Webhooks</span>
				<button
					type="button"
					onClick={() => setCreating((c) => !c)}
					style={linkButtonStyle}
				>
					{creating ? 'Cancel' : '+ New endpoint'}
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
						Signing secret for <span style={{ fontFamily: 'var(--font-mono)' }}>{reveal.url}</span> —
						copy now; not retrievable later.
					</div>
					<div style={tokenMonoStyle}>{reveal.secret}</div>
					<div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
						<button type="button" onClick={handleCopy} style={primaryButtonStyle}>
							{copied ? 'Copied' : 'Copy secret'}
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
				<RegisterEndpointForm
					onSubmit={handleRegister}
					onCancel={() => setCreating(false)}
				/>
			)}

			{endpoints === null && !error && (
				<div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-12)' }}>Loading…</div>
			)}
			{endpoints !== null && endpoints.length === 0 && (
				<div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-12)' }}>
					No endpoints registered.
				</div>
			)}
			{endpoints !== null && endpoints.length > 0 && (
				<ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }}>
					{endpoints.map((e) => (
						<EndpointRow
							key={e.id}
							endpoint={e}
							onRevoke={() => handleRevoke(e.id, e.url)}
						/>
					))}
				</ul>
			)}
		</section>
	)
}

function RegisterEndpointForm(props: {
	onSubmit: (input: { url: string; events: readonly string[]; description: string }) => Promise<void>
	onCancel: () => void
}) {
	const [url, setUrl] = useState('')
	const [description, setDescription] = useState('')
	const [wildcard, setWildcard] = useState(true)
	const [selected, setSelected] = useState<Set<string>>(new Set())
	const [busy, setBusy] = useState(false)

	function toggle(event: string): void {
		setSelected((prev) => {
			const next = new Set(prev)
			if (next.has(event)) next.delete(event)
			else next.add(event)
			return next
		})
	}

	return (
		<form
			onSubmit={async (ev) => {
				ev.preventDefault()
				const trimmed = url.trim()
				if (!trimmed) return
				const events = wildcard ? ['*'] : Array.from(selected)
				if (!wildcard && events.length === 0) return
				setBusy(true)
				try {
					await props.onSubmit({ url: trimmed, events, description: description.trim() })
				} finally {
					setBusy(false)
				}
			}}
			style={{
				display: 'grid',
				gap: 6,
				padding: 8,
				border: '1px solid var(--border)',
				borderRadius: 6,
			}}
		>
			<input
				autoFocus
				placeholder="https://api.example.com/webhook"
				value={url}
				onChange={(e) => setUrl(e.target.value)}
				disabled={busy}
				style={inputStyle}
			/>
			<input
				placeholder="Description (optional)"
				value={description}
				onChange={(e) => setDescription(e.target.value)}
				disabled={busy}
				style={inputStyle}
			/>
			<label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--font-12)' }}>
				<input
					type="checkbox"
					checked={wildcard}
					onChange={(e) => setWildcard(e.target.checked)}
					disabled={busy}
				/>
				Receive all events (recommended)
			</label>
			{!wildcard && (
				<div
					style={{
						display: 'grid',
						gap: 2,
						maxHeight: 140,
						overflowY: 'auto',
						padding: 4,
						background: 'var(--surface-sunk)',
						borderRadius: 4,
					}}
				>
					{AVAILABLE_EVENTS.map((evt) => (
						<label
							key={evt}
							style={{
								display: 'flex',
								gap: 6,
								alignItems: 'center',
								fontSize: 11,
								fontFamily: 'var(--font-mono)',
							}}
						>
							<input
								type="checkbox"
								checked={selected.has(evt)}
								onChange={() => toggle(evt)}
								disabled={busy}
							/>
							{evt}
						</label>
					))}
				</div>
			)}
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
					disabled={busy || url.trim().length === 0}
					style={primaryButtonStyle}
				>
					{busy ? 'Registering…' : 'Register'}
				</button>
			</div>
		</form>
	)
}

function EndpointRow(props: {
	endpoint: WebhookEndpointSummary
	onRevoke: () => Promise<void>
}) {
	const { endpoint } = props
	const host = (() => {
		try {
			return new URL(endpoint.url).host
		} catch {
			return endpoint.url
		}
	})()
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
				<div
					style={{
						fontSize: 'var(--font-12)',
						fontWeight: 500,
						color: 'var(--text-strong)',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
					}}
				>
					{host}
				</div>
				<div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
					{endpoint.events.join(', ')}
				</div>
				{endpoint.description && (
					<div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{endpoint.description}</div>
				)}
			</div>
			<button type="button" onClick={() => void props.onRevoke()} style={dangerButtonStyle}>
				Revoke
			</button>
		</li>
	)
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
