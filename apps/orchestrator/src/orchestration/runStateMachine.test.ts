/**
 * Tests for runStateMachine.
 *
 * @author asigdel29
 */

import { describe, expect, it } from 'vitest'
import { InvalidStateTransitionError } from '@agent-canvas/orchestrator-types'
import { applyTransition } from './runStateMachine.js'

describe('applyTransition (strict, write-side)', () => {
	it('accepts queued → provisioning', () => {
		expect(applyTransition('queued', 'provisioning')).toBe('provisioning')
	})

	it('accepts running → succeeded', () => {
		expect(applyTransition('running', 'succeeded')).toBe('succeeded')
	})

	it('accepts running → awaiting_input → running (token-refresh bounce)', () => {
		const s1 = applyTransition('running', 'awaiting_input')
		expect(s1).toBe('awaiting_input')
		expect(applyTransition(s1, 'running')).toBe('running')
	})

	it('is idempotent on same-state transitions', () => {
		expect(applyTransition('running', 'running')).toBe('running')
	})

	it('rejects succeeded → running (cannot resurrect)', () => {
		expect(() => applyTransition('succeeded', 'running')).toThrow(InvalidStateTransitionError)
	})

	it('rejects running → queued (cannot regress)', () => {
		expect(() => applyTransition('running', 'queued')).toThrow(InvalidStateTransitionError)
	})

	it('rejects any transition out of cancelled', () => {
		expect(() => applyTransition('cancelled', 'running')).toThrow(InvalidStateTransitionError)
	})

	it('rejects unreachable → anything (terminal)', () => {
		expect(() => applyTransition('unreachable', 'running')).toThrow(InvalidStateTransitionError)
	})

	it('error carries the from/to pair for diagnosis', () => {
		try {
			applyTransition('succeeded', 'running')
			expect.fail('should have thrown')
		} catch (e) {
			expect(e).toBeInstanceOf(InvalidStateTransitionError)
			expect((e as InvalidStateTransitionError).from).toBe('succeeded')
			expect((e as InvalidStateTransitionError).to).toBe('running')
		}
	})
})
