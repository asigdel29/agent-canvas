/**
 * Tests for ingestionPipeline.
 *
 * @author asigdel29
 */

import { describe, expect, it } from 'vitest'
import type {
	NormalizedWebhookEvent,
	ProviderAdapter,
} from '@agent-canvas/connector-core'
import type { RunId, VendorId } from '@agent-canvas/orchestrator-types'
import { InMemoryEventLog } from './eventLog.js'
import { IngestionPipeline } from './ingestionPipeline.js'
import { InMemoryOutbox } from './transactionalOutbox.js'
import { InMemoryVendorRunMap } from './vendorRunMap.js'
import { MockProvider } from '../connectors/mockProvider.js'

const RUN: RunId = 'run_1' as RunId

function mockWebhookEvent(payload: Record<string, unknown>, idempKey = 'mock_delivery_1'): NormalizedWebhookEvent {
	return {
		provider: 'codex' as VendorId & 'codex',
		event_type: 'run.event',
		idempotency_key: idempKey,
		received_at: new Date().toISOString(),
		payload,
	}
}

function buildHarness() {
	const eventLog = new InMemoryEventLog()
	const outbox = new InMemoryOutbox()
	const vendorRunMap = new InMemoryVendorRunMap()
	const pipeline = new IngestionPipeline({ vendorRunMap, eventLog, outbox })
	const adapter = new MockProvider()
	return { eventLog, outbox, vendorRunMap, pipeline, adapter }
}

describe('IngestionPipeline', () => {
	it('appends a run event when vendor_run_id is mapped', async () => {
		const h = buildHarness()
		await h.vendorRunMap.record({ vendor: 'codex', vendor_run_id: 'vrn_99', run_id: RUN })
		const result = await h.pipeline.ingest(
			h.adapter,
			mockWebhookEvent({ vendor_run_id: 'vrn_99', event_kind: 'running' })
		)
		expect(result.status).toBe('accepted')
		if (result.status === 'accepted') {
			expect(result.run_id).toBe(RUN)
			expect(result.deduped).toBe(false)
			expect(result.seq).toBe(1)
		}
		const events = await h.eventLog.read(RUN)
		expect(events).toHaveLength(1)
		expect(events[0]!.kind).toBe('running')
		expect(events[0]!.vendor).toBe('codex')
		expect(events[0]!.provider_event_id).toBe('mock_delivery_1')
		expect(await h.outbox.pending()).toBe(1)
	})

	it('returns no_run_info / event_not_per_run when extractRunInfo returns null', async () => {
		const h = buildHarness()
		const result = await h.pipeline.ingest(
			h.adapter,
			mockWebhookEvent({ /* no vendor_run_id */ event_kind: 'progress' })
		)
		expect(result).toEqual({ status: 'no_run_info', reason: 'event_not_per_run' })
		expect(await h.eventLog.read(RUN)).toHaveLength(0)
		expect(await h.outbox.pending()).toBe(0)
	})

	it('returns no_run_info / vendor_unmapped when the vendor_run_id is not registered', async () => {
		const h = buildHarness()
		const result = await h.pipeline.ingest(
			h.adapter,
			mockWebhookEvent({ vendor_run_id: 'unregistered', event_kind: 'running' })
		)
		expect(result).toEqual({ status: 'no_run_info', reason: 'vendor_unmapped' })
	})

	it('dedupes a redelivered webhook (same idempotency_key)', async () => {
		const h = buildHarness()
		await h.vendorRunMap.record({ vendor: 'codex', vendor_run_id: 'vrn_99', run_id: RUN })
		const first = await h.pipeline.ingest(
			h.adapter,
			mockWebhookEvent({ vendor_run_id: 'vrn_99', event_kind: 'running' }, 'delivery_X')
		)
		const second = await h.pipeline.ingest(
			h.adapter,
			mockWebhookEvent({ vendor_run_id: 'vrn_99', event_kind: 'running' }, 'delivery_X')
		)
		expect(first.status).toBe('accepted')
		expect(second.status).toBe('accepted')
		if (first.status === 'accepted' && second.status === 'accepted') {
			expect(first.deduped).toBe(false)
			expect(second.deduped).toBe(true)
			expect(second.seq).toBe(first.seq) // returns existing seq
		}
		const events = await h.eventLog.read(RUN)
		expect(events).toHaveLength(1) // only one event, second was deduped
		expect(await h.outbox.pending()).toBe(1) // outbox only enqueued once
	})

	it('routes a sequence of events through to event_log in order', async () => {
		const h = buildHarness()
		await h.vendorRunMap.record({ vendor: 'codex', vendor_run_id: 'vrn_99', run_id: RUN })
		const stream: { kind: string; delivery: string }[] = [
			{ kind: 'provisioning', delivery: 'd1' },
			{ kind: 'running', delivery: 'd2' },
			{ kind: 'tool_call', delivery: 'd3' },
			{ kind: 'succeeded', delivery: 'd4' },
		]
		for (const s of stream) {
			await h.pipeline.ingest(
				h.adapter,
				mockWebhookEvent({ vendor_run_id: 'vrn_99', event_kind: s.kind }, s.delivery)
			)
		}
		const events = await h.eventLog.read(RUN)
		expect(events.map((e) => e.kind)).toEqual([
			'provisioning',
			'running',
			'tool_call',
			'succeeded',
		])
		expect(await h.outbox.pending()).toBe(4)
	})
})
