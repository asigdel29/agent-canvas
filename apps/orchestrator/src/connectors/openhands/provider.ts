/**
 * OpenHands provider adapter (managed agent vendor).
 *
 * Implements ProviderAdapter. OpenHands runs containerized dev
 * environments per agent run; this adapter wraps the cloud API.
 *
 * Real implementation lands in a follow-up PR when the user provides an
 * OpenHands cloud API key.
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

export interface OpenHandsProviderOptions {
	readonly endpoint?: string
	readonly capabilityTtlMs?: number
}

export class OpenHandsProvider implements ProviderAdapter {
	readonly id: VendorId = 'openhands'
	readonly display_name = 'OpenHands'
	readonly webhook: WebhookFramework = buildWebhook({
		provider: 'openhands',
		idempotencyKey: (req) => req.headers['x-openhands-delivery'] ?? 'openhands_unknown',
		verifySignature: async (req, secret) =>
			verifyHmacSha256({
				secret,
				body: req.body,
				providedSignature: req.headers['x-openhands-signature'],
				prefix: 'sha256=',
			}),
	})

	private toolCache: { value: readonly string[]; expires_at_ms: number } | null = null
	private readonly ttlMs: number

	constructor(opts: OpenHandsProviderOptions = {}) {
		this.ttlMs = opts.capabilityTtlMs ?? 5 * 60 * 1000
	}

	async getSupportedTools(): Promise<readonly string[]> {
		const now = Date.now()
		if (this.toolCache && this.toolCache.expires_at_ms > now) return this.toolCache.value
		// OpenHands' containerized env gives broader shell/file access than
		// Codex. The conservative declared set covers the overlap with Codex
		// plus the OpenHands-specific shell tool. Real capability fetch lands
		// in the follow-up PR.
		const builtin = [
			'github.create_pr',
			'github.write_file',
			'github.read_file',
			'github.comment_issue',
			'github.merge_pr',
			'shell.run', // destructive by classification
		]
		this.toolCache = { value: builtin, expires_at_ms: now + this.ttlMs }
		return builtin
	}

	async startRun(_req: StartRunRequest): Promise<{ vendor_run_id: string }> {
		throw new NotImplementedError('openhands.startRun')
	}

	async cancelRun(_run_id: RunId): Promise<void> {
		throw new NotImplementedError('openhands.cancelRun')
	}

	async getStatus(_run_id: RunId): Promise<VendorRunStatusReport> {
		throw new NotImplementedError('openhands.getStatus')
	}
}
