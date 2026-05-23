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

import { InMemoryAuditLog } from './orchestration/auditLog.js'
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

	return { registry, endpoint, safety, capabilities }
}
