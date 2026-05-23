/**
 * @agent-canvas/orchestrator-types
 *
 * Zero-runtime domain types for the agent orchestrator. Imported by:
 *   - apps/orchestrator (runtime implementations)
 *   - apps/orchestrator/evals (eval harness, the "second consumer" that
 *     justified extracting this package on day one)
 *   - the canvas app (for projected display record shapes)
 *
 * Everything in this file is types + pure helpers. No runtime
 * dependencies on Postgres, Vercel, or any infrastructure.
 *
 * ASCII state machine — must match orchestrator runtime exactly:
 *
 *   queued ──▶ provisioning ──▶ running ──┬──▶ succeeded
 *                  │              │  ▲    │
 *                  │              ▼  │    │
 *                  │       awaiting_input ┤
 *                  ▼              │       ▼
 *               failed ◀──────────┴────▶ cancelled
 *
 *   Terminal: succeeded · failed · cancelled · unreachable
 */

// ─────────────────────────────────────────────────────────────────────
// Run + state machine
// ─────────────────────────────────────────────────────────────────────

export type RunId = string & { readonly __brand: 'RunId' }
export type RoomId = string & { readonly __brand: 'RoomId' }
export type UserId = string & { readonly __brand: 'UserId' }
export type VendorId = 'codex' | 'openhands'
export type ProviderId =
	| 'github'
	| 'linear'
	| 'slack'
	| 'discord'
	| 'graphite'
	| 'railway'
	| 'vercel'
	| 'supabase'

export type RunStatus =
	| 'queued'
	| 'provisioning'
	| 'running'
	| 'awaiting_input'
	| 'succeeded'
	| 'failed'
	| 'cancelled'
	| 'unreachable'

export const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled', 'unreachable'] as const

export function isTerminal(s: RunStatus): boolean {
	return (TERMINAL_STATUSES as readonly RunStatus[]).includes(s)
}

/**
 * Valid state transitions. Invalid transitions are rejected by the
 * runtime; this table is the source of truth and is tested in the
 * orchestrator app.
 */
export const VALID_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
	queued: ['provisioning', 'failed', 'cancelled'],
	provisioning: ['running', 'failed', 'cancelled'],
	running: ['awaiting_input', 'succeeded', 'failed', 'cancelled', 'unreachable'],
	awaiting_input: ['running', 'failed', 'cancelled', 'unreachable'],
	succeeded: [],
	failed: [],
	cancelled: [],
	unreachable: [],
}

export function isValidTransition(from: RunStatus, to: RunStatus): boolean {
	return VALID_TRANSITIONS[from].includes(to)
}

// ─────────────────────────────────────────────────────────────────────
// Event log — append-only, monotonic seq per run
// ─────────────────────────────────────────────────────────────────────

export type RunEventKind =
	| 'queued'
	| 'provisioning'
	| 'running'
	| 'awaiting_input'
	| 'progress'
	| 'tool_call'
	| 'approval_request'
	| 'approval_decision'
	| 'reconnect_required'
	| 'succeeded'
	| 'failed'
	| 'cancelled'
	| 'unreachable'
	| 'status_checkpoint'

export interface RunEvent {
	/** Monotonic sequence per run_id. Enforced by Postgres UNIQUE(run_id, seq). */
	readonly seq: number
	readonly run_id: RunId
	readonly kind: RunEventKind
	readonly ts: string // ISO 8601, event-time (vendor's clock or backend's clock at receipt)
	/** Schema version of the payload. Bump when the discriminated union shape evolves. */
	readonly schema_version: number
	readonly payload: Readonly<Record<string, unknown>>
	/** Provider event_id used for idempotency dedup. Optional for synthetic events. */
	readonly provider_event_id?: string
	/** Vendor that authored this event, if vendor-origin. */
	readonly vendor?: VendorId
}

/**
 * Status checkpoint event — written before any event-log truncation.
 * The fold function uses the most recent checkpoint as its starting state
 * so a truncated tail does not corrupt derived status.
 */
export interface StatusCheckpointPayload {
	readonly status: RunStatus
	readonly truncated_through_seq: number
}

// ─────────────────────────────────────────────────────────────────────
// run_current_state (denormalized cache row, updated in same TX as
// every event_log append). Reads are O(1).
//
// Postgres write SQL (illustrative, lives in the orchestrator):
//   UPDATE run_current_state
//   SET status = $1, vendor = $2, last_seq = $3, last_event_at = $4,
//       schema_version = $5, updated_at = NOW()
//   WHERE run_id = $6 AND last_seq < $3
//
// The last_seq predicate is the monotonicity guard against
// out-of-order replays (Eng review decision 42 + outside-voice HIGH).
// ─────────────────────────────────────────────────────────────────────

export interface RunCurrentState {
	readonly run_id: RunId
	readonly status: RunStatus
	readonly vendor: VendorId | null
	readonly last_seq: number
	readonly last_event_at: string
	readonly schema_version: number
	readonly updated_at: string
}

// ─────────────────────────────────────────────────────────────────────
// Pure fold — derive RunStatus from a sequence of events.
//
// Used by:
//   - the orchestrator runtime to compute status during recovery /
//     reconciliation
//   - the eval harness (the second consumer that justified this package)
//   - any client that needs to verify a folded result against backend
// ─────────────────────────────────────────────────────────────────────

const EVENT_TO_STATUS: Partial<Record<RunEventKind, RunStatus>> = {
	queued: 'queued',
	provisioning: 'provisioning',
	running: 'running',
	awaiting_input: 'awaiting_input',
	succeeded: 'succeeded',
	failed: 'failed',
	cancelled: 'cancelled',
	unreachable: 'unreachable',
}

/**
 * Fold a sequence of events to the current RunStatus.
 *
 * Status-replay semantics: each status-bearing event replaces the
 * current status. Strict transition validation lives on the WRITE side
 * (`applyTransition`); the fold trusts what's in the log.
 *
 * Rules:
 * - Events MUST arrive in monotonic seq order; pass through a sort if
 *   the caller can't guarantee it.
 * - status_checkpoint events reset the running state (used after
 *   event-log truncation; see decision 13 in the design doc).
 * - Non-status events (progress, tool_call, approval_request,
 *   approval_decision, reconnect_required) do not transition status.
 * - Once a terminal state is reached (succeeded / failed / cancelled /
 *   unreachable), subsequent status events are IGNORED — terminal is
 *   sticky. This matches the state machine's "terminals have zero
 *   outgoing transitions" rule.
 * - Returns `null` if the event list is empty.
 */
export function foldStatus(events: readonly RunEvent[]): RunStatus | null {
	let status: RunStatus | null = null
	for (const event of events) {
		if (event.kind === 'status_checkpoint') {
			const payload = event.payload as Partial<StatusCheckpointPayload>
			if (payload.status !== undefined) status = payload.status
			continue
		}
		const target = EVENT_TO_STATUS[event.kind]
		if (target === undefined) continue
		// Once terminal, stay terminal. Subsequent status events ignored.
		if (status !== null && isTerminal(status)) continue
		status = target
	}
	return status
}

// ─────────────────────────────────────────────────────────────────────
// Commands (canvas → orchestrator), authorized at the command endpoint
// ─────────────────────────────────────────────────────────────────────

export type CommandKind =
	| 'start_request'
	| 'approve'
	| 'reject'
	| 'cancel'
	| 'reconnect'
	| 'subscribe'
	| 'unsubscribe'

export interface Command {
	readonly kind: CommandKind
	readonly run_id: RunId
	readonly room_id: RoomId
	readonly actor_user_id: UserId
	/** Idempotency key — typically derived from the shape_id + a nonce. */
	readonly idempotency_key: string
	/** TOCTOU guard for cross-room subscription writes. Required when run_id is a subscribed run. */
	readonly subscription_epoch?: number
	readonly payload: Readonly<Record<string, unknown>>
	readonly ts: string
}

// ─────────────────────────────────────────────────────────────────────
// Cross-room subscriptions (Eng review decision 38 — per-subscription
// delegated capability with explicit allowed actions)
// ─────────────────────────────────────────────────────────────────────

export type SubscriptionAction = 'approve' | 'reject' | 'cancel'

export interface Subscription {
	readonly id: string
	readonly run_id: RunId
	readonly origin_room_id: RoomId
	readonly target_room_id: RoomId
	readonly established_by_user_id: UserId
	readonly allowed_actions: readonly SubscriptionAction[]
	/** Bumped on every edit/revoke. Commands carry the epoch they observed. */
	readonly subscription_epoch: number
	readonly created_at: string
	readonly revoked_at: string | null
}

// ─────────────────────────────────────────────────────────────────────
// Projection contracts — what the orchestrator writes back into the
// tldraw document for canvas rendering. The canvas is a projection
// (CEO review decision 1, post-inversion).
// ─────────────────────────────────────────────────────────────────────

export interface ProjectedRunRecord {
	readonly id: string // tldraw record id
	readonly run_id: RunId
	readonly status: RunStatus
	readonly title: string
	readonly vendor: VendorId | null
	/** Origin room — present even on local runs; chip shown only when origin != current room. */
	readonly origin_room_id: RoomId
	readonly last_event_seq: number
	readonly last_event_at: string
}

export interface ProjectedEventRecord {
	readonly id: string
	readonly run_id: RunId
	readonly seq: number
	readonly kind: RunEventKind
	readonly summary: string
	readonly ts: string
}

// ─────────────────────────────────────────────────────────────────────
// Audit log entries (Section 8.1, durable per-run record)
// ─────────────────────────────────────────────────────────────────────

export interface AuditEntry {
	readonly id: string
	readonly ts: string
	readonly actor_user_id: UserId
	readonly room_id: RoomId
	readonly run_id: RunId | null
	readonly action: string
	readonly result: 'ok' | 'rejected' | 'error'
	readonly subscription_id?: string
	readonly established_by_user_id?: UserId
	readonly trace_id: string
	readonly details: Readonly<Record<string, unknown>>
}

// ─────────────────────────────────────────────────────────────────────
// Errors raised by the orchestrator/state machine. Connector errors
// live in @agent-canvas/connector-core.
// ─────────────────────────────────────────────────────────────────────

export class InvalidStateTransitionError extends Error {
	constructor(
		public readonly from: RunStatus,
		public readonly to: RunStatus
	) {
		super(`invalid run state transition: ${from} → ${to}`)
		this.name = 'InvalidStateTransitionError'
	}
}

export class NoCompatibleVendorError extends Error {
	constructor(public readonly required_tools: readonly string[]) {
		super(`no compatible vendor for required tools: [${required_tools.join(', ')}]`)
		this.name = 'NoCompatibleVendorError'
	}
}

export class StaleSubscriptionEpochError extends Error {
	constructor(
		public readonly observed: number,
		public readonly current: number
	) {
		super(`stale subscription epoch (observed=${observed}, current=${current})`)
		this.name = 'StaleSubscriptionEpochError'
	}
}
