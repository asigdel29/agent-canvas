/**
 * SettingsDrawer — the single source of truth for user-supplied
 * credentials and per-workspace preferences.
 *
 * Lives inside the RightRail (mode='settings'). Same dark surface,
 * same hairline-separator pattern as the Inspector. Opens via:
 *   - TopBar Settings affordance
 *   - "Set it in Settings →" links inside ErrorToast remediations
 *   - The Onboarding wizard's "Connect Claude" step (embedded inline)
 *
 * What it manages:
 *
 *   ANTHROPIC_API_KEY  required for any agent to run. Stored in
 *                      sessionStorage on the canvas; sent on each
 *                      request via x-anthropic-api-key header.
 *                      Orchestrator prefers the header over its env.
 *
 *   E2B_API_KEY        optional, needed only for computer-use.
 *                      Same BYOK flow.
 *
 * Why sessionStorage and not localStorage:
 *   - Keys vanish on tab close, matching most BYOK products
 *   - No write to disk after the tab dies; lower blast radius
 *   - User can always re-paste if they reopen the tab
 *   - Sign-out can clear it trivially
 *
 * Why not server-side per-user storage:
 *   - Requires a user_secrets table + encryption + access control
 *   - Adds blast radius (one DB leak = every user's Claude key)
 *   - Out of scope for the current phase; revisit when multi-tenancy
 *     lands
 *
 * Validation is intentionally soft (prefix check only); the actual
 * key validity is confirmed by the first agent run that uses it.
 */

import { useState } from 'react'
import { TokensSection } from './TokensSection.js'
import { WebhooksSection } from './WebhooksSection.js'

export const SETTINGS_STORAGE = {
	anthropicKey: 'agent-canvas:anthropic_api_key',
	e2bKey: 'agent-canvas:e2b_api_key',
} as const

export interface SettingsValues {
	anthropic_api_key: string
	e2b_api_key: string
}

/** Read both keys from sessionStorage; returns empty strings for unset. */
export function readSettings(): SettingsValues {
	if (typeof window === 'undefined') return { anthropic_api_key: '', e2b_api_key: '' }
	try {
		return {
			anthropic_api_key: window.sessionStorage.getItem(SETTINGS_STORAGE.anthropicKey) ?? '',
			e2b_api_key: window.sessionStorage.getItem(SETTINGS_STORAGE.e2bKey) ?? '',
		}
	} catch {
		return { anthropic_api_key: '', e2b_api_key: '' }
	}
}

/** Write both keys to sessionStorage. Empty string clears. */
export function writeSettings(values: SettingsValues): void {
	if (typeof window === 'undefined') return
	try {
		if (values.anthropic_api_key) {
			window.sessionStorage.setItem(SETTINGS_STORAGE.anthropicKey, values.anthropic_api_key)
		} else {
			window.sessionStorage.removeItem(SETTINGS_STORAGE.anthropicKey)
		}
		if (values.e2b_api_key) {
			window.sessionStorage.setItem(SETTINGS_STORAGE.e2bKey, values.e2b_api_key)
		} else {
			window.sessionStorage.removeItem(SETTINGS_STORAGE.e2bKey)
		}
	} catch {
		// sessionStorage disabled (private mode / sandboxed iframe) — silent fail
	}
}

export interface SettingsDrawerProps {
	readonly onClose: () => void
	/**
	 * Called whenever a save lands, with the persisted values. Lets
	 * the parent re-render anything that depends on the keys (e.g.
	 * dismiss the "anthropic_not_configured" error toast).
	 */
	readonly onSave?: (values: SettingsValues) => void
	/**
	 * Optional orchestrator origin + session JWT. When both are
	 * supplied, the drawer mounts platform sections that talk to the
	 * REST API (TokensSection today; webhooks + billing in P15+P16).
	 * Omitted by callers that only want the local BYOK fields
	 * (e.g. the onboarding wizard's embedded usage).
	 */
	readonly orchestratorUrl?: string
	readonly session?: string
}

export function SettingsDrawer({ onClose, onSave, orchestratorUrl, session }: SettingsDrawerProps) {
	const [values, setValues] = useState<SettingsValues>(() => readSettings())
	const [savedAt, setSavedAt] = useState<number | null>(null)

	function save() {
		const cleaned: SettingsValues = {
			anthropic_api_key: values.anthropic_api_key.trim(),
			e2b_api_key: values.e2b_api_key.trim(),
		}
		writeSettings(cleaned)
		setSavedAt(Date.now())
		onSave?.(cleaned)
	}

	const anthropicShape = isAnthropicShape(values.anthropic_api_key)
	const e2bShape = isE2BShape(values.e2b_api_key)

	return (
		<div
			role="region"
			aria-label="Settings"
			style={{ padding: 'var(--space-3)', display: 'grid', gap: 'var(--space-4)' }}
		>
			<header
				style={{
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'baseline',
				}}
			>
				<span
					style={{
						fontSize: 11,
						color: 'var(--text-muted)',
						textTransform: 'uppercase',
						letterSpacing: 0.6,
					}}
				>
					API keys
				</span>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close settings"
					style={{
						background: 'transparent',
						border: 'none',
						color: 'var(--text-muted)',
						cursor: 'pointer',
						fontSize: 16,
						lineHeight: 1,
						padding: 0,
					}}
				>
					×
				</button>
			</header>

			<KeyField
				label="Claude API key"
				placeholder="sk-ant-..."
				required
				hint="Required for any agent to run. Get one at console.anthropic.com → API keys."
				value={values.anthropic_api_key}
				shapeOk={anthropicShape}
				onChange={(v) =>
					setValues((prev) => ({ ...prev, anthropic_api_key: v }))
				}
			/>

			<KeyField
				label="E2B API key"
				placeholder="e2b_..."
				required={false}
				hint="Optional. Required only for agents with computer-use enabled. Get one at e2b.dev → API keys."
				value={values.e2b_api_key}
				shapeOk={e2bShape}
				onChange={(v) => setValues((prev) => ({ ...prev, e2b_api_key: v }))}
			/>

			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
				}}
			>
				<span
					style={{
						fontSize: 'var(--font-12)',
						color: 'var(--text-muted)',
					}}
				>
					{savedAt
						? `Saved ${secondsSince(savedAt)}s ago`
						: 'Stored in your browser only. Sent per-request to the orchestrator.'}
				</span>
				<button
					type="button"
					onClick={save}
					style={{
						height: 28,
						padding: '0 var(--space-4)',
						background: 'var(--accent)',
						color: 'var(--text-on-accent)',
						border: 'none',
						borderRadius: 'var(--radius-md)',
						font: 'inherit',
						fontFamily: 'var(--font-ui)',
						fontSize: 'var(--font-12)',
						fontWeight: 500,
						cursor: 'pointer',
					}}
				>
					Save
				</button>
			</div>

			{orchestratorUrl && session && (
				<>
					<div
						aria-hidden
						style={{ height: 1, background: 'var(--border)', margin: 'var(--space-2) 0' }}
					/>
					<TokensSection orchestratorUrl={orchestratorUrl} session={session} />
					<div
						aria-hidden
						style={{ height: 1, background: 'var(--border)', margin: 'var(--space-2) 0' }}
					/>
					<WebhooksSection orchestratorUrl={orchestratorUrl} session={session} />
				</>
			)}
		</div>
	)
}

function KeyField({
	label,
	placeholder,
	hint,
	required,
	value,
	shapeOk,
	onChange,
}: {
	label: string
	placeholder: string
	hint: string
	required: boolean
	value: string
	shapeOk: 'ok' | 'wrong-shape' | 'empty'
	onChange: (v: string) => void
}) {
	return (
		<label style={{ display: 'grid', gap: 4 }}>
			<span style={{ fontSize: 'var(--font-13)', fontWeight: 500 }}>
				{label}
				{!required && (
					<span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 4 }}>
						· optional
					</span>
				)}
			</span>
			<input
				type="password"
				autoComplete="off"
				spellCheck={false}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				style={{
					width: '100%',
					padding: '8px var(--space-3)',
					background: 'var(--surface-sunk)',
					border: `1px solid ${
						shapeOk === 'wrong-shape' ? 'var(--status-await)' : 'var(--border)'
					}`,
					borderRadius: 'var(--radius-md)',
					color: 'var(--text-strong)',
					fontFamily: 'var(--font-mono)',
					fontSize: 'var(--font-12)',
				}}
			/>
			<span
				style={{
					fontSize: 11,
					color:
						shapeOk === 'wrong-shape'
							? 'var(--status-await)'
							: 'var(--text-muted)',
					lineHeight: 1.5,
				}}
			>
				{shapeOk === 'wrong-shape'
					? `That doesn't look like a ${label.toLowerCase()}. Double-check the prefix.`
					: hint}
			</span>
		</label>
	)
}

function isAnthropicShape(v: string): 'ok' | 'wrong-shape' | 'empty' {
	const t = v.trim()
	if (t.length === 0) return 'empty'
	return t.startsWith('sk-ant-') && t.length > 16 ? 'ok' : 'wrong-shape'
}

function isE2BShape(v: string): 'ok' | 'wrong-shape' | 'empty' {
	const t = v.trim()
	if (t.length === 0) return 'empty'
	return t.startsWith('e2b_') && t.length > 8 ? 'ok' : 'wrong-shape'
}

function secondsSince(t: number): number {
	return Math.max(0, Math.floor((Date.now() - t) / 1000))
}
