/**
 * StoreBackedApprovalGate — production approval gate. Writes a
 * row through the ApprovalStore, then blocks on a resolution.
 *
 * Two channels resolve the wait:
 *
 *   1. Same-instance fast path — when /api/approvals/:id/approve
 *      lands on the SAME function instance that started the run,
 *      we wake the waiter via an in-process Map<ApprovalId,
 *      resolver>. O(1) wake, zero latency.
 *
 *   2. Cross-instance fallback — the run is on instance A, the
 *      operator decides on instance B. A's Map doesn't have a
 *      resolver, but the row has the decision. We poll the row
 *      every `pollIntervalMs` (default 2s) and wake when we see
 *      it.
 *
 * Both channels coexist safely because the store is idempotent
 * (resolve() on an already-resolved row returns the existing
 * decision) and the run loop only reads the resolution once.
 *
 * Timeout: every gate request has a TTL (default 15 min). On
 * timeout the row stays pending and the run loop treats it as
 * 'rejected' so the model continues with a "no" rather than
 * hanging forever. Operators can later see the row in the
 * pending list and decide; that decision just won't affect this
 * (long-dead) run.
 * @author asigdel29
 */

import type { UserId } from '@agent-canvas/orchestrator-types'
import type {
	ApprovalDecision,
	ApprovalGate,
	ApprovalRequest,
} from './runLoop.js'
import type { ApprovalStore } from './approvalStore.js'
import type { ApprovalId } from './agentRecord.js'

/**
 * Build an ApprovalDecision without an undefined-typed
 * resolved_by_user_id field. exactOptionalPropertyTypes treats
 * `{ foo: undefined }` differently from `{}`; we want the latter.
 */
function buildDecision(
	resolution: 'approved' | 'rejected',
	resolved_by_user_id: string | null
): ApprovalDecision {
	if (resolved_by_user_id) {
		return { resolution, resolved_by_user_id }
	}
	return { resolution }
}

const DEFAULT_POLL_MS = 2_000
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

export interface StoreBackedApprovalGateOptions {
	readonly store: ApprovalStore
	readonly pollIntervalMs?: number
	readonly timeoutMs?: number
	/**
	 * Optional emit hook so the canvas can refresh the inbox over
	 * SSE the moment a row lands. The actual SSE wiring lives in
	 * runtime.ts and the API routes; this gate stays loosely
	 * coupled.
	 */
	readonly onRequest?: (request: ApprovalRequest, id: ApprovalId) => void
}

interface PendingWaiter {
	resolve(decision: ApprovalDecision): void
}

export class StoreBackedApprovalGate implements ApprovalGate {
	private readonly waiters = new Map<ApprovalId, PendingWaiter>()
	private readonly pollMs: number
	private readonly timeoutMs: number

	constructor(private readonly opts: StoreBackedApprovalGateOptions) {
		this.pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
	}

	async requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
		const row = await this.opts.store.request({
			agent_id: req.agent.id,
			run_id: req.run_id,
			tool_name: req.tool_name,
			tool_input: req.tool_input,
			tool_description: req.tool_description,
			safety: req.safety,
		})
		this.opts.onRequest?.(req, row.id)
		return this.waitForResolution(row.id)
	}

	/**
	 * Called by /api/approvals/:id/approve|reject to record the
	 * decision and wake the same-instance waiter if one exists.
	 */
	async resolve(
		id: ApprovalId,
		decision: { resolution: 'approved' | 'rejected'; resolved_by_user_id: UserId }
	): Promise<void> {
		const row = await this.opts.store.resolve(id, decision)
		const waiter = this.waiters.get(id)
		if (waiter) {
			this.waiters.delete(id)
			waiter.resolve(buildDecision(row.resolution!, row.resolved_by_user_id))
		}
	}

	private async waitForResolution(id: ApprovalId): Promise<ApprovalDecision> {
		// Register a same-instance waiter and start a polling timer.
		// Whichever fires first wins the race; the other becomes a
		// no-op.
		const start = Date.now()
		return new Promise<ApprovalDecision>((resolveOuter) => {
			let settled = false
			const settle = (decision: ApprovalDecision) => {
				if (settled) return
				settled = true
				this.waiters.delete(id)
				clearInterval(poll)
				clearTimeout(deadline)
				resolveOuter(decision)
			}
			this.waiters.set(id, { resolve: settle })

			const poll = setInterval(() => {
				void (async () => {
					try {
						const row = await this.opts.store.get(id)
						if (row && row.resolved_at && row.resolution) {
							settle(buildDecision(row.resolution, row.resolved_by_user_id))
						}
					} catch {
						// transient store error; the next poll tick retries
					}
				})()
			}, this.pollMs)

			const deadline = setTimeout(() => {
				// Fail closed — treat as rejected so the model gets a
				// definite "no" and can recover. The pending row stays
				// in the store for operator forensics.
				settle({ resolution: 'rejected' })
			}, this.timeoutMs)
			void start // silence unused
		})
	}
}
