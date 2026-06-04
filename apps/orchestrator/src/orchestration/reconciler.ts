/**
 * Reconciler — active detection of silently-dead runs.
 *
 * The orchestrator delegates execution to a managed agent vendor. If
 * the vendor drops a run (process crash, sandbox eviction, billing
 * suspend) and the terminal webhook never arrives, the canvas would
 * show `running` forever. CEO decision 2.1 — `unreachable` — closes
 * that silent-failure path.
 *
 * Rules:
 *
 *   - Adaptive interval: 10 s while a run is `running`, 60 s while
 *     `awaiting_input`. Terminal states are NOT polled (waste of API).
 *   - Per-run wall-clock deadline. If the deadline blows without a
 *     terminal event, the run goes `unreachable` and surfaces an alert.
 *   - The reconciler does NOT poll a vendor that is currently
 *     rate-limited (circuit breaker; outside-voice LOW). It backs off
 *     until the limit resets.
 *
 * Time is injected so tests can be deterministic.
 * @author asigdel29
 */

import {
	VendorRateLimitError,
	type ProviderAdapter,
	type VendorRunStatus,
} from '@agent-canvas/connector-core'
import {
	type RunCurrentState,
	type RunId,
	type RunStatus,
	isTerminal,
} from '@agent-canvas/orchestrator-types'

export interface TimeSource {
	now(): number
}

export const realTime: TimeSource = { now: () => Date.now() }

export interface ReconcilerEventSink {
	emitUnreachable(run_id: RunId, reason: string): Promise<void>
}

export interface ReconcilerOptions {
	readonly runningPollMs?: number
	readonly awaitingInputPollMs?: number
	readonly runDeadlineMs?: number
	readonly rateLimitBackoffMs?: number
}

const DEFAULTS = {
	runningPollMs: 10_000,
	awaitingInputPollMs: 60_000,
	runDeadlineMs: 24 * 60 * 60 * 1000,
	rateLimitBackoffMs: 30_000,
} as const

interface PollState {
	last_poll_at_ms: number
	rate_limited_until_ms: number
}

export class Reconciler {
	private readonly state = new Map<RunId, PollState>()

	constructor(
		private readonly clock: TimeSource = realTime,
		private readonly opts: Required<ReconcilerOptions> = DEFAULTS
	) {}

	/**
	 * Decide whether a particular run should be polled NOW given the
	 * adaptive interval and current state.
	 */
	shouldPoll(run: RunCurrentState): boolean {
		if (isTerminal(run.status)) return false
		const s = this.state.get(run.run_id)
		const now = this.clock.now()
		if (s && s.rate_limited_until_ms > now) return false
		const interval = this.intervalFor(run.status)
		if (!s) return true
		return now - s.last_poll_at_ms >= interval
	}

	/**
	 * Poll a single run. Returns:
	 *   - 'ok' on successful poll (state recorded)
	 *   - 'deadline_blown' if the run's wall-clock budget is exceeded;
	 *     emits the unreachable event as a side effect
	 *   - 'rate_limited' on VendorRateLimitError; backoff scheduled
	 */
	async poll(
		run: RunCurrentState,
		started_at_ms: number,
		adapter: ProviderAdapter,
		sink: ReconcilerEventSink
	): Promise<'ok' | 'deadline_blown' | 'rate_limited'> {
		if (isTerminal(run.status)) return 'ok'
		const now = this.clock.now()
		const deadline = started_at_ms + this.opts.runDeadlineMs
		if (now > deadline) {
			await sink.emitUnreachable(run.run_id, 'wall_clock_deadline')
			return 'deadline_blown'
		}
		try {
			const report = await adapter.getStatus(run.run_id)
			this.state.set(run.run_id, {
				last_poll_at_ms: now,
				rate_limited_until_ms: 0,
			})
			if (report.status === 'unknown') {
				await sink.emitUnreachable(run.run_id, 'vendor_returned_unknown')
				return 'deadline_blown'
			}
			return 'ok'
		} catch (err) {
			if (err instanceof VendorRateLimitError) {
				this.state.set(run.run_id, {
					last_poll_at_ms: now,
					rate_limited_until_ms: now + this.opts.rateLimitBackoffMs,
				})
				return 'rate_limited'
			}
			throw err
		}
	}

	private intervalFor(status: RunStatus): number {
		if (status === 'awaiting_input') return this.opts.awaitingInputPollMs
		return this.opts.runningPollMs
	}
}

/** Translates a vendor's run status report into a RunStatus event kind. */
export function vendorStatusToRunStatus(s: VendorRunStatus): RunStatus | null {
	switch (s) {
		case 'queued':
			return 'queued'
		case 'provisioning':
			return 'provisioning'
		case 'running':
			return 'running'
		case 'succeeded':
			return 'succeeded'
		case 'failed':
			return 'failed'
		case 'cancelled':
			return 'cancelled'
		case 'unknown':
			return null
	}
}
