/**
 * IngestionPipeline — turns a verified vendor webhook into an event-log
 * append + outbox enqueue.
 *
 * Flow:
 *
 *   verified webhook  ──▶  ProviderAdapter.extractRunInfo
 *                           │
 *                           ▼  vendor_run_id + event_kind + payload
 *                          VendorRunMap.resolve  ──▶  internal run_id
 *                           │
 *                           ▼
 *                          EventLog.append (idempotent on provider_event_id)
 *                           │
 *                           ▼
 *                          Outbox.enqueue (same TX in production)
 *
 * Returns the outcome so the webhook route can shape its HTTP response.
 * @author asigdel29
 */

import type {
	NormalizedWebhookEvent,
	ProviderAdapter,
} from '@agent-canvas/connector-core'
import type { RunEventKind, RunId } from '@agent-canvas/orchestrator-types'
import type { EventLog } from './eventLog.js'
import type { Outbox } from './transactionalOutbox.js'
import type { VendorRunMap } from './vendorRunMap.js'

export type IngestionOutcome =
	| { status: 'accepted'; run_id: RunId; seq: number; deduped: boolean }
	| { status: 'no_run_info'; reason: 'event_not_per_run' | 'vendor_unmapped' }
	| { status: 'ignored'; reason: 'unknown_event_kind' }

export interface IngestionPipelineDeps {
	readonly vendorRunMap: VendorRunMap
	readonly eventLog: EventLog
	readonly outbox: Outbox
}

export class IngestionPipeline {
	constructor(private readonly deps: IngestionPipelineDeps) {}

	async ingest(
		adapter: ProviderAdapter,
		event: NormalizedWebhookEvent
	): Promise<IngestionOutcome> {
		const info = adapter.extractRunInfo(event)
		if (!info) return { status: 'no_run_info', reason: 'event_not_per_run' }

		const run_id = await this.deps.vendorRunMap.resolve(adapter.id, info.vendor_run_id)
		if (!run_id) return { status: 'no_run_info', reason: 'vendor_unmapped' }

		const kind = info.event_kind as RunEventKind
		const append = await this.deps.eventLog.append({
			run_id,
			kind,
			payload: info.payload,
			provider_event_id: event.idempotency_key,
			vendor: adapter.id,
		})

		if (!append.deduped) {
			const rows = await this.deps.eventLog.read(run_id, { fromSeq: append.seq, limit: 1 })
			const row = rows[0]
			if (row) await this.deps.outbox.enqueue(row)
		}

		return { status: 'accepted', run_id, seq: append.seq, deduped: append.deduped }
	}
}
