/**
 * Full-loop integration test.
 *
 * Wires together every in-memory backend AND the new RunCoordinator +
 * IngestionPipeline to verify the complete Phase 1 spine:
 *
 *   canvas command (start_request)
 *     → CommandEndpoint (authz + idempotency + event_log + outbox)
 *       → RunCoordinator picks compatible vendor
 *         → vendor.startRun + vendor_run_map.record
 *           → provisioning event in event_log + outbox
 *
 *   vendor webhook (running → tool_call → succeeded)
 *     → IngestionPipeline (signature + extractRunInfo + vendor_run_map)
 *       → event_log + outbox
 *         → projector writes to canvas projection
 *
 * The projection sink at the end captures the canvas-visible writes.
 * @author asigdel29
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
	type NormalizedWebhookEvent,
	ConnectorRegistry,
} from '@agent-canvas/connector-core'
import type { Command, RoomId, RunId, UserId } from '@agent-canvas/orchestrator-types'
import { MockProvider } from '../connectors/mockProvider.js'
import { InMemoryAuditLog } from '../orchestration/auditLog.js'
import {
	CommandEndpoint,
	StaticCapabilityResolver,
} from '../orchestration/commandEndpoint.js'
import { InMemoryEventLog } from '../orchestration/eventLog.js'
import { InMemoryIdempotencyStore } from '../orchestration/idempotency.js'
import { IngestionPipeline } from '../orchestration/ingestionPipeline.js'
import {
	InMemoryProjectionSink,
	InMemorySubscriptionResolver,
	InMemoryTombstoneOracle,
	Projector,
} from '../orchestration/projector.js'
import { InMemoryRunCurrentStateCache } from '../orchestration/runCurrentState.js'
import { RunCoordinator } from '../orchestration/runCoordinator.js'
import { InMemorySubscriptionStore } from '../orchestration/subscriptionStore.js'
import { InMemoryOutbox } from '../orchestration/transactionalOutbox.js'
import { InMemoryVendorRunMap } from '../orchestration/vendorRunMap.js'

const ALICE: UserId = 'u_alice' as UserId
const ROOM: RoomId = 'room_loop' as RoomId
const RUN: RunId = 'run_loop' as RunId

interface Loop {
	endpoint: CommandEndpoint
	eventLog: InMemoryEventLog
	outbox: InMemoryOutbox
	vendor: MockProvider
	vendorRunMap: InMemoryVendorRunMap
	pipeline: IngestionPipeline
	sink: InMemoryProjectionSink
}

function buildLoop(): Loop {
	const capabilities = new StaticCapabilityResolver()
	capabilities.grant(ALICE, ROOM, ['view', 'edit', 'run-agents'])

	const registry = new ConnectorRegistry()
	const vendor = new MockProvider({
		supportedTools: ['github.create_pr', 'github.write_file'],
		statusScript: ['running'],
	})
	registry.registerProvider(vendor)

	const eventLog = new InMemoryEventLog()
	const outbox = new InMemoryOutbox()
	const vendorRunMap = new InMemoryVendorRunMap()

	const projectionResolver = new InMemorySubscriptionResolver()
	projectionResolver.setOrigin(RUN, ROOM)
	const sink = new InMemoryProjectionSink()
	const projector = new Projector(projectionResolver, new InMemoryTombstoneOracle(), sink)

	outbox.subscribe(async (event) => {
		await projector.project(event, 'demo loop')
	})

	const coordinator = new RunCoordinator({ registry, eventLog, outbox, vendorRunMap })
	coordinator.start()

	const endpoint = new CommandEndpoint({
		capabilities,
		subscriptions: new InMemorySubscriptionStore(),
		billingGate: null,
		idempotency: new InMemoryIdempotencyStore(),
		eventLog,
		runCurrentState: new InMemoryRunCurrentStateCache(),
		outbox,
		auditLog: new InMemoryAuditLog(),
		projectIdForRoom: () => 'proj_loop',
		originRoomForRun: async () => ROOM,
	})

	const pipeline = new IngestionPipeline({ vendorRunMap, eventLog, outbox })

	return { endpoint, eventLog, outbox, vendor, vendorRunMap, pipeline, sink }
}

function startCommand(): Command {
	return {
		kind: 'start_request',
		run_id: RUN,
		room_id: ROOM,
		actor_user_id: ALICE,
		idempotency_key: `idk_${Math.random().toString(16).slice(2)}`,
		payload: {
			taskSpec: {
				objective: 'Open a PR adding a robots.txt file',
				required_tools: ['github.create_pr', 'github.write_file'],
			},
		},
		ts: new Date().toISOString(),
	}
}

function vendorWebhook(
	vendor_run_id: string,
	event_kind: string,
	delivery: string
): NormalizedWebhookEvent {
	return {
		provider: 'codex' as never,
		event_type: 'run.event',
		idempotency_key: delivery,
		received_at: new Date().toISOString(),
		payload: { vendor_run_id, event_kind },
	}
}

describe('full Phase 1 round-trip', () => {
	let loop: Loop
	beforeEach(() => {
		loop = buildLoop()
	})

	it('command → vendor startRun → provisioning event → vendor webhook stream → projection', async () => {
		// 1. Canvas posts start_request
		await loop.endpoint.accept(startCommand())

		// 2. Drain the outbox: the queued event reaches RunCoordinator,
		//    which calls vendor.startRun and appends provisioning.
		await loop.outbox.drain()

		expect(loop.vendor.receivedStarts).toHaveLength(1)
		expect(loop.vendor.receivedStarts[0]!.run_id).toBe(RUN)
		const vendorRunId = `vrn_${RUN}`
		expect(await loop.vendorRunMap.resolve('codex', vendorRunId)).toBe(RUN)

		// The provisioning event RunCoordinator enqueued is still in the
		// outbox after step 2 (because the coordinator's enqueue happens
		// DURING the drain of the queued event); flush it now.
		await loop.outbox.drain()

		const eventsAfterStart = await loop.eventLog.read(RUN)
		expect(eventsAfterStart.map((e) => e.kind)).toEqual(['queued', 'provisioning'])

		// 3. Vendor delivers a webhook stream: running → tool_call → succeeded.
		const webhooks = [
			{ kind: 'running', delivery: 'd1' },
			{ kind: 'tool_call', delivery: 'd2' },
			{ kind: 'succeeded', delivery: 'd3' },
		]
		for (const w of webhooks) {
			await loop.pipeline.ingest(loop.vendor, vendorWebhook(vendorRunId, w.kind, w.delivery))
		}
		await loop.outbox.drain()

		// 4. Event log shows the full sequence; projection captured each
		//    event into the room.
		const allEvents = await loop.eventLog.read(RUN)
		expect(allEvents.map((e) => e.kind)).toEqual([
			'queued',
			'provisioning',
			'running',
			'tool_call',
			'succeeded',
		])

		const projectedKinds = loop.sink.writes
			.filter((w) => w.target.room_id === ROOM)
			.map((w) => w.event_record?.kind)
		expect(projectedKinds).toEqual([
			'queued',
			'provisioning',
			'running',
			'tool_call',
			'succeeded',
		])
	})

	it('redelivered webhook does not double-project', async () => {
		await loop.endpoint.accept(startCommand())
		await loop.outbox.drain()
		await loop.outbox.drain()
		const vendorRunId = `vrn_${RUN}`

		await loop.pipeline.ingest(loop.vendor, vendorWebhook(vendorRunId, 'running', 'dup'))
		await loop.pipeline.ingest(loop.vendor, vendorWebhook(vendorRunId, 'running', 'dup'))
		await loop.outbox.drain()

		const events = await loop.eventLog.read(RUN)
		const runningEvents = events.filter((e) => e.kind === 'running')
		expect(runningEvents).toHaveLength(1)
	})

	it('a run with an unsupported tool set fails before reaching the vendor', async () => {
		const cmd: Command = {
			...startCommand(),
			payload: {
				taskSpec: {
					objective: 'Do something with a tool no vendor supports',
					required_tools: ['unsupported.tool'],
				},
			},
		}
		await loop.endpoint.accept(cmd)
		await loop.outbox.drain()
		await loop.outbox.drain()

		expect(loop.vendor.receivedStarts).toHaveLength(0)
		const events = await loop.eventLog.read(RUN)
		const failed = events.find((e) => e.kind === 'failed')
		expect(failed).toBeDefined()
		expect((failed!.payload as { reason: string }).reason).toMatch(/no_compatible_vendor/)
	})
})
