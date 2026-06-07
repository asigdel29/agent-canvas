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
 *   ANTHROPIC_API_KEY  required for any agent to run. Held in memory on
 *                      the canvas; sent on each request via the
 *                      x-anthropic-api-key header. The orchestrator
 *                      prefers the header over its env.
 *
 *   E2B_API_KEY        optional, needed only for computer-use.
 *                      Same BYOK flow.
 *
 * Why in-memory only (see keyStore.ts):
 *   - Nothing sensitive is written to disk or Web Storage, so a stolen
 *     profile or an XSS read of storage yields no keys (lowest blast
 *     radius).
 *   - Keys vanish on reload or tab close; the user re-pastes them. That
 *     is the deliberate trade-off for not persisting a credential.
 *
 * Why not server-side per-user storage:
 *   - Requires a user_secrets table + encryption + access control
 *   - Adds blast radius (one DB leak = every user's Claude key)
 *   - Out of scope for the current phase; revisit when multi-tenancy
 *     lands
 *
 * Validation is intentionally soft (prefix check only); the actual
 * key validity is confirmed by the first agent run that uses it.
 * @author asigdel29
 */

import { useState } from 'react'
import { readApiKeys, writeApiKeys, type SettingsValues } from './keyStore.js'
import { TokensSection } from './TokensSection.js'
import { WebhooksSection } from './WebhooksSection.js'

export type { SettingsValues } from './keyStore.js'

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
	const [values, setValues] = useState<SettingsValues>(() => readApiKeys())
	const [savedAt, setSavedAt] = useState<number | null>(null)

	function save() {
		const cleaned: SettingsValues = {
			anthropic_api_key: values.anthropic_api_key.trim(),
			openai_api_key: values.openai_api_key.trim(),
			e2b_api_key: values.e2b_api_key.trim(),
		}
		writeApiKeys(cleaned)
		setSavedAt(Date.now())
		onSave?.(cleaned)
	}

	const anthropicShape = isAnthropicShape(values.anthropic_api_key)
	const openaiShape = isOpenAiShape(values.openai_api_key)
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
				label="OpenAI-compatible API key"
				placeholder="sk-..."
				required={false}
				hint="Optional. Used by agents on the OpenAI-compatible provider (OpenAI, Gemini, Groq, OpenRouter, local). Set the endpoint per-agent in the New agent dialog."
				value={values.openai_api_key}
				shapeOk={openaiShape}
				onChange={(v) => setValues((prev) => ({ ...prev, openai_api_key: v }))}
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
						: 'Kept in memory for this tab only — never saved to disk. Re-paste after a reload.'}
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

/**
 * OpenAI-compatible keys vary widely by provider (OpenAI `sk-…`, Gemini,
 * Groq `gsk_…`, OpenRouter `sk-or-…`, local servers with no prefix), so
 * the only soft check is non-empty. Validity is confirmed on first run.
 */
function isOpenAiShape(v: string): 'ok' | 'wrong-shape' | 'empty' {
	return v.trim().length === 0 ? 'empty' : 'ok'
}

function isE2BShape(v: string): 'ok' | 'wrong-shape' | 'empty' {
	const t = v.trim()
	if (t.length === 0) return 'empty'
	return t.startsWith('e2b_') && t.length > 8 ? 'ok' : 'wrong-shape'
}

function secondsSince(t: number): number {
	return Math.max(0, Math.floor((Date.now() - t) / 1000))
}
