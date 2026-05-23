import { describe, expect, it } from 'vitest'
import {
	type RunEvent,
	type RunId,
	VALID_TRANSITIONS,
	foldStatus,
	isTerminal,
	isValidTransition,
} from './index.js'

const RUN: RunId = 'run_test_1' as RunId

function ev(kind: RunEvent['kind'], seq: number, payload: Record<string, unknown> = {}): RunEvent {
	return {
		seq,
		run_id: RUN,
		kind,
		ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
		schema_version: 1,
		payload,
	}
}

describe('isValidTransition', () => {
	it('accepts queued → provisioning', () => {
		expect(isValidTransition('queued', 'provisioning')).toBe(true)
	})

	it('rejects succeeded → running (terminal cannot resurrect)', () => {
		expect(isValidTransition('succeeded', 'running')).toBe(false)
	})

	it('rejects running → queued (cannot regress)', () => {
		expect(isValidTransition('running', 'queued')).toBe(false)
	})

	it('all terminal states have zero outgoing transitions', () => {
		for (const t of ['succeeded', 'failed', 'cancelled', 'unreachable'] as const) {
			expect(VALID_TRANSITIONS[t]).toHaveLength(0)
		}
	})
})

describe('isTerminal', () => {
	it('classifies the four terminals', () => {
		expect(isTerminal('succeeded')).toBe(true)
		expect(isTerminal('failed')).toBe(true)
		expect(isTerminal('cancelled')).toBe(true)
		expect(isTerminal('unreachable')).toBe(true)
	})

	it('does not classify mid-lifecycle states as terminal', () => {
		expect(isTerminal('queued')).toBe(false)
		expect(isTerminal('provisioning')).toBe(false)
		expect(isTerminal('running')).toBe(false)
		expect(isTerminal('awaiting_input')).toBe(false)
	})
})

describe('foldStatus', () => {
	it('returns null for empty event lists', () => {
		expect(foldStatus([])).toBeNull()
	})

	it('folds the happy path queued → provisioning → running → succeeded', () => {
		const events: RunEvent[] = [
			ev('queued', 1),
			ev('provisioning', 2),
			ev('running', 3),
			ev('succeeded', 4),
		]
		expect(foldStatus(events)).toBe('succeeded')
	})

	it('ignores progress / tool_call / approval_request events', () => {
		const events: RunEvent[] = [
			ev('queued', 1),
			ev('running', 2),
			ev('progress', 3),
			ev('tool_call', 4),
			ev('approval_request', 5),
		]
		expect(foldStatus(events)).toBe('running')
	})

	it('is idempotent on duplicate status events', () => {
		const events: RunEvent[] = [
			ev('queued', 1),
			ev('running', 2),
			ev('running', 3),
			ev('running', 4),
		]
		expect(foldStatus(events)).toBe('running')
	})

	it('skips invalid transitions silently (forgiving fold contract)', () => {
		const events: RunEvent[] = [
			ev('queued', 1),
			ev('running', 2),
			ev('succeeded', 3),
			ev('running', 4), // invalid: succeeded → running, must be skipped
		]
		expect(foldStatus(events)).toBe('succeeded')
	})

	it('resets to a status_checkpoint value after truncation', () => {
		const events: RunEvent[] = [
			ev('status_checkpoint', 100, { status: 'running', truncated_through_seq: 99 }),
			ev('progress', 101),
			ev('succeeded', 102),
		]
		expect(foldStatus(events)).toBe('succeeded')
	})

	it('handles awaiting_input bounce-back to running', () => {
		const events: RunEvent[] = [
			ev('queued', 1),
			ev('running', 2),
			ev('awaiting_input', 3),
			ev('running', 4),
			ev('succeeded', 5),
		]
		expect(foldStatus(events)).toBe('succeeded')
	})

	it('records unreachable as a terminal-via-reconciler outcome', () => {
		const events: RunEvent[] = [ev('running', 1), ev('unreachable', 2)]
		expect(foldStatus(events)).toBe('unreachable')
	})
})
