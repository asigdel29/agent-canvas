/**
 * Runtime singleton — assembles the orchestrator's dependency graph
 * once per cold start.
 *
 * If DATABASE_URL is set, Postgres adapters back every store. Otherwise
 * the in-memory implementations are used (useful for local development
 * and tests; not for production traffic).
 *
 * KMS_KEY_ID picks AwsKmsClient; absence falls back to StubKmsClient.
 *
 * Connector registry installs the ten provider adapters + a MockProvider
 * for local-only smoke testing.
 */

import { ConnectorRegistry } from '@agent-canvas/connector-core'

import { InMemoryAuditLog, type AuditLog } from './orchestration/auditLog.js'
import { NonceCache } from './auth/sseToken.js'
import { IngestionPipeline } from './orchestration/ingestionPipeline.js'
import { RunCoordinator } from './orchestration/runCoordinator.js'
import { TriggerRouter } from './orchestration/triggerRouter.js'
import { InMemoryVendorRunMap } from './orchestration/vendorRunMap.js'
import {
	InMemoryWorkflowTemplateStore,
	type WorkflowTemplateStore,
} from './orchestration/workflowTemplate.js'
import { PostgresVendorRunMap } from './postgres/vendorRunMap.js'
import { InMemoryRoomEventBus, type RoomEventBus } from './sync/roomEventBus.js'
import {
	BillingGate,
	InMemoryBillingGateStore,
} from './orchestration/billingGate.js'
import {
	CommandEndpoint,
	StaticCapabilityResolver,
	type CapabilityResolver,
} from './orchestration/commandEndpoint.js'
import { InMemoryEventLog } from './orchestration/eventLog.js'
import { InMemoryIdempotencyStore } from './orchestration/idempotency.js'
import {
	InMemoryProjectionSink,
	InMemorySubscriptionResolver,
	InMemoryTombstoneOracle,
	Projector,
} from './orchestration/projector.js'
import { InMemoryRunCurrentStateCache } from './orchestration/runCurrentState.js'
import { SafetyClassifier } from './orchestration/safetyClassifier.js'
import { InMemorySubscriptionStore } from './orchestration/subscriptionStore.js'
import { InMemoryOutbox } from './orchestration/transactionalOutbox.js'
import { InMemoryVault, StubKmsClient } from './orchestration/vault.js'
import { AwsKmsClient } from './vault/awsKms.js'

import { DiscordConnector } from './connectors/discord/connector.js'
import { GitHubConnector } from './connectors/github/connector.js'
import { GraphiteConnector } from './connectors/graphite/connector.js'
import { LinearConnector } from './connectors/linear/connector.js'
import { RailwayConnector } from './connectors/railway/connector.js'
import { SlackConnector } from './connectors/slack/connector.js'
import { SupabaseConnector } from './connectors/supabase/connector.js'
import { VercelConnector } from './connectors/vercel/connector.js'
import { CodexProvider } from './connectors/codex/provider.js'
import { OpenHandsProvider } from './connectors/openhands/provider.js'
import { MockProvider } from './connectors/mockProvider.js'

import {
	PostgresAuditLog,
	PostgresBillingGateStore,
	PostgresEventLog,
	PostgresIdempotencyStore,
	PostgresOutbox,
	PostgresRunCurrentStateCache,
	PostgresSubscriptionStore,
	createSqlClient,
} from './postgres/index.js'

export interface Runtime {
	readonly registry: ConnectorRegistry
	readonly endpoint: CommandEndpoint
	readonly safety: SafetyClassifier
	readonly capabilities: CapabilityResolver
	readonly ingestionPipeline: IngestionPipeline
	readonly vendorRunMap: InMemoryVendorRunMap | PostgresVendorRunMap
	readonly runCoordinator: RunCoordinator
	readonly roomEventBus: RoomEventBus
	readonly templates: WorkflowTemplateStore
	readonly triggerRouter: TriggerRouter
	readonly auditLog: AuditLog
	readonly sseNonces: NonceCache
}

let cached: Runtime | null = null

export function getRuntime(): Runtime {
	if (cached) return cached
	cached = build()
	return cached
}

/** Tests can reset the singleton between cases. */
export function resetRuntimeForTesting(): void {
	cached = null
}

function build(): Runtime {
	const usePg = !!process.env['DATABASE_URL']
	const sql = usePg ? createSqlClient() : null

	const eventLog = sql ? new PostgresEventLog(sql) : new InMemoryEventLog()
	const runCurrentState = sql
		? new PostgresRunCurrentStateCache(sql)
		: new InMemoryRunCurrentStateCache()
	const idempotency = sql ? new PostgresIdempotencyStore(sql) : new InMemoryIdempotencyStore()
	const auditLog = sql ? new PostgresAuditLog(sql) : new InMemoryAuditLog()
	const subscriptions = sql
		? new PostgresSubscriptionStore(sql)
		: new InMemorySubscriptionStore()
	const billingStore = sql
		? new PostgresBillingGateStore(sql)
		: new InMemoryBillingGateStore()
	const outbox = sql ? new PostgresOutbox(sql) : new InMemoryOutbox()
	const vendorRunMap = sql ? new PostgresVendorRunMap(sql) : new InMemoryVendorRunMap()

	const billingGate = process.env['BILLING_ENABLED'] === 'true' ? new BillingGate(billingStore) : null

	const kmsKey = process.env['KMS_KEY_ID']
	const kms = kmsKey ? new AwsKmsClient({ keyId: kmsKey }) : new StubKmsClient()
	void new InMemoryVault(kms) // Vault is constructed lazily by callers that need it.

	const projectionResolver = new InMemorySubscriptionResolver()
	const tombstones = new InMemoryTombstoneOracle()
	const projectionSink = new InMemoryProjectionSink()
	const projector = new Projector(projectionResolver, tombstones, projectionSink)
	void projector // wired into the outbox subscriber in production sync layer

	const capabilities = new StaticCapabilityResolver()
	// Real capability resolution lives in a Postgres-backed implementation
	// behind an auth layer; this static instance is bootstrap-only.

	const endpoint = new CommandEndpoint({
		capabilities,
		subscriptions,
		billingGate,
		idempotency,
		eventLog,
		runCurrentState,
		outbox,
		auditLog,
		projectIdForRoom: (room_id) => process.env['DEFAULT_PROJECT_ID'] ?? `proj_${room_id}`,
		originRoomForRun: async () => null, // production wires this to a runs table
	})

	const registry = new ConnectorRegistry()
	registry.registerConnector(new GitHubConnector())
	registry.registerConnector(new LinearConnector())
	registry.registerConnector(new SlackConnector())
	registry.registerConnector(new DiscordConnector())
	registry.registerConnector(new GraphiteConnector())
	registry.registerConnector(new RailwayConnector())
	registry.registerConnector(new VercelConnector())
	registry.registerConnector(new SupabaseConnector())
	registry.registerProvider(new CodexProvider())
	registry.registerProvider(new OpenHandsProvider())
	if (process.env['ENABLE_MOCK_PROVIDER'] === 'true') {
		registry.registerProvider(new MockProvider())
	}

	const safety = new SafetyClassifier(registry)
	const ingestionPipeline = new IngestionPipeline({ vendorRunMap, eventLog, outbox })
	const runCoordinator = new RunCoordinator({ registry, eventLog, outbox, vendorRunMap })
	runCoordinator.start()

	const roomEventBus = new InMemoryRoomEventBus()
	// Fan out every drained event to the room bus via the projector's
	// target resolver. The projector already routes events to rooms
	// (origin + subscriptions); subscribing the bus alongside the
	// projection sink piggybacks on that work.
	outbox.subscribe(async (event) => {
		const targets = await projectionResolver.getTargets(event.run_id)
		for (const target of targets) {
			if (await tombstones.isTombstoned(event.run_id, target.room_id)) continue
			roomEventBus.publish(target.room_id, event)
		}
	})

	const templates = new InMemoryWorkflowTemplateStore()
	const triggerRouter = new TriggerRouter({
		templates,
		endpoint,
		// Production wires this to a rooms table that maps a connector
		// trigger (installation_id, channel_id, repo_id, etc.) to the
		// owner's room. The default returns null — no routing happens
		// until a real resolver is installed.
		resolveRoomForTrigger: async () => null,
	})

	const sseNonces = new NonceCache(10_000)

	return {
		registry,
		endpoint,
		safety,
		capabilities,
		ingestionPipeline,
		vendorRunMap,
		runCoordinator,
		roomEventBus,
		templates,
		triggerRouter,
		auditLog,
		sseNonces,
	}
}
