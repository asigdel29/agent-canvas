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
	NormalizedWebhookEvent,
	ProviderAdapter,
	StartRunRequest,
	VendorRunInfo,
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

	/**
	 * Codex webhook payload shape (per the vendor's API docs):
	 *
	 *   { id, type, run: { id, status }, data? }
	 *
	 * `type` maps to our internal RunEventKind via the table below.
	 */
	extractRunInfo(event: NormalizedWebhookEvent): VendorRunInfo | null {
		const p = event.payload as {
			run?: { id?: string; status?: string }
			data?: Record<string, unknown>
		}
		const vendor_run_id = p.run?.id
		if (typeof vendor_run_id !== 'string') return null
		const kind = codexEventTypeToKind(event.event_type)
		if (!kind) return null
		return {
			vendor_run_id,
			event_kind: kind,
			payload: p.data ?? {},
		}
	}
}

function codexEventTypeToKind(t: string): VendorRunInfo['event_kind'] | null {
	switch (t) {
		case 'run.queued':
			return 'queued'
		case 'run.provisioning':
			return 'provisioning'
		case 'run.running':
			return 'running'
		case 'run.awaiting_input':
			return 'awaiting_input'
		case 'run.progress':
			return 'progress'
		case 'run.tool_call':
			return 'tool_call'
		case 'run.approval_request':
			return 'approval_request'
		case 'run.succeeded':
			return 'succeeded'
		case 'run.failed':
			return 'failed'
		case 'run.cancelled':
			return 'cancelled'
		default:
			return null
	}
}
