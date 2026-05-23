/**
 * MockProvider — in-memory ProviderAdapter useful for tests and the
 * E2E cross-stack harness.
 *
 * Behavior is deterministic and parameterizable: callers configure the
 * sequence of "vendor events" the provider will produce, and the mock
 * delivers them via `simulateWebhook` to drive the orchestrator end-to-end.
 *
 * NOT used in production; the two real providers (Codex, OpenHands)
 * live in this same directory as separate adapters.
 */

import type {
	NormalizedWebhookEvent,
	ProviderAdapter,
	StartRunRequest,
	VendorRunStatus,
	VendorRunStatusReport,
	WebhookFramework,
	WebhookRequest,
} from '@agent-canvas/connector-core'
import { VendorRateLimitError } from '@agent-canvas/connector-core'
import type { RunId, VendorId } from '@agent-canvas/orchestrator-types'

export interface MockProviderOptions {
	readonly id?: VendorId
	readonly supportedTools?: readonly string[]
	/** Sequence of statuses returned by getStatus on successive calls. */
	readonly statusScript?: readonly VendorRunStatus[]
	/** If set, getStatus throws VendorRateLimitError on this many initial calls. */
	readonly rateLimitFirstN?: number
}

export class MockProvider implements ProviderAdapter {
	readonly id: VendorId
	readonly display_name: string
	readonly webhook: WebhookFramework
	private readonly supportedTools: readonly string[]
	private readonly statusScript: readonly VendorRunStatus[]
	private readonly rateLimitFirstN: number
	private statusCursor = 0
	private rateLimitCursor = 0

	readonly receivedStarts: StartRunRequest[] = []
	readonly receivedCancels: RunId[] = []

	constructor(opts: MockProviderOptions = {}) {
		this.id = opts.id ?? 'codex'
		this.display_name = `mock:${this.id}`
		this.supportedTools = opts.supportedTools ?? ['github.create_pr', 'github.write_file']
		this.statusScript = opts.statusScript ?? ['running']
		this.rateLimitFirstN = opts.rateLimitFirstN ?? 0
		this.webhook = makeMockWebhook(this.id)
	}

	async getSupportedTools(): Promise<readonly string[]> {
		return this.supportedTools
	}

	async startRun(req: StartRunRequest): Promise<{ vendor_run_id: string }> {
		this.receivedStarts.push(req)
		return { vendor_run_id: `vrn_${req.run_id}` }
	}

	async cancelRun(run_id: RunId): Promise<void> {
		this.receivedCancels.push(run_id)
	}

	async getStatus(run_id: RunId): Promise<VendorRunStatusReport> {
		if (this.rateLimitCursor < this.rateLimitFirstN) {
			this.rateLimitCursor += 1
			throw new VendorRateLimitError(this.id, 30)
		}
		const idx = Math.min(this.statusCursor, this.statusScript.length - 1)
		const status = this.statusScript[idx] ?? 'running'
		this.statusCursor += 1
		return { run_id, status, last_observed_at: new Date().toISOString() }
	}
}

function makeMockWebhook(vendor: VendorId): WebhookFramework {
	return {
		async verifySignature(_req: WebhookRequest, _secret: string): Promise<boolean> {
			return true
		},
		idempotencyKey(req: WebhookRequest): string {
			return req.headers['x-mock-delivery'] ?? `mock_${Math.random().toString(16).slice(2)}`
		},
		normalize(req: WebhookRequest): NormalizedWebhookEvent {
			const body = JSON.parse(req.body) as { event_type?: string }
			return {
				provider: vendor,
				event_type: body.event_type ?? 'unknown',
				idempotency_key: req.headers['x-mock-delivery'] ?? 'mock_key',
				received_at: new Date().toISOString(),
				payload: JSON.parse(req.body),
			}
		},
	}
}
