/**
 * SSRF guard for the per-agent OpenAI-compatible base URL.
 *
 * When an agent runs on the `openai` provider, the orchestrator issues a
 * server-side POST to a URL the user supplied. That is classic SSRF
 * surface: left unchecked, a user could point the base URL at an internal
 * service (`http://127.0.0.1:6379`, the cloud metadata endpoint, ...) and
 * use the orchestrator as a confused deputy.
 *
 * This validator applies the same lexical defense as the webhook guard
 * and reuses its private-range detector ({@link isPrivateOrLoopback}) so
 * the two share one definition of "private". It is enforced at two
 * points: agent-create validation (write time) and client construction
 * (use time).
 *
 * Defaults deny non-https and private/loopback hosts. Because running a
 * local model server (LM Studio, Ollama on `127.0.0.1`) is a legitimate
 * BYOK case, two dev-only escape hatches relax the rules:
 *
 *   MODEL_BASE_URL_ALLOW_HTTP=true      permit http:// (local servers).
 *   MODEL_BASE_URL_ALLOW_PRIVATE=true   permit loopback/private hosts.
 *
 * Both default to off so a production deploy refuses internal targets.
 *
 * @author asigdel29
 */

import { isPrivateOrLoopback } from '../webhooks/validateWebhookUrl.js'

/** Outcome of {@link validateModelBaseUrl}: ok, or a machine reason. */
export type ValidateBaseUrlResult =
	| { ok: true }
	| {
			ok: false
			reason: 'malformed_url' | 'unsupported_scheme' | 'empty_host' | 'private_address'
	  }

/**
 * Validate a model base URL against the SSRF rules above.
 *
 * @param input the candidate base URL, e.g. `https://api.openai.com/v1`.
 * @return `{ ok: true }` when safe to fetch, else a reason code.
 */
export function validateModelBaseUrl(input: string): ValidateBaseUrlResult {
	let url: URL
	try {
		url = new URL(input)
	} catch {
		return { ok: false, reason: 'malformed_url' }
	}

	const allowHttp = process.env['MODEL_BASE_URL_ALLOW_HTTP'] === 'true'
	if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
		return { ok: false, reason: 'unsupported_scheme' }
	}

	const host = url.hostname
	if (!host) return { ok: false, reason: 'empty_host' }

	const allowPrivate = process.env['MODEL_BASE_URL_ALLOW_PRIVATE'] === 'true'
	if (!allowPrivate && isPrivateOrLoopback(host)) {
		return { ok: false, reason: 'private_address' }
	}
	return { ok: true }
}
