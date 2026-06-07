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
 * @author asigdel29
 */

import { useEffect, useId, useRef, useState } from 'react'
import {
	type AgentCapabilities,
	type McpServerRef,
	defaultCapabilities,
} from './capabilities.js'
import { ORCHESTRATOR_URL } from '../config.js'

/**
 * The model family an agent runs on.
 *
 *   'anthropic'   native Claude models on the Anthropic API.
 *   'openai'      any OpenAI-compatible `/chat/completions` endpoint,
 *                 chosen by a base URL (OpenAI, Gemini, Groq, OpenRouter,
 *                 a local server, ...).
 */
export type Provider = 'anthropic' | 'openai'

/** Anthropic preset model ids the modal offers as radios. */
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

const DEFAULT_ANTHROPIC_MODEL: ModelId = 'claude-sonnet-4-6'

/**
 * Presets for the OpenAI-compatible provider. Each fills a base URL and a
 * sensible default model id; "Custom" leaves both blank so any endpoint
 * can be entered. The API key is supplied separately in Settings.
 */
interface OpenAiPreset {
	readonly id: string
	readonly label: string
	readonly base_url: string
	readonly model: string
}

const OPENAI_PRESETS: readonly OpenAiPreset[] = [
	{ id: 'openai', label: 'OpenAI', base_url: 'https://api.openai.com/v1', model: 'gpt-4o' },
	{
		id: 'gemini',
		label: 'Google Gemini',
		base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
		model: 'gemini-2.0-flash',
	},
	{
		id: 'groq',
		label: 'Groq',
		base_url: 'https://api.groq.com/openai/v1',
		model: 'llama-3.3-70b-versatile',
	},
	{
		id: 'openrouter',
		label: 'OpenRouter',
		base_url: 'https://openrouter.ai/api/v1',
		model: 'openai/gpt-4o',
	},
	{ id: 'custom', label: 'Custom (any OpenAI-compatible URL)', base_url: '', model: '' },
]

export interface NewAgentDraft {
	readonly name: string
	readonly purpose: string
	/** Which model family the agent runs on. */
	readonly provider: Provider
	/** Provider-specific model id (a Claude id, or an OpenAI-style id). */
	readonly model: string
	/** OpenAI-compatible API root; null for the Anthropic provider. */
	readonly model_base_url: string | null
	readonly system_prompt: string
	readonly capabilities: AgentCapabilities
}

export interface NewAgentModalProps {
	readonly open: boolean
	readonly onCreate: (draft: NewAgentDraft) => void
	readonly onClose: () => void
	/**
	 * Optional starter draft. When supplied (e.g. from picking a
	 * starter in the EmptyState), the modal opens pre-filled.
	 * Switching away by closing+reopening with no initialDraft
	 * resets to blank.
	 */
	readonly initialDraft?: NewAgentDraft | null | undefined
	/**
	 * When set, the modal is in EDIT mode for an existing agent.
	 * The title and primary button label flip ('Edit agent' /
	 * 'Save changes'), and submit is wired to `onSave` instead
	 * of `onCreate`. Both callbacks coexist so a single modal
	 * handles create + edit without two component copies.
	 */
	readonly editingAgentId?: string | null | undefined
	readonly onSave?: (draft: NewAgentDraft) => void
}

export function NewAgentModal({
	open,
	onCreate,
	onClose,
	initialDraft,
	editingAgentId,
	onSave,
}: NewAgentModalProps) {
	const isEditing = Boolean(editingAgentId)
	const [name, setName] = useState('')
	const [purpose, setPurpose] = useState('')
	const [provider, setProvider] = useState<Provider>('anthropic')
	const [model, setModel] = useState<string>(DEFAULT_ANTHROPIC_MODEL)
	const [baseUrl, setBaseUrl] = useState<string>('')
	const [systemPrompt, setSystemPrompt] = useState('')
	const [capabilities, setCapabilities] = useState<AgentCapabilities>(defaultCapabilities())

	// Switch model family. Each provider resets to its own sensible
	// default so the form never carries an Anthropic model id into the
	// OpenAI fields or vice versa.
	function changeProvider(next: Provider) {
		setProvider(next)
		if (next === 'anthropic') {
			setModel(DEFAULT_ANTHROPIC_MODEL)
			setBaseUrl('')
		} else {
			const first = OPENAI_PRESETS[0]!
			setBaseUrl(first.base_url)
			setModel(first.model)
		}
	}

	// Apply an OpenAI preset: named presets fill the base URL + model;
	// "Custom" leaves the fields for the user to edit directly.
	function applyPreset(id: string) {
		const preset = OPENAI_PRESETS.find((p) => p.id === id)
		if (!preset || preset.id === 'custom') return
		setBaseUrl(preset.base_url)
		setModel(preset.model)
	}

	// The select reflects the current base URL; an unmatched URL reads as
	// "Custom" so a hand-edited endpoint stays selectable.
	const selectedPreset =
		OPENAI_PRESETS.find((p) => p.id !== 'custom' && p.base_url === baseUrl)?.id ?? 'custom'

	// Create requires a name and a model; the OpenAI provider also needs
	// a base URL. The backend re-validates and SSRF-checks the URL.
	const canSubmit =
		name.trim().length > 0 &&
		model.trim().length > 0 &&
		(provider === 'anthropic' || baseUrl.trim().length > 0)

	const dialogRef = useRef<HTMLDivElement | null>(null)

	// Reset/prefill when the modal opens. A fresh open with no
	// initialDraft gives a blank form; opening with a starter draft
	// pre-fills everything. Closing always wipes so the next open
	// starts from a known state.
	useEffect(() => {
		if (open) {
			setName(initialDraft?.name ?? '')
			setPurpose(initialDraft?.purpose ?? '')
			setProvider(initialDraft?.provider ?? 'anthropic')
			setModel(initialDraft?.model ?? DEFAULT_ANTHROPIC_MODEL)
			setBaseUrl(initialDraft?.model_base_url ?? '')
			setSystemPrompt(initialDraft?.system_prompt ?? '')
			setCapabilities(initialDraft?.capabilities ?? defaultCapabilities())
		} else {
			setName('')
			setPurpose('')
			setProvider('anthropic')
			setModel(DEFAULT_ANTHROPIC_MODEL)
			setBaseUrl('')
			setSystemPrompt('')
			setCapabilities(defaultCapabilities())
		}
	}, [open, initialDraft])

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
	}, [open, name, purpose, provider, model, baseUrl, systemPrompt, capabilities])

	function submit() {
		if (!canSubmit) return
		const draft: NewAgentDraft = {
			name: name.trim(),
			purpose: purpose.trim(),
			provider,
			model: model.trim(),
			model_base_url: provider === 'openai' ? baseUrl.trim() || null : null,
			system_prompt: systemPrompt.trim(),
			capabilities,
		}
		if (isEditing && onSave) {
			onSave(draft)
		} else {
			onCreate(draft)
		}
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
						{isEditing ? 'Edit agent' : 'New agent'}
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

					<Field label="Provider">
						<div
							style={{
								display: 'grid',
								gridTemplateColumns: '1fr 1fr',
								gap: 'var(--space-2)',
							}}
						>
							<ProviderTab
								label="Anthropic"
								sub="Claude models"
								checked={provider === 'anthropic'}
								onClick={() => changeProvider('anthropic')}
							/>
							<ProviderTab
								label="OpenAI-compatible"
								sub="OpenAI · Gemini · Groq · local"
								checked={provider === 'openai'}
								onClick={() => changeProvider('openai')}
							/>
						</div>
					</Field>

					{provider === 'anthropic' ? (
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
					) : (
						<>
							<Field
								label="Preset"
								hint="Pick a provider, or Custom for any OpenAI-compatible endpoint."
							>
								<select
									value={selectedPreset}
									onChange={(e) => applyPreset(e.target.value)}
									style={{ ...inputStyle, cursor: 'pointer' }}
								>
									{OPENAI_PRESETS.map((p) => (
										<option key={p.id} value={p.id}>
											{p.label}
										</option>
									))}
								</select>
							</Field>
							<Field
								label="Base URL"
								hint="API root. The orchestrator appends /chat/completions and sends your key from Settings."
							>
								<input
									type="url"
									value={baseUrl}
									onChange={(e) => setBaseUrl(e.target.value)}
									placeholder="https://api.openai.com/v1"
									style={inputStyle}
								/>
							</Field>
							<Field label="Model" hint="The model id this endpoint exposes.">
								<input
									type="text"
									value={model}
									onChange={(e) => setModel(e.target.value)}
									placeholder="gpt-4o"
									style={inputStyle}
								/>
							</Field>
						</>
					)}

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
							{isEditing ? '⌘ Enter to save' : '⌘ Enter to create'}
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
								disabled={!canSubmit}
								style={{
									height: 32,
									padding: '0 var(--space-4)',
									background: canSubmit ? 'var(--accent)' : 'var(--surface-sunk)',
									color: canSubmit ? 'var(--text-on-accent)' : 'var(--text-muted)',
									border: 'none',
									borderRadius: 'var(--radius-md)',
									font: 'inherit',
									fontFamily: 'var(--font-ui)',
									fontSize: 'var(--font-13)',
									fontWeight: 500,
									cursor: canSubmit ? 'pointer' : 'not-allowed',
								}}
							>
								{isEditing ? 'Save changes' : 'Create agent'}
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

/**
 * A two-state segmented control cell used to pick the model provider.
 * Rendered as a button so the whole tile is the hit target.
 */
function ProviderTab({
	label,
	sub,
	checked,
	onClick,
}: {
	label: string
	sub: string
	checked: boolean
	onClick: () => void
}) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={checked}
			onClick={onClick}
			style={{
				display: 'grid',
				gap: 2,
				textAlign: 'left',
				padding: 'var(--space-2) var(--space-3)',
				background: checked ? 'var(--accent-soft)' : 'var(--surface-sunk)',
				border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
				borderRadius: 'var(--radius-md)',
				cursor: 'pointer',
				font: 'inherit',
				fontFamily: 'var(--font-ui)',
				color: 'var(--text-strong)',
			}}
		>
			<span style={{ fontSize: 'var(--font-13)', fontWeight: 500 }}>{label}</span>
			<span style={{ fontSize: 'var(--font-12)', color: 'var(--text-muted)' }}>{sub}</span>
		</button>
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

/**
 * Probe state for the inline MCP test button.
 *   idle       no probe attempted yet
 *   probing    request in flight (button greys out)
 *   ok         server reachable; show tool count
 *   error      server unreachable; show the orchestrator's reason
 */
type ProbeState =
	| { kind: 'idle' }
	| { kind: 'probing' }
	| { kind: 'ok'; tool_count: number }
	| { kind: 'error'; message: string }

function McpRow({
	server,
	onChange,
	onRemove,
}: {
	server: McpServerRef
	onChange: (patch: Partial<McpServerRef>) => void
	onRemove: () => void
}) {
	const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' })

	async function runProbe() {
		const url = server.url.trim()
		if (!url) {
			setProbe({ kind: 'error', message: 'URL is empty' })
			return
		}
		setProbe({ kind: 'probing' })
		try {
			// Same authorization the rest of agentApi uses. We read the
			// session JWT from sessionStorage directly here so this row
			// doesn't need to be threaded through a context.
			const orchestratorUrl = ORCHESTRATOR_URL
			const session =
				(typeof window !== 'undefined' &&
					window.sessionStorage.getItem('agent-canvas:session')) ||
				''
			const res = await fetch(`${orchestratorUrl}/api/agents/probe-mcp`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${session}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					url,
					...(server.auth?.type === 'bearer' && server.auth.token
						? { auth: { type: 'bearer', token: server.auth.token } }
						: {}),
				}),
			})
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { detail?: string }
				setProbe({
					kind: 'error',
					message: body.detail ?? `HTTP ${res.status}`,
				})
				return
			}
			const body = (await res.json()) as { count: number }
			setProbe({ kind: 'ok', tool_count: body.count })
		} catch (err) {
			setProbe({
				kind: 'error',
				message: err instanceof Error ? err.message : String(err),
			})
		}
	}

	const probeLabel =
		probe.kind === 'probing'
			? '…'
			: probe.kind === 'ok'
				? `✓ ${probe.tool_count}`
				: probe.kind === 'error'
					? '✗'
					: 'Test'
	const probeColor =
		probe.kind === 'ok'
			? 'var(--status-succ)'
			: probe.kind === 'error'
				? 'var(--live)'
				: 'var(--text-muted)'

	return (
		<div style={{ display: 'grid', gap: 4 }}>
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: '120px 1fr auto auto auto',
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
					onChange={(e) => {
						onChange({ url: e.target.value })
						setProbe({ kind: 'idle' })
					}}
					placeholder="https://mcp.example.com/sse"
					style={{ ...inputStyle, fontSize: 'var(--font-12)', padding: '6px var(--space-2)' }}
				/>
				<button
					type="button"
					onClick={runProbe}
					disabled={probe.kind === 'probing' || !server.url.trim()}
					title="Open a one-shot connection to this server, list its tools, close. Never calls any tool."
					style={{
						height: 28,
						minWidth: 56,
						padding: '0 var(--space-2)',
						background: 'transparent',
						color: probeColor,
						border: `1px solid ${
							probe.kind === 'ok'
								? 'var(--status-succ)'
								: probe.kind === 'error'
									? 'var(--live)'
									: 'var(--border)'
						}`,
						borderRadius: 'var(--radius-md)',
						font: 'inherit',
						fontFamily: 'var(--font-mono)',
						fontSize: 11,
						fontWeight: 500,
						cursor:
							probe.kind === 'probing' || !server.url.trim() ? 'not-allowed' : 'pointer',
					}}
				>
					{probeLabel}
				</button>
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
			{probe.kind === 'error' && (
				<span
					style={{
						fontSize: 11,
						color: 'var(--live)',
						fontFamily: 'var(--font-mono)',
						paddingLeft: 'var(--space-1)',
					}}
				>
					{probe.message}
				</span>
			)}
			{probe.kind === 'ok' && (
				<span
					style={{
						fontSize: 11,
						color: 'var(--status-succ)',
						paddingLeft: 'var(--space-1)',
					}}
				>
					Connected · {probe.tool_count} {probe.tool_count === 1 ? 'tool' : 'tools'}{' '}
					exposed
				</span>
			)}
		</div>
	)
}
