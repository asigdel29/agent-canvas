/**
 * In-memory store for user-supplied API keys (BYOK).
 *
 * Keys are held in a module-level singleton for the lifetime of the tab's
 * JavaScript context — never written to `localStorage`, `sessionStorage`,
 * cookies, or any other persistent surface. This is the lowest-blast-radius
 * place to keep a credential a user pastes:
 *
 *   - Nothing sensitive is persisted to disk or Web Storage, so a stolen
 *     profile directory or an XSS read of storage yields no keys.
 *   - The keys vanish on reload or tab close; the user re-pastes them. That
 *     is the deliberate trade-off for not persisting a secret.
 *
 * Both the Settings drawer (which captures the keys) and the agent API
 * client (which attaches them as per-request headers) import this module,
 * so they share one instance — a write in Settings is immediately visible
 * to the next request.
 *
 * The session JWT, room id, and similar non-secret routing values continue
 * to live in `sessionStorage` (see App.tsx); they must survive a reload for
 * the auth-stash flow and are not model credentials.
 *
 * @author asigdel29
 */

/** The full set of BYOK keys the canvas manages. Empty string means unset. */
export interface SettingsValues {
	anthropic_api_key: string
	openai_api_key: string
	e2b_api_key: string
}

/** Logical key names, decoupled from any storage-key string. */
export type ApiKeyName = 'anthropic' | 'openai' | 'e2b'

const EMPTY: SettingsValues = {
	anthropic_api_key: '',
	openai_api_key: '',
	e2b_api_key: '',
}

// The single in-memory record. Module scope = one instance per tab.
const keys: SettingsValues = { ...EMPTY }

/** Return a copy of all keys; unset keys are empty strings. */
export function readApiKeys(): SettingsValues {
	return { ...keys }
}

/**
 * Replace all keys. Values are trimmed; an empty string clears that key.
 *
 * @param values the keys to store in memory.
 */
export function writeApiKeys(values: SettingsValues): void {
	keys.anthropic_api_key = values.anthropic_api_key.trim()
	keys.openai_api_key = values.openai_api_key.trim()
	keys.e2b_api_key = values.e2b_api_key.trim()
}

/**
 * Read one key by logical name, trimmed. Returns an empty string when unset.
 *
 * @param name which key to read.
 */
export function readApiKey(name: ApiKeyName): string {
	switch (name) {
		case 'anthropic':
			return keys.anthropic_api_key
		case 'openai':
			return keys.openai_api_key
		case 'e2b':
			return keys.e2b_api_key
	}
}
