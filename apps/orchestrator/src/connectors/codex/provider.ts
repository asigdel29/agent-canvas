/**
 * Codex provider adapter (managed agent vendor).
 *
 * Implements ProviderAdapter, not Connector. The orchestrator delegates
 * agent execution to Codex's hosted runtime; this adapter wraps:
 *
 *   - startRun  → POST to the vendor's runs API
 *   - getStatus → GET on the run resource
 *   - cancelRun → DELETE on the run resource
 *   - getSupportedTools → cached live capability (CEO/eng decision 39)
 *   - webhook  → vendor signature + delivery-id idempotency
 *
 * This skeleton declares the interface and stubs the methods; the real
 * implementation lands in a follow-up PR when the user provides an
 * account and an API key.
 */

import type {
	ProviderAdapter,
	StartRunRequest,
	VendorRunStatusReport,
	WebhookFramework,
} from '@agent-canvas/connector-core'
import type { RunId, VendorId } from '@agent-canvas/orchestrator-types'
import { verifyHmacSha256 } from '../_crypto.js'
import { buildWebhook, NotImplementedError } from '../_stubs.js'

export interface CodexProviderOptions {
	/** Codex API endpoint, e.g., https://api.codex.example.com */
	readonly endpoint?: string
	/** TTL for the supported-tools cache. */
	readonly capabilityTtlMs?: number
}

export class CodexProvider implements ProviderAdapter {
	readonly id: VendorId = 'codex'
	readonly display_name = 'Codex'
	readonly webhook: WebhookFramework = buildWebhook({
		provider: 'codex',
		idempotencyKey: (req) => req.headers['x-codex-delivery'] ?? 'codex_unknown',
		verifySignature: async (req, secret) =>
			verifyHmacSha256({
				secret,
				body: req.body,
				providedSignature: req.headers['x-codex-signature'],
				prefix: 'sha256=',
			}),
	})

	private toolCache: { value: readonly string[]; expires_at_ms: number } | null = null
	private readonly ttlMs: number

	constructor(opts: CodexProviderOptions = {}) {
		this.ttlMs = opts.capabilityTtlMs ?? 5 * 60 * 1000
	}

	async getSupportedTools(): Promise<readonly string[]> {
		const now = Date.now()
		if (this.toolCache && this.toolCache.expires_at_ms > now) return this.toolCache.value
		// Stub: declare a conservative built-in tool set until the real
		// capability fetch is wired.
		const builtin = [
			'github.create_pr',
			'github.write_file',
			'github.comment_issue',
			'github.merge_pr',
			'github.read_file',
		]
		this.toolCache = { value: builtin, expires_at_ms: now + this.ttlMs }
		return builtin
	}

	async startRun(_req: StartRunRequest): Promise<{ vendor_run_id: string }> {
		throw new NotImplementedError('codex.startRun')
	}

	async cancelRun(_run_id: RunId): Promise<void> {
		throw new NotImplementedError('codex.cancelRun')
	}

	async getStatus(_run_id: RunId): Promise<VendorRunStatusReport> {
		throw new NotImplementedError('codex.getStatus')
	}
}
