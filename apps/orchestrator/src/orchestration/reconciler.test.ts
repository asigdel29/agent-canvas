import { describe, expect, it } from 'vitest'
import {
	type ProviderAdapter,
	type VendorRunStatusReport,
	VendorRateLimitError,
	type WebhookFramework,
} from '@agent-canvas/connector-core'
import type {
	RunCurrentState,
	RunId,
	RunStatus,
	VendorId,
} from '@agent-canvas/orchestrator-types'
import {
	type ReconcilerEventSink,
	Reconciler,
	type TimeSource,
	vendorStatusToRunStatus,
} from './reconciler.js'

const RUN: RunId = 'run_p' as RunId

function row(status: RunStatus, last_seq = 1): RunCurrentState {
	return {
		run_id: RUN,
		status,
		vendor: 'codex',
		last_seq,
		last_event_at: new Date().toISOString(),
		schema_version: 1,
		updated_at: new Date().toISOString(),
	}
}

class FakeClock implements TimeSource {
	private t = 1_000_000
	now(): number {
		return this.t
	}
	advance(ms: number): void {
		this.t += ms
	}
}

class CountingSink implements ReconcilerEventSink {
	calls: { run_id: RunId; reason: string }[] = []
	async emitUnreachable(run_id: RunId, reason: string): Promise<void> {
		this.calls.push({ run_id, reason })
	}
}

const noopWebhook: WebhookFramework = {
	verifySignature: async () => true,
	idempotencyKey: () => 'k',
	normalize: () => ({
		provider: 'codex',
		event_type: 'noop',
		idempotency_key: 'k',
		received_at: new Date().toISOString(),
		payload: {},
	}),
}

function fakeProvider(report: VendorRunStatusReport, vendor: VendorId = 'codex'): ProviderAdapter {
	return {
		id: vendor,
		display_name: vendor,
		getSupportedTools: async () => [],
		startRun: async () => ({ vendor_run_id: 'vr' }),
		cancelRun: async () => {},
		getStatus: async () => report,
		webhook: noopWebhook,
	}
}

function rateLimitedProvider(): ProviderAdapter {
	return {
		id: 'codex',
		display_name: 'codex',
		getSupportedTools: async () => [],
		startRun: async () => ({ vendor_run_id: 'vr' }),
		cancelRun: async () => {},
		getStatus: async () => {
			throw new VendorRateLimitError('codex', 30)
		},
		webhook: noopWebhook,
	}
}

describe('Reconciler.shouldPoll', () => {
	it('does not poll terminal runs', () => {
		const r = new Reconciler(new FakeClock())
		expect(r.shouldPoll(row('succeeded'))).toBe(false)
		expect(r.shouldPoll(row('failed'))).toBe(false)
		expect(r.shouldPoll(row('cancelled'))).toBe(false)
		expect(r.shouldPoll(row('unreachable'))).toBe(false)
	})

	it('polls a never-polled running run immediately', () => {
		const r = new Reconciler(new FakeClock())
		expect(r.shouldPoll(row('running'))).toBe(true)
	})

	it('uses the 10s interval for running, 60s for awaiting_input', async () => {
		const clock = new FakeClock()
		const r = new Reconciler(clock)
		const adapter = fakeProvider({ run_id: RUN, status: 'running', last_observed_at: '' })
		const sink = new CountingSink()
		await r.poll(row('running'), clock.now(), adapter, sink)
		clock.advance(5_000)
		expect(r.shouldPoll(row('running'))).toBe(false)
		clock.advance(6_000)
		expect(r.shouldPoll(row('running'))).toBe(true)

		// awaiting_input has the longer interval; the same elapsed time
		// that's enough for `running` is NOT enough for `awaiting_input`.
		const r2 = new Reconciler(clock)
		const adapter2 = fakeProvider({ run_id: RUN, status: 'running', last_observed_at: '' })
		await r2.poll(row('awaiting_input'), clock.now(), adapter2, sink)
		clock.advance(11_000)
		expect(r2.shouldPoll(row('awaiting_input'))).toBe(false)
		clock.advance(50_000)
		expect(r2.shouldPoll(row('awaiting_input'))).toBe(true)
	})
})

describe('Reconciler.poll', () => {
	it('records a successful poll and clears any backoff', async () => {
		const clock = new FakeClock()
		const r = new Reconciler(clock)
		const adapter = fakeProvider({ run_id: RUN, status: 'running', last_observed_at: '' })
		const sink = new CountingSink()
		const result = await r.poll(row('running'), clock.now(), adapter, sink)
		expect(result).toBe('ok')
		expect(sink.calls).toHaveLength(0)
	})

	it('emits unreachable when the wall-clock deadline blows', async () => {
		const clock = new FakeClock()
		const startedAt = clock.now()
		clock.advance(25 * 60 * 60 * 1000) // 25 hours
		const r = new Reconciler(clock)
		const adapter = fakeProvider({ run_id: RUN, status: 'running', last_observed_at: '' })
		const sink = new CountingSink()
		const result = await r.poll(row('running'), startedAt, adapter, sink)
		expect(result).toBe('deadline_blown')
		expect(sink.calls.map((c) => c.reason)).toEqual(['wall_clock_deadline'])
	})

	it('emits unreachable when the vendor returns unknown', async () => {
		const clock = new FakeClock()
		const r = new Reconciler(clock)
		const adapter = fakeProvider({ run_id: RUN, status: 'unknown', last_observed_at: '' })
		const sink = new CountingSink()
		const result = await r.poll(row('running'), clock.now(), adapter, sink)
		expect(result).toBe('deadline_blown')
		expect(sink.calls.map((c) => c.reason)).toEqual(['vendor_returned_unknown'])
	})

	it('on rate-limit, records backoff and shouldPoll returns false until backoff expires', async () => {
		const clock = new FakeClock()
		const r = new Reconciler(clock)
		const adapter = rateLimitedProvider()
		const sink = new CountingSink()
		const result = await r.poll(row('running'), clock.now(), adapter, sink)
		expect(result).toBe('rate_limited')
		// Within the 30s backoff window — should not poll again.
		clock.advance(15_000)
		expect(r.shouldPoll(row('running'))).toBe(false)
		// After backoff expires — should poll again.
		clock.advance(20_000)
		expect(r.shouldPoll(row('running'))).toBe(true)
	})
})

describe('vendorStatusToRunStatus', () => {
	it('maps each known vendor status to a RunStatus', () => {
		expect(vendorStatusToRunStatus('queued')).toBe('queued')
		expect(vendorStatusToRunStatus('provisioning')).toBe('provisioning')
		expect(vendorStatusToRunStatus('running')).toBe('running')
		expect(vendorStatusToRunStatus('succeeded')).toBe('succeeded')
		expect(vendorStatusToRunStatus('failed')).toBe('failed')
		expect(vendorStatusToRunStatus('cancelled')).toBe('cancelled')
		expect(vendorStatusToRunStatus('unknown')).toBeNull()
	})
})
