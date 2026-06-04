/**
 * CommandEndpoint — the authz gate.
 *
 * Canvas interactions become commands written into the orchestration
 * domain. The command endpoint:
 *
 *   1. Looks up the actor's capabilities in the originating room.
 *   2. If the command targets a subscribed run (cross-room), additionally
 *      consults the SubscriptionStore (per-subscription delegated cap +
 *      subscription_epoch TOCTOU guard).
 *   3. For 'start_request' commands, consults the BillingGate.
 *   4. Validates the state-machine transition implied by the command.
 *   5. Claims the idempotency key.
 *   6. Appends the resulting event(s) and the outbox row in one
 *      transaction (in the in-memory impl, just sequenced).
 *   7. Writes the audit entry.
 *
 * The endpoint does NOT call the agent vendor directly; vendor calls
 * happen later, driven from the event log by the orchestrator's run
 * coordinator. This keeps the endpoint focused on the trust boundary.
 * @author asigdel29
 */

import {
	StaleSubscriptionEpochError,
	type Command,
	type RoomId,
	type RunId,
	type SubscriptionAction,
	type UserId,
} from '@agent-canvas/orchestrator-types'
import { applyTransition } from './runStateMachine.js'
import { type EventLog } from './eventLog.js'
import { type AuditLog } from './auditLog.js'
import { type IdempotencyStore } from './idempotency.js'
import {
	type RunCurrentStateCache,
	projectStateFromEvent,
} from './runCurrentState.js'
import { type Outbox } from './transactionalOutbox.js'
import { type SubscriptionStore } from './subscriptionStore.js'
import { BillingGate } from './billingGate.js'
import { ensureTraceparent } from './tracing.js'

// ─────────────────────────────────────────────────────────────────────
// Capabilities — what a user holds in a room
// ─────────────────────────────────────────────────────────────────────

export type Capability = 'view' | 'edit' | 'run-agents' | 'subscriber-actor' | 'admin'

export interface CapabilityResolver {
	get(user_id: UserId, room_id: RoomId): Promise<readonly Capability[]>
}

export class StaticCapabilityResolver implements CapabilityResolver {
	private readonly table = new Map<string, readonly Capability[]>()
	grant(user_id: UserId, room_id: RoomId, capabilities: readonly Capability[]): void {
		this.table.set(`${user_id}::${room_id}`, capabilities)
	}
	async get(user_id: UserId, room_id: RoomId): Promise<readonly Capability[]> {
		return this.table.get(`${user_id}::${room_id}`) ?? []
	}
}

// ─────────────────────────────────────────────────────────────────────
// Command rejection reasons
// ─────────────────────────────────────────────────────────────────────

export class CommandRejected extends Error {
	constructor(
		public readonly reason:
			| 'unauthorized'
			| 'budget_exhausted'
			| 'no_budget_configured'
			| 'stale_subscription_epoch'
			| 'invalid_action'
			| 'malformed_command'
			| 'idempotency_conflict',
		message: string
	) {
		super(message)
		this.name = 'CommandRejected'
	}
}

// ─────────────────────────────────────────────────────────────────────
// Endpoint
// ─────────────────────────────────────────────────────────────────────

export interface CommandEndpointDeps {
	readonly capabilities: CapabilityResolver
	readonly subscriptions: SubscriptionStore
	readonly billingGate: BillingGate | null
	readonly idempotency: IdempotencyStore
	readonly eventLog: EventLog
	readonly runCurrentState: RunCurrentStateCache
	readonly outbox: Outbox
	readonly auditLog: AuditLog
	/** Maps room_id → project_id for billing gate lookups. */
	readonly projectIdForRoom: (room_id: RoomId) => string
	/** Maps run_id → origin room. */
	readonly originRoomForRun: (run_id: RunId) => Promise<RoomId | null>
}

export interface AcceptResult {
	readonly seq: number
	readonly deduped: boolean
	readonly trace_id: string
}

export class CommandEndpoint {
	constructor(private readonly deps: CommandEndpointDeps) {}

	async accept(command: Command, traceparent_header?: string): Promise<AcceptResult> {
		const traceparent = ensureTraceparent(traceparent_header)
		const traceId = traceparent.split('-')[1]!

		// Phase A — authz
		await this.authorize(command)

		// Phase B — billing (only for start_request)
		if (command.kind === 'start_request' && this.deps.billingGate) {
			const project_id = this.deps.projectIdForRoom(command.room_id)
			const decision = await this.deps.billingGate.check(project_id)
			if (!decision.allow) {
				await this.deps.auditLog.record({
					actor_user_id: command.actor_user_id,
					room_id: command.room_id,
					run_id: command.run_id,
					action: command.kind,
					result: 'rejected',
					trace_id: traceId,
					details: { reason: decision.reason },
				})
				throw new CommandRejected(decision.reason, `billing: ${decision.reason}`)
			}
		}

		// Phase C — idempotency claim
		const claimed = await this.deps.idempotency.claim(command.idempotency_key, command.run_id)
		if (!claimed) {
			// Already processed — return the prior result. For simplicity we
			// report deduped without re-doing work; the original event already
			// drives the canvas.
			return { seq: 0, deduped: true, trace_id: traceId }
		}

		// Phase D — event log append (atomic with outbox + run_current_state)
		const eventKind = commandToEventKind(command.kind)
		const append = await this.deps.eventLog.append({
			run_id: command.run_id,
			kind: eventKind,
			payload: command.payload,
		})

		// Phase E — update run_current_state with monotonicity guard
		const prior = await this.deps.runCurrentState.get(command.run_id)
		const eventTs = new Date().toISOString()
		const statusForEvent = eventKindToStatus(eventKind)
		const initial = !prior
		if (initial) {
			await this.deps.runCurrentState.insertInitial(
				projectStateFromEvent(null, command.run_id, append.seq, statusForEvent ?? 'queued', null, eventTs)
			)
		} else if (statusForEvent !== null) {
			const next = applyTransition(prior.status, statusForEvent)
			await this.deps.runCurrentState.updateIfNewer(
				projectStateFromEvent(prior, command.run_id, append.seq, next, prior.vendor, eventTs)
			)
		}

		// Phase F — outbox enqueue (drained AFTER commit in production)
		const events = await this.deps.eventLog.read(command.run_id, { fromSeq: append.seq, limit: 1 })
		const event = events[0]
		if (event) await this.deps.outbox.enqueue(event)

		// Phase G — audit
		await this.deps.auditLog.record({
			actor_user_id: command.actor_user_id,
			room_id: command.room_id,
			run_id: command.run_id,
			action: command.kind,
			result: 'ok',
			trace_id: traceId,
			details: { seq: append.seq },
		})

		return { seq: append.seq, deduped: append.deduped, trace_id: traceId }
	}

	private async authorize(command: Command): Promise<void> {
		const caps = await this.deps.capabilities.get(command.actor_user_id, command.room_id)
		const baseRequirement = requiredCapability(command.kind)
		if (baseRequirement && !caps.includes(baseRequirement) && !caps.includes('admin')) {
			await this.recordRejection(command, 'unauthorized', `missing capability: ${baseRequirement}`)
			throw new CommandRejected('unauthorized', `missing capability: ${baseRequirement}`)
		}

		// Cross-room subscription check: if the room is NOT the run's origin
		// AND the command writes to the run, additionally pass through the
		// subscription store.
		const origin = await this.deps.originRoomForRun(command.run_id)
		if (origin && origin !== command.room_id && isWriteCommand(command.kind)) {
			const action = commandKindToSubscriptionAction(command.kind)
			if (action === null) {
				throw new CommandRejected('invalid_action', `cannot perform ${command.kind} cross-room`)
			}
			if (command.subscription_epoch === undefined) {
				throw new CommandRejected(
					'stale_subscription_epoch',
					'cross-room command missing subscription_epoch'
				)
			}
			try {
				const sub = await this.deps.subscriptions.authorize(
					command.run_id,
					command.room_id,
					action,
					command.subscription_epoch
				)
				if (!sub) {
					await this.recordRejection(
						command,
						'unauthorized',
						'no active subscription with the requested action'
					)
					throw new CommandRejected('unauthorized', 'no active subscription with action')
				}
			} catch (err) {
				if (err instanceof StaleSubscriptionEpochError) {
					await this.recordRejection(
						command,
						'stale_subscription_epoch',
						`observed=${err.observed} current=${err.current}`
					)
					throw new CommandRejected('stale_subscription_epoch', err.message)
				}
				throw err
			}
		}
	}

	private async recordRejection(
		command: Command,
		reason: string,
		details: string
	): Promise<void> {
		await this.deps.auditLog.record({
			actor_user_id: command.actor_user_id,
			room_id: command.room_id,
			run_id: command.run_id,
			action: command.kind,
			result: 'rejected',
			trace_id: 'na',
			details: { reason, info: details },
		})
	}
}

// ─────────────────────────────────────────────────────────────────────
// Helpers — command kind ↔ event kind ↔ status mappings
// ─────────────────────────────────────────────────────────────────────

function requiredCapability(kind: Command['kind']): Capability | null {
	switch (kind) {
		case 'start_request':
			return 'run-agents'
		case 'cancel':
			return 'run-agents'
		case 'approve':
		case 'reject':
			return 'subscriber-actor'
		case 'reconnect':
			return 'run-agents'
		case 'subscribe':
		case 'unsubscribe':
			return 'run-agents'
	}
}

function isWriteCommand(kind: Command['kind']): boolean {
	return kind === 'approve' || kind === 'reject' || kind === 'cancel' || kind === 'reconnect'
}

function commandKindToSubscriptionAction(kind: Command['kind']): SubscriptionAction | null {
	if (kind === 'approve') return 'approve'
	if (kind === 'reject') return 'reject'
	if (kind === 'cancel') return 'cancel'
	return null
}

function commandToEventKind(kind: Command['kind']) {
	switch (kind) {
		case 'start_request':
			return 'queued' as const
		case 'approve':
			return 'approval_decision' as const
		case 'reject':
			return 'approval_decision' as const
		case 'cancel':
			return 'cancelled' as const
		case 'reconnect':
			return 'reconnect_required' as const
		case 'subscribe':
		case 'unsubscribe':
			return 'progress' as const
	}
}

function eventKindToStatus(kind: ReturnType<typeof commandToEventKind>) {
	switch (kind) {
		case 'queued':
			return 'queued' as const
		case 'cancelled':
			return 'cancelled' as const
		case 'approval_decision':
		case 'reconnect_required':
		case 'progress':
			return null
	}
}
