/**
 * Tests for mockProvider.
 *
 * @author asigdel29
 */

import { describe, expect, it } from 'vitest'
import { VendorRateLimitError } from '@agent-canvas/connector-core'
import { runProviderAdapterConformance } from '@agent-canvas/connector-core/conformance'
import type { RunId } from '@agent-canvas/orchestrator-types'
import { MockProvider } from './mockProvider.js'

const RUN: RunId = 'run_m' as RunId

// Conformance against the framework interface
runProviderAdapterConformance(new MockProvider())

describe('MockProvider behavior', () => {
	it('records startRun calls and returns a vendor_run_id', async () => {
		const p = new MockProvider()
		const result = await p.startRun({
			run_id: RUN,
			task_spec: { goal: 'demo' },
			required_tool_ids: [],
			credentials: {},
		})
		expect(result.vendor_run_id).toBe('vrn_run_m')
		expect(p.receivedStarts).toHaveLength(1)
	})

	it('records cancelRun calls', async () => {
		const p = new MockProvider()
		await p.cancelRun(RUN)
		expect(p.receivedCancels).toEqual([RUN])
	})

	it('walks the status script and reports the final status thereafter', async () => {
		const p = new MockProvider({ statusScript: ['provisioning', 'running', 'succeeded'] })
		expect((await p.getStatus(RUN)).status).toBe('provisioning')
		expect((await p.getStatus(RUN)).status).toBe('running')
		expect((await p.getStatus(RUN)).status).toBe('succeeded')
		// After the script ends, the last status repeats.
		expect((await p.getStatus(RUN)).status).toBe('succeeded')
	})

	it('throws VendorRateLimitError for the first N calls if configured', async () => {
		const p = new MockProvider({ rateLimitFirstN: 2 })
		await expect(p.getStatus(RUN)).rejects.toBeInstanceOf(VendorRateLimitError)
		await expect(p.getStatus(RUN)).rejects.toBeInstanceOf(VendorRateLimitError)
		const ok = await p.getStatus(RUN)
		expect(ok.status).toBe('running')
	})

	it('reports the configured supported tools', async () => {
		const p = new MockProvider({ supportedTools: ['a', 'b', 'c'] })
		expect(await p.getSupportedTools()).toEqual(['a', 'b', 'c'])
	})
})
