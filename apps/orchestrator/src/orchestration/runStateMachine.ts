/**
 * Run state machine — runtime enforcement.
 *
 * The state machine table lives in @agent-canvas/orchestrator-types
 * (`VALID_TRANSITIONS`). This file enforces it at write time:
 * applyTransition() returns the new state on success, throws
 * InvalidStateTransitionError on a rejected transition.
 *
 * Invariants:
 *   - All write-time transitions go through applyTransition. The
 *     fold function in orchestrator-types is FORGIVING on read; the
 *     write side is STRICT.
 *   - Idempotent on duplicate same-state events (running → running
 *     is a no-op, not an error).
 *
 * ASCII state machine (must match VALID_TRANSITIONS in
 * @agent-canvas/orchestrator-types):
 *
 *   queued ──▶ provisioning ──▶ running ──┬──▶ succeeded
 *                  │              │  ▲    │
 *                  │              ▼  │    │
 *                  │       awaiting_input ┤
 *                  ▼              │       ▼
 *               failed ◀──────────┴────▶ cancelled
 *
 * @author asigdel29
 */

import {
	InvalidStateTransitionError,
	type RunStatus,
	isValidTransition,
} from '@agent-canvas/orchestrator-types'

/** Thrown by stubs not yet implemented in this initial scaffold. */
export class NotImplementedError extends Error {
	constructor(what: string) {
		super(`not implemented: ${what}`)
		this.name = 'NotImplementedError'
	}
}

/**
 * Apply a state transition with strict validation.
 *
 * Idempotent on same-state (running → running). Throws on invalid
 * transitions (e.g., succeeded → running).
 */
export function applyTransition(from: RunStatus, to: RunStatus): RunStatus {
	if (from === to) return from
	if (!isValidTransition(from, to)) {
		throw new InvalidStateTransitionError(from, to)
	}
	return to
}
