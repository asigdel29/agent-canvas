/**
 * Projector — translates authoritative run_events into projected
 * display records on the tldraw canvas.
 *
 * Flow:
 *
 *   event_log row written (in TX)
 *     │
 *     └─▶ transactional outbox row written (same TX)
 *           │
 *           └─▶ outbox drainer calls projector.project(event)
 *                 │
 *                 ├─▶ fan-out by subscription set (origin + subscribed rooms)
 *                 ├─▶ tombstone-aware: skip writes for runs whose shape is deleted
 *                 └─▶ idempotent: same event projected twice produces the
 *                     same output (the canvas LWW absorbs duplicates safely)
 *
 * Cross-room fan-out is bounded by max-rooms-per-run (10 in Phase 1).
 * @author asigdel29
 */

import type {
	ProjectedEventRecord,
	ProjectedRunRecord,
	RoomId,
	RunEvent,
	RunId,
	Subscription,
} from '@agent-canvas/orchestrator-types'

export interface ProjectionTarget {
	readonly room_id: RoomId
	readonly is_origin: boolean
}

export interface ProjectionWrite {
	readonly target: ProjectionTarget
	readonly run_record_patch: Partial<ProjectedRunRecord> | null
	readonly event_record: ProjectedEventRecord | null
}

export interface SubscriptionResolver {
	/** Origin room of the run + any active subscriptions (target rooms). */
	getTargets(run_id: RunId): Promise<readonly ProjectionTarget[]>
}

export interface TombstoneOracle {
	/** True if the agent shape for this run was deleted on the given room's canvas. */
	isTombstoned(run_id: RunId, room_id: RoomId): Promise<boolean>
}

export interface ProjectionSink {
	/**
	 * Apply a projection write to the tldraw doc for the target room.
	 * Idempotent: the same (event_seq, target_room) twice has the same
	 * effect as once.
	 */
	apply(write: ProjectionWrite): Promise<void>
}

export class Projector {
	constructor(
		private readonly resolver: SubscriptionResolver,
		private readonly tombstones: TombstoneOracle,
		private readonly sink: ProjectionSink
	) {}

	async project(event: RunEvent, run_title: string): Promise<readonly ProjectionWrite[]> {
		const targets = await this.resolver.getTargets(event.run_id)
		const writes: ProjectionWrite[] = []
		for (const target of targets) {
			if (await this.tombstones.isTombstoned(event.run_id, target.room_id)) continue
			const write = this.toWrite(event, run_title, target)
			writes.push(write)
			await this.sink.apply(write)
		}
		return writes
	}

	private toWrite(
		event: RunEvent,
		run_title: string,
		target: ProjectionTarget
	): ProjectionWrite {
		const event_record: ProjectedEventRecord = {
			id: `evt_${event.run_id}_${event.seq}`,
			run_id: event.run_id,
			seq: event.seq,
			kind: event.kind,
			summary: summarize(event),
			ts: event.ts,
		}
		// Status-bearing events also patch the parent run record.
		const status_kinds = new Set([
			'queued',
			'provisioning',
			'running',
			'awaiting_input',
			'succeeded',
			'failed',
			'cancelled',
			'unreachable',
		])
		const run_record_patch =
			status_kinds.has(event.kind)
				? ({
						run_id: event.run_id,
						status: event.kind as ProjectedRunRecord['status'],
						title: run_title,
						last_event_seq: event.seq,
						last_event_at: event.ts,
					} as Partial<ProjectedRunRecord>)
				: null
		return { target, run_record_patch, event_record }
	}
}

function summarize(event: RunEvent): string {
	switch (event.kind) {
		case 'tool_call': {
			const tool = (event.payload as { tool?: string }).tool ?? 'tool'
			return `${tool}`
		}
		case 'approval_request': {
			const tool = (event.payload as { tool?: string }).tool ?? 'action'
			return `approval: ${tool}`
		}
		case 'approval_decision': {
			const d = (event.payload as { decision?: string }).decision ?? 'decided'
			return `approval ${d}`
		}
		case 'reconnect_required': {
			const prov = (event.payload as { provider?: string }).provider ?? 'connector'
			return `reconnect ${prov}`
		}
		case 'progress': {
			const msg = (event.payload as { message?: string }).message ?? ''
			return msg.length > 0 ? msg : 'progress'
		}
		default:
			return event.kind
	}
}

// ─────────────────────────────────────────────────────────────────────
// Default in-memory resolver / oracle / sink for tests
// ─────────────────────────────────────────────────────────────────────

/** Resolves projection targets from a SubscriptionStore + origin map. */
export class InMemorySubscriptionResolver implements SubscriptionResolver {
	private readonly origins = new Map<RunId, RoomId>()
	private readonly subscriptions: Subscription[] = []

	setOrigin(run_id: RunId, room_id: RoomId): void {
		this.origins.set(run_id, room_id)
	}

	addSubscription(s: Subscription): void {
		this.subscriptions.push(s)
	}

	async getTargets(run_id: RunId): Promise<readonly ProjectionTarget[]> {
		const origin = this.origins.get(run_id)
		const targets: ProjectionTarget[] = []
		if (origin) targets.push({ room_id: origin, is_origin: true })
		for (const sub of this.subscriptions) {
			if (sub.run_id !== run_id) continue
			if (sub.revoked_at !== null) continue
			targets.push({ room_id: sub.target_room_id, is_origin: false })
		}
		return targets
	}
}

export class InMemoryTombstoneOracle implements TombstoneOracle {
	private readonly tombstones = new Set<string>()

	mark(run_id: RunId, room_id: RoomId): void {
		this.tombstones.add(this.key(run_id, room_id))
	}

	async isTombstoned(run_id: RunId, room_id: RoomId): Promise<boolean> {
		return this.tombstones.has(this.key(run_id, room_id))
	}

	private key(run_id: RunId, room_id: RoomId): string {
		return `${run_id}::${room_id}`
	}
}

export class InMemoryProjectionSink implements ProjectionSink {
	readonly writes: ProjectionWrite[] = []
	async apply(write: ProjectionWrite): Promise<void> {
		this.writes.push(write)
	}
}
