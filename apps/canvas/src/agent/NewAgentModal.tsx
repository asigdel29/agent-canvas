/**
 * NewAgentModal — modal dialog opened from the FloatingToolbar's
 * Agent tool. Captures every field needed to instantiate an agent
 * shape on the canvas:
 *
 *   - name and one-line purpose
 *   - model (Claude Opus / Sonnet / Haiku; defaulted to Sonnet)
 *   - system prompt (multi-line)
 *   - capabilities (computer use, browser use, list of MCP servers)
 *
 * The modal is presentation-only. The parent owns the resulting
 * agent record and decides whether to persist it to the orchestrator
 * before creating the shape on the canvas.
 *
 * Escape closes. Click on the backdrop closes. Cmd/Ctrl+Enter
 * submits. Keyboard-trap inside the modal is delegated to the
 * native dialog element via the focus-loop helpers in `useFocusTrap`
 * (kept inline here so the modal stays self-contained).
 */

import { useEffect, useId, useRef, useState } from 'react'
import {
	type AgentCapabilities,
	type McpServerRef,
	defaultCapabilities,
} from './capabilities.js'

export type ModelId =
	| 'claude-opus-4-7'
	| 'claude-sonnet-4-6'
	| 'claude-haiku-4-5-20251001'

const MODELS: { id: ModelId; label: string; sub: string }[] = [
	{
		id: 'claude-sonnet-4-6',
		label: 'Sonnet 4.6',
		sub: 'Default. Fast, deeply capable, good cost.',
	},
	{
		id: 'claude-opus-4-7',
		label: 'Opus 4.7',
		sub: 'Most capable. Use for the hardest tasks.',
	},
	{
		id: 'claude-haiku-4-5-20251001',
		label: 'Haiku 4.5',
		sub: 'Cheapest, fastest. Good for high-volume routines.',
	},
]

export interface NewAgentDraft {
	readonly name: string
	readonly purpose: string
	readonly model: ModelId
	readonly system_prompt: string
	readonly capabilities: AgentCapabilities
}

export interface NewAgentModalProps {
	readonly open: boolean
	readonly onCreate: (draft: NewAgentDraft) => void
	readonly onClose: () => void
}

export function NewAgentModal({ open, onCreate, onClose }: NewAgentModalProps) {
	const [name, setName] = useState('')
	const [purpose, setPurpose] = useState('')
	const [model, setModel] = useState<ModelId>('claude-sonnet-4-6')
	const [systemPrompt, setSystemPrompt] = useState('')
	const [capabilities, setCapabilities] = useState<AgentCapabilities>(defaultCapabilities())

	const dialogRef = useRef<HTMLDivElement | null>(null)

	// Reset when the modal closes so re-opening gives a fresh draft.
	useEffect(() => {
		if (!open) {
			setName('')
			setPurpose('')
			setModel('claude-sonnet-4-6')
			setSystemPrompt('')
			setCapabilities(defaultCapabilities())
		}
	}, [open])

	// Close on Escape; submit on Cmd/Ctrl+Enter.
	useEffect(() => {
		if (!open) return
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') {
				e.preventDefault()
				onClose()
			}
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
				e.preventDefault()
				submit()
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, name, purpose, model, systemPrompt, capabilities])

	function submit() {
		if (!name.trim()) return
		onCreate({
			name: name.trim(),
			purpose: purpose.trim(),
			model,
			system_prompt: systemPrompt.trim(),
			capabilities,
		})
	}

	if (!open) return null

	return (
		<div
			role="presentation"
			onMouseDown={(e) => {
				// Backdrop click closes; clicks inside the dialog do not.
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
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="new-agent-title"
				style={{
					width: 'min(640px, 100%)',
					maxHeight: '90vh',
					overflow: 'auto',
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
						id="new-agent-title"
						style={{
							margin: 0,
							fontSize: 'var(--font-20)',
							fontWeight: 500,
							letterSpacing: -0.2,
						}}
					>
						New agent
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

				<form
					onSubmit={(e) => {
						e.preventDefault()
						submit()
					}}
					style={{ display: 'grid', gap: 'var(--space-4)', padding: 'var(--space-5)' }}
				>
					<Field label="Name" hint="Shows on the canvas. Keep it short.">
						<input
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Inbox triage"
							autoFocus
							style={inputStyle}
						/>
					</Field>

					<Field label="Purpose" hint="One line. Renders under the name.">
						<input
							type="text"
							value={purpose}
							onChange={(e) => setPurpose(e.target.value)}
							placeholder="Sort GitHub issues by priority every morning"
							style={inputStyle}
						/>
					</Field>

					<Field label="Model">
						<div style={{ display: 'grid', gap: 'var(--space-1)' }}>
							{MODELS.map((m) => (
								<ModelRadio
									key={m.id}
									id={m.id}
									label={m.label}
									sub={m.sub}
									checked={model === m.id}
									onChange={() => setModel(m.id)}
								/>
							))}
						</div>
					</Field>

					<Field label="System prompt" hint="What the agent should always remember.">
						<textarea
							value={systemPrompt}
							onChange={(e) => setSystemPrompt(e.target.value)}
							placeholder="You are a thorough engineering manager…"
							rows={4}
							style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 'var(--font-12)' }}
						/>
					</Field>

					<CapabilitiesSection
						value={capabilities}
						onChange={setCapabilities}
					/>

					<footer
						style={{
							display: 'flex',
							justifyContent: 'space-between',
							alignItems: 'center',
							gap: 'var(--space-2)',
							marginTop: 'var(--space-2)',
						}}
					>
						<span style={{ fontSize: 'var(--font-12)', color: 'var(--text-muted)' }}>
							⌘ Enter to create
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
								type="submit"
								disabled={!name.trim()}
								style={{
									height: 32,
									padding: '0 var(--space-4)',
									background: name.trim() ? 'var(--accent)' : 'var(--surface-sunk)',
									color: name.trim() ? 'var(--text-on-accent)' : 'var(--text-muted)',
									border: 'none',
									borderRadius: 'var(--radius-md)',
									font: 'inherit',
									fontFamily: 'var(--font-ui)',
									fontSize: 'var(--font-13)',
									fontWeight: 500,
									cursor: name.trim() ? 'pointer' : 'not-allowed',
								}}
							>
								Create agent
							</button>
						</div>
					</footer>
				</form>
			</div>
		</div>
	)
}

const inputStyle: React.CSSProperties = {
	width: '100%',
	padding: '8px var(--space-3)',
	background: 'var(--surface-sunk)',
	border: '1px solid var(--border)',
	borderRadius: 'var(--radius-md)',
	color: 'var(--text-strong)',
	font: 'inherit',
	fontFamily: 'var(--font-ui)',
	fontSize: 'var(--font-13)',
}

function Field({
	label,
	hint,
	children,
}: {
	label: string
	hint?: string
	children: React.ReactNode
}) {
	const id = useId()
	return (
		<label htmlFor={id} style={{ display: 'grid', gap: 4 }}>
			<span style={{ fontSize: 'var(--font-13)', fontWeight: 500 }}>{label}</span>
			{hint && <span style={{ fontSize: 'var(--font-12)', color: 'var(--text-muted)' }}>{hint}</span>}
			{children}
		</label>
	)
}

function ModelRadio({
	id,
	label,
	sub,
	checked,
	onChange,
}: {
	id: string
	label: string
	sub: string
	checked: boolean
	onChange: () => void
}) {
	return (
		<label
			style={{
				display: 'grid',
				gridTemplateColumns: 'auto 1fr',
				alignItems: 'flex-start',
				gap: 'var(--space-2)',
				padding: 'var(--space-2) var(--space-3)',
				background: checked ? 'var(--accent-soft)' : 'var(--surface-sunk)',
				border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
				borderRadius: 'var(--radius-md)',
				cursor: 'pointer',
			}}
		>
			<input
				type="radio"
				name="model"
				value={id}
				checked={checked}
				onChange={onChange}
				style={{ marginTop: 3 }}
			/>
			<div style={{ display: 'grid', gap: 2 }}>
				<span style={{ fontSize: 'var(--font-13)', fontWeight: 500 }}>{label}</span>
				<span style={{ fontSize: 'var(--font-12)', color: 'var(--text-muted)' }}>{sub}</span>
			</div>
		</label>
	)
}

function CapabilitiesSection({
	value,
	onChange,
}: {
	value: AgentCapabilities
	onChange: (next: AgentCapabilities) => void
}) {
	return (
		<fieldset
			style={{
				display: 'grid',
				gap: 'var(--space-3)',
				padding: 0,
				border: 'none',
				margin: 0,
			}}
		>
			<legend
				style={{
					padding: 0,
					fontSize: 'var(--font-13)',
					fontWeight: 500,
				}}
			>
				Capabilities
			</legend>

			<CapabilityToggle
				label="Computer use"
				sublabel="Full desktop control via Claude's computer-use tool. Sandboxed Linux VM, screenshot loop."
				enabled={value.computer_use.enabled}
				onToggle={() =>
					onChange({
						...value,
						computer_use: {
							...value.computer_use,
							enabled: !value.computer_use.enabled,
							provider: value.computer_use.enabled ? 'none' : 'e2b',
						},
					})
				}
			/>
			<CapabilityToggle
				label="Browser use"
				sublabel="Headless browser for navigation, scraping, form-fill. Strictly less power than computer use."
				enabled={value.browser_use.enabled}
				onToggle={() =>
					onChange({
						...value,
						browser_use: { ...value.browser_use, enabled: !value.browser_use.enabled },
					})
				}
			/>

			<McpServersEditor
				servers={value.mcp_servers}
				onChange={(mcp_servers) => onChange({ ...value, mcp_servers })}
			/>
		</fieldset>
	)
}

function CapabilityToggle({
	label,
	sublabel,
	enabled,
	onToggle,
}: {
	label: string
	sublabel: string
	enabled: boolean
	onToggle: () => void
}) {
	return (
		<label
			style={{
				display: 'grid',
				gridTemplateColumns: '1fr auto',
				alignItems: 'flex-start',
				gap: 'var(--space-3)',
				padding: 'var(--space-2) var(--space-3)',
				background: 'var(--surface-sunk)',
				border: '1px solid var(--border)',
				borderRadius: 'var(--radius-md)',
				cursor: 'pointer',
			}}
		>
			<div style={{ display: 'grid', gap: 2 }}>
				<span style={{ fontSize: 'var(--font-13)', fontWeight: 500 }}>{label}</span>
				<span style={{ fontSize: 'var(--font-12)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
					{sublabel}
				</span>
			</div>
			<Switch checked={enabled} onChange={onToggle} />
		</label>
	)
}

function Switch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			onClick={onChange}
			style={{
				position: 'relative',
				width: 32,
				height: 18,
				padding: 0,
				background: checked ? 'var(--accent)' : 'var(--border-strong)',
				border: 'none',
				borderRadius: 'var(--radius-pill)',
				cursor: 'pointer',
				transition: 'background var(--motion-chip) var(--ease-default)',
			}}
		>
			<span
				aria-hidden="true"
				style={{
					position: 'absolute',
					top: 2,
					left: checked ? 16 : 2,
					width: 14,
					height: 14,
					background: '#FFFFFF',
					borderRadius: '50%',
					transition: 'left var(--motion-chip) var(--ease-default)',
				}}
			/>
		</button>
	)
}

function McpServersEditor({
	servers,
	onChange,
}: {
	servers: readonly McpServerRef[]
	onChange: (next: readonly McpServerRef[]) => void
}) {
	function addEmpty() {
		onChange([
			...servers,
			{
				id: `mcp_${servers.length + 1}`,
				url: '',
				trust: 'untrusted',
			},
		])
	}
	function update(i: number, patch: Partial<McpServerRef>) {
		const next = servers.slice()
		next[i] = { ...next[i]!, ...patch }
		onChange(next)
	}
	function remove(i: number) {
		onChange(servers.filter((_, j) => j !== i))
	}
	return (
		<div
			style={{
				display: 'grid',
				gap: 'var(--space-2)',
				padding: 'var(--space-3)',
				background: 'var(--surface-sunk)',
				border: '1px solid var(--border)',
				borderRadius: 'var(--radius-md)',
			}}
		>
			<div
				style={{
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'center',
				}}
			>
				<span style={{ fontSize: 'var(--font-13)', fontWeight: 500 }}>
					MCP servers
					{servers.length > 0 && (
						<span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>
							· {servers.length}
						</span>
					)}
				</span>
				<button
					type="button"
					onClick={addEmpty}
					style={{
						height: 24,
						padding: '0 var(--space-3)',
						background: 'transparent',
						color: 'var(--accent)',
						border: '1px solid var(--border)',
						borderRadius: 'var(--radius-md)',
						font: 'inherit',
						fontFamily: 'var(--font-ui)',
						fontSize: 'var(--font-12)',
						fontWeight: 500,
						cursor: 'pointer',
					}}
				>
					+ Add server
				</button>
			</div>
			{servers.length === 0 ? (
				<p style={{ margin: 0, fontSize: 'var(--font-12)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
					None yet. Add Model Context Protocol servers whose tools this agent should
					be able to call.
				</p>
			) : (
				<div style={{ display: 'grid', gap: 'var(--space-2)' }}>
					{servers.map((s, i) => (
						<McpRow
							key={i}
							server={s}
							onChange={(patch) => update(i, patch)}
							onRemove={() => remove(i)}
						/>
					))}
				</div>
			)}
		</div>
	)
}

function McpRow({
	server,
	onChange,
	onRemove,
}: {
	server: McpServerRef
	onChange: (patch: Partial<McpServerRef>) => void
	onRemove: () => void
}) {
	return (
		<div
			style={{
				display: 'grid',
				gridTemplateColumns: '120px 1fr auto auto',
				gap: 'var(--space-2)',
				alignItems: 'center',
			}}
		>
			<input
				type="text"
				value={server.id}
				onChange={(e) => onChange({ id: e.target.value })}
				placeholder="id"
				style={{ ...inputStyle, fontSize: 'var(--font-12)', padding: '6px var(--space-2)' }}
			/>
			<input
				type="url"
				value={server.url}
				onChange={(e) => onChange({ url: e.target.value })}
				placeholder="https://mcp.example.com/sse"
				style={{ ...inputStyle, fontSize: 'var(--font-12)', padding: '6px var(--space-2)' }}
			/>
			<select
				value={server.trust}
				onChange={(e) => onChange({ trust: e.target.value as 'trusted' | 'untrusted' })}
				style={{
					height: 28,
					padding: '0 var(--space-2)',
					background: 'var(--surface-elev)',
					border: '1px solid var(--border)',
					borderRadius: 'var(--radius-md)',
					color: 'var(--text-strong)',
					font: 'inherit',
					fontFamily: 'var(--font-ui)',
					fontSize: 'var(--font-12)',
				}}
				title="Trusted servers can have their tools called without per-call confirmation."
			>
				<option value="untrusted">untrusted</option>
				<option value="trusted">trusted</option>
			</select>
			<button
				type="button"
				onClick={onRemove}
				aria-label="Remove server"
				style={{
					width: 24,
					height: 24,
					padding: 0,
					background: 'transparent',
					color: 'var(--text-muted)',
					border: '1px solid var(--border)',
					borderRadius: 'var(--radius-md)',
					cursor: 'pointer',
					fontSize: 14,
					lineHeight: 1,
				}}
			>
				×
			</button>
		</div>
	)
}
