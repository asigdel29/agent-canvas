import { describe, expect, it } from 'vitest'
import { ConnectorRegistry } from '@agent-canvas/connector-core'
import type { RunEvent, RunId, VendorId } from '@agent-canvas/orchestrator-types'
import { MockProvider } from '../connectors/mockProvider.js'
import { InMemoryEventLog } from './eventLog.js'
import { RunCoordinator } from './runCoordinator.js'
import { InMemoryOutbox } from './transactionalOutbox.js'
import { InMemoryVendorRunMap } from './vendorRunMap.js'

const RUN: RunId = 'run_c' as RunId

function buildHarness(opts: { providers?: MockProvider[] } = {}) {
	const registry = new ConnectorRegistry()
	const providers = opts.providers ?? [new MockProvider()]
	for (const p of providers) registry.registerProvider(p)
	const eventLog = new InMemoryEventLog()
	const outbox = new InMemoryOutbox()
	const vendorRunMap = new InMemoryVendorRunMap()
	const coord = new RunCoordinator({ registry, eventLog, outbox, vendorRunMap })
	return { coord, eventLog, outbox, vendorRunMap, providers }
}

function queuedEvent(taskSpec: Record<string, unknown> = {}): RunEvent {
	return {
		seq: 1,
		run_id: RUN,
		kind: 'queued',
		ts: new Date().toISOString(),
		schema_version: 1,
		payload: { taskSpec },
	}
}

describe('RunCoordinator', () => {
	it('starts a queued run on the first compatible vendor and appends provisioning', async () => {
		const provider = new MockProvider({ supportedTools: ['github.create_pr', 'github.write_file'] })
		const h = buildHarness({ providers: [provider] })
		await h.coord.handleQueued(
			queuedEvent({ required_tools: ['github.create_pr'], objective: 'demo' })
		)
		expect(provider.receivedStarts).toHaveLength(1)
		expect(provider.receivedStarts[0]!.run_id).toBe(RUN)
		expect(await h.vendorRunMap.resolve('codex' as VendorId, `vrn_${RUN}`)).toBe(RUN)
		const events = await h.eventLog.read(RUN)
		expect(events).toHaveLength(1)
		expect(events[0]!.kind).toBe('provisioning')
		expect(events[0]!.vendor).toBe('codex')
		expect(events[0]!.payload).toMatchObject({ vendor: 'codex', vendor_run_id: `vrn_${RUN}` })
		expect(await h.outbox.pending()).toBe(1)
	})

	it('picks a vendor whose tool set covers the required_tools', async () => {
		const incompatible = new MockProvider({
			id: 'codex',
			supportedTools: ['only.basic_tool'],
		})
		const compatible = new MockProvider({
			id: 'openhands',
			supportedTools: ['github.create_pr', 'shell.run'],
		})
		const h = buildHarness({ providers: [incompatible, compatible] })
		await h.coord.handleQueued(
			queuedEvent({ required_tools: ['github.create_pr', 'shell.run'] })
		)
		expect(incompatible.receivedStarts).toHaveLength(0)
		expect(compatible.receivedStarts).toHaveLength(1)
		const events = await h.eventLog.read(RUN)
		expect(events[0]!.vendor).toBe('openhands')
	})

	it('emits a failed event with no_compatible_vendor when no provider supports the tool set', async () => {
		const provider = new MockProvider({ supportedTools: ['unrelated.tool'] })
		const h = buildHarness({ providers: [provider] })
		await h.coord.handleQueued(queuedEvent({ required_tools: ['github.create_pr'] }))
		expect(provider.receivedStarts).toHaveLength(0)
		const events = await h.eventLog.read(RUN)
		expect(events[0]!.kind).toBe('failed')
		expect((events[0]!.payload as { reason: string }).reason).toMatch(/no_compatible_vendor/)
	})

	it('records the vendor_run_id ↔ run_id mapping atomically with startRun', async () => {
		const provider = new MockProvider({ supportedTools: ['t1'] })
		const h = buildHarness({ providers: [provider] })
		await h.coord.handleQueued(queuedEvent({ required_tools: ['t1'] }))
		// MockProvider returns vendor_run_id = `vrn_${run_id}`.
		expect(await h.vendorRunMap.resolve(provider.id, `vrn_${RUN}`)).toBe(RUN)
	})

	it('passes credentials from the credentialsFor hook to startRun', async () => {
		const provider = new MockProvider({ supportedTools: ['t1'] })
		const registry = new ConnectorRegistry()
		registry.registerProvider(provider)
		const eventLog = new InMemoryEventLog()
		const outbox = new InMemoryOutbox()
		const vendorRunMap = new InMemoryVendorRunMap()
		const coord = new RunCoordinator({
			registry,
			eventLog,
			outbox,
			vendorRunMap,
			credentialsFor: async () => ({ github_token: 'ghs_scoped' }),
		})
		await coord.handleQueued(queuedEvent({ required_tools: ['t1'] }))
		expect(provider.receivedStarts[0]!.credentials).toEqual({ github_token: 'ghs_scoped' })
	})

	it('catches vendor startRun failures and emits a failed event with the message', async () => {
		class FailingProvider extends MockProvider {
			override async startRun(): Promise<{ vendor_run_id: string }> {
				throw new Error('vendor 503')
			}
		}
		const provider = new FailingProvider({ supportedTools: ['t1'] })
		const h = buildHarness({ providers: [provider] })
		await h.coord.handleQueued(queuedEvent({ required_tools: ['t1'] }))
		const events = await h.eventLog.read(RUN)
		expect(events[0]!.kind).toBe('failed')
		expect((events[0]!.payload as { reason: string }).reason).toBe('vendor 503')
	})
})
