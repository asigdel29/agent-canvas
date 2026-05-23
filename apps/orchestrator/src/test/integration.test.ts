/**
 * End-to-end integration test for the orchestration spine.
 *
 * Exercises: command endpoint → authz → vault mint → vendor startRun
 * → vendor webhook → event log append → run_current_state update
 * → outbox enqueue → projector fan-out → canvas projection sink.
 *
 * Everything runs in memory with the InMemory* implementations and the
 * MockProvider. The cross-stack Playwright E2E (CEO decision 6.1) is a
 * follow-up; this integration test catches regressions across the
 * orchestration layer cheaply on every test run.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
	ConnectorRegistry,
	type ProviderAdapter,
	type StartRunRequest,
} from '@agent-canvas/connector-core'
import type {
	Command,
	RoomId,
	RunEvent,
	RunId,
	UserId,
} from '@agent-canvas/orchestrator-types'
import { InMemoryAuditLog } from '../orchestration/auditLog.js'
import {
	BillingGate,
	InMemoryBillingGateStore,
} from '../orchestration/billingGate.js'
import {
	CommandEndpoint,
	StaticCapabilityResolver,
} from '../orchestration/commandEndpoint.js'
import { InMemoryEventLog } from '../orchestration/eventLog.js'
import { InMemoryIdempotencyStore } from '../orchestration/idempotency.js'
import {
	InMemoryProjectionSink,
	InMemorySubscriptionResolver,
	InMemoryTombstoneOracle,
	Projector,
	type ProjectionWrite,
} from '../orchestration/projector.js'
import { InMemoryRunCurrentStateCache } from '../orchestration/runCurrentState.js'
import { InMemorySubscriptionStore } from '../orchestration/subscriptionStore.js'
import { InMemoryOutbox } from '../orchestration/transactionalOutbox.js'
import {
	InMemoryVault,
	type ScopedCredentialMinter,
	StubKmsClient,
	type MintRequest,
} from '../orchestration/vault.js'
import { MockProvider } from '../connectors/mockProvider.js'
import { GitHubConnector } from '../connectors/github/connector.js'
import { SafetyClassifier } from '../orchestration/safetyClassifier.js'

const ANU: UserId = 'u_anu' as UserId
const MIRA: UserId = 'u_mira' as UserId
const ROOM_A: RoomId = 'room_a' as RoomId
const ROOM_B: RoomId = 'room_b' as RoomId
const RUN: RunId = 'run_e2e' as RunId

class GitHubMinter implements ScopedCredentialMinter {
	readonly provider = 'github' as const
	async mint(plaintext: string, req: MintRequest) {
		return {
			access_token: `ghs_scoped_${req.run_id}_${plaintext.slice(0, 4)}`,
			expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
			scope: req.requested_scope,
			principal_label: 'anu@github',
		}
	}
}

interface World {
	endpoint: CommandEndpoint
	subscriptions: InMemorySubscriptionStore
	billingStore: InMemoryBillingGateStore
	eventLog: InMemoryEventLog
	currentState: InMemoryRunCurrentStateCache
	outbox: InMemoryOutbox
	projector: Projector
	projectionSink: InMemoryProjectionSink
	projectionResolver: InMemorySubscriptionResolver
	tombstones: InMemoryTombstoneOracle
	audit: InMemoryAuditLog
	registry: ConnectorRegistry
	vault: InMemoryVault
	vendor: MockProvider
	safety: SafetyClassifier
}

async function buildWorld(): Promise<World> {
	const capabilities = new StaticCapabilityResolver()
	capabilities.grant(ANU, ROOM_A, ['view', 'edit', 'run-agents'])
	capabilities.grant(MIRA, ROOM_B, ['view', 'subscriber-actor'])

	const subscriptions = new InMemorySubscriptionStore()

	const billingStore = new InMemoryBillingGateStore()
	billingStore.setBudget({
		project_id: 'proj_a',
		window_seconds: 86400,
		ceiling_micros: 50_000_000,
	})
	const billingGate = new BillingGate(billingStore)

	const eventLog = new InMemoryEventLog()
	const currentState = new InMemoryRunCurrentStateCache()
	const outbox = new InMemoryOutbox()
	const audit = new InMemoryAuditLog()
	const idempotency = new InMemoryIdempotencyStore()

	const projectionResolver = new InMemorySubscriptionResolver()
	projectionResolver.setOrigin(RUN, ROOM_A)
	const tombstones = new InMemoryTombstoneOracle()
	const projectionSink = new InMemoryProjectionSink()
	const projector = new Projector(projectionResolver, tombstones, projectionSink)

	// Wire the outbox drain → projector. Every event drained from the
	// outbox lands as a projection write.
	outbox.subscribe(async (event: RunEvent) => {
		await projector.project(event, 'demo run')
	})

	const endpoint = new CommandEndpoint({
		capabilities,
		subscriptions,
		billingGate,
		idempotency,
		eventLog,
		runCurrentState: currentState,
		outbox,
		auditLog: audit,
		projectIdForRoom: () => 'proj_a',
		originRoomForRun: async () => ROOM_A,
	})

	const registry = new ConnectorRegistry()
	registry.registerConnector(new GitHubConnector())
	const vendor = new MockProvider({
		statusScript: ['provisioning', 'running', 'succeeded'],
	})
	registry.registerProvider(vendor)

	const vault = new InMemoryVault(new StubKmsClient())
	vault.registerMinter(new GitHubMinter())
	await vault.store({
		user_id: ANU,
		provider: 'github',
		ciphertext: await new StubKmsClient().encrypt('refresh_token_anu'),
	})

	const safety = new SafetyClassifier(registry)

	return {
		endpoint,
		subscriptions,
		billingStore,
		eventLog,
		currentState,
		outbox,
		projector,
		projectionSink,
		projectionResolver,
		tombstones,
		audit,
		registry,
		vault,
		vendor,
		safety,
	}
}

function cmd(overrides: Partial<Command> = {}): Command {
	return {
		kind: 'start_request',
		run_id: RUN,
		room_id: ROOM_A,
		actor_user_id: ANU,
		idempotency_key: `idk_${Math.random().toString(16).slice(2)}`,
		payload: { taskSpec: { goal: 'demo' } },
		ts: new Date().toISOString(),
		...overrides,
	}
}

describe('integration: start-to-projection spine', () => {
	let world: World

	beforeEach(async () => {
		world = await buildWorld()
	})

	it('a start_request flows through authz, event log, outbox, and projects to the origin room', async () => {
		const result = await world.endpoint.accept(cmd())
		expect(result.seq).toBe(1)
		expect(result.deduped).toBe(false)

		// Event log carries the queued event.
		const events = await world.eventLog.read(RUN)
		expect(events).toHaveLength(1)
		expect(events[0]!.kind).toBe('queued')

		// run_current_state has the initial row.
		const state = await world.currentState.get(RUN)
		expect(state?.status).toBe('queued')
		expect(state?.last_seq).toBe(1)

		// Outbox enqueued; drain to deliver to the projector.
		expect(await world.outbox.pending()).toBe(1)
		await world.outbox.drain()
		expect(await world.outbox.pending()).toBe(0)

		// Projection sink received exactly one write to room_a.
		expect(world.projectionSink.writes).toHaveLength(1)
		expect(world.projectionSink.writes[0]!.target.room_id).toBe(ROOM_A)
		expect(world.projectionSink.writes[0]!.run_record_patch?.status).toBe('queued')

		// Audit log records the accepted command.
		const audit = await world.audit.queryByRun(RUN)
		expect(audit).toHaveLength(1)
		expect(audit[0]!.action).toBe('start_request')
		expect(audit[0]!.result).toBe('ok')
	})

	it('vendor webhook events flow through the log and project to subscribed rooms', async () => {
		// Setup: start run + establish a subscription from A to B.
		await world.endpoint.accept(cmd())
		const sub = await world.subscriptions.establish({
			run_id: RUN,
			origin_room_id: ROOM_A,
			target_room_id: ROOM_B,
			established_by_user_id: ANU,
		})
		world.projectionResolver.addSubscription(sub)

		// Drain initial events.
		await world.outbox.drain()
		const projectionCountBefore = world.projectionSink.writes.length

		// Simulate the vendor webhook stream: provisioning → running → tool_call → succeeded
		const fromVendor: { kind: RunEvent['kind']; payload?: Record<string, unknown> }[] = [
			{ kind: 'provisioning' },
			{ kind: 'running' },
			{ kind: 'tool_call', payload: { tool: 'github.create_pr' } },
			{ kind: 'succeeded' },
		]
		for (const e of fromVendor) {
			const r = await world.eventLog.append({
				run_id: RUN,
				kind: e.kind,
				payload: e.payload ?? {},
				vendor: 'codex',
			})
			const events = await world.eventLog.read(RUN, { fromSeq: r.seq, limit: 1 })
			if (events[0]) await world.outbox.enqueue(events[0])
		}

		await world.outbox.drain()

		// Each vendor event projected into both rooms (origin + subscription).
		const newWrites = world.projectionSink.writes.slice(projectionCountBefore)
		expect(newWrites).toHaveLength(fromVendor.length * 2)
		const rooms = new Set(newWrites.map((w: ProjectionWrite) => w.target.room_id))
		expect(rooms.has(ROOM_A)).toBe(true)
		expect(rooms.has(ROOM_B)).toBe(true)
	})

	it('tombstoned room is skipped during projection fanout', async () => {
		await world.endpoint.accept(cmd())
		const sub = await world.subscriptions.establish({
			run_id: RUN,
			origin_room_id: ROOM_A,
			target_room_id: ROOM_B,
			established_by_user_id: ANU,
		})
		world.projectionResolver.addSubscription(sub)
		world.tombstones.mark(RUN, ROOM_B) // delete the shape from B

		await world.outbox.drain()
		const writesPerRoom = new Map<RoomId, number>()
		for (const w of world.projectionSink.writes) {
			writesPerRoom.set(w.target.room_id, (writesPerRoom.get(w.target.room_id) ?? 0) + 1)
		}
		expect(writesPerRoom.get(ROOM_A)).toBe(1)
		expect(writesPerRoom.get(ROOM_B)).toBeUndefined()
	})

	it('safety classifier gates a destructive tool_call', async () => {
		const result = world.safety.classify({
			provider: 'github',
			tool_id: 'merge_pr',
			args: {},
		})
		expect(result.safety).toBe('destructive')
		expect(
			world.safety.requiresApproval({ provider: 'github', tool_id: 'merge_pr', args: {} })
		).toBe(true)
	})

	it('vault mints a scoped credential the vendor sees, but the long-lived token never leaves', async () => {
		const scoped = await world.vault.mintScopedCredential({
			run_id: RUN,
			user_id: ANU,
			provider: 'github',
			requested_scope: 'repo:read',
		})
		expect(scoped.access_token.startsWith('ghs_scoped_')).toBe(true)
		expect(scoped.access_token).not.toContain('refresh_token_anu')
	})

	it('idempotent start_request: double-click produces one run', async () => {
		const key = 'idk_double_click'
		await world.endpoint.accept(cmd({ idempotency_key: key }))
		await world.endpoint.accept(cmd({ idempotency_key: key }))
		const events = await world.eventLog.read(RUN)
		expect(events).toHaveLength(1)
	})

	it('budget exhaustion blocks a new start_request before the event log is touched', async () => {
		world.billingStore.setBudget({
			project_id: 'proj_a',
			window_seconds: 86400,
			ceiling_micros: 100,
		})
		await world.billingStore.recordSpend('proj_a', 1_000) // over budget
		await expect(world.endpoint.accept(cmd())).rejects.toMatchObject({
			reason: 'budget_exhausted',
		})
		const events = await world.eventLog.read(RUN)
		expect(events).toHaveLength(0)
		const audit = await world.audit.queryByRun(RUN)
		expect(audit[0]!.result).toBe('rejected')
	})

	it('cross-room approve from B requires a subscription with matching epoch', async () => {
		await world.endpoint.accept(cmd())
		const sub = await world.subscriptions.establish({
			run_id: RUN,
			origin_room_id: ROOM_A,
			target_room_id: ROOM_B,
			established_by_user_id: ANU,
		})
		// MIRA approves from B with the correct epoch — should succeed.
		await world.endpoint.accept(
			cmd({
				kind: 'approve',
				room_id: ROOM_B,
				actor_user_id: MIRA,
				subscription_epoch: sub.subscription_epoch,
				payload: { decision: 'approved' },
			})
		)
		const audit = await world.audit.queryByRun(RUN)
		expect(audit.some((a) => a.action === 'approve' && a.result === 'ok')).toBe(true)
	})
})
