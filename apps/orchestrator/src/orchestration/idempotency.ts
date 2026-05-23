/**
 * Idempotency keys for commands.
 *
 * Commands arriving at the command endpoint carry an idempotency_key
 * (typically shape_id + nonce). The orchestrator records seen keys and
 * deduplicates: double-clicks, two-user races, and webhook redelivery
 * all converge to a single event-log append.
 *
 * The InMemoryIdempotencyStore is suitable for tests. Production uses a
 * Postgres UNIQUE(idempotency_key) constraint with INSERT ... ON CONFLICT
 * DO NOTHING returning whether the insert was new.
 */

export interface IdempotencyStore {
	/**
	 * Record `key` if absent. Returns true if newly recorded (caller
	 * proceeds), false if already seen (caller short-circuits).
	 *
	 * On collision with a different `result_run_id`, throws — this means
	 * two different commands tried to claim the same idempotency key,
	 * which is a client bug.
	 */
	claim(key: string, result_run_id: string): Promise<boolean>

	/** For tests / observability. */
	has(key: string): Promise<boolean>
}

export class IdempotencyConflictError extends Error {
	constructor(
		public readonly key: string,
		public readonly existing_run_id: string,
		public readonly attempted_run_id: string
	) {
		super(
			`idempotency key ${key} already bound to run ${existing_run_id}, ` +
				`cannot bind to ${attempted_run_id}`
		)
		this.name = 'IdempotencyConflictError'
	}
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
	private readonly seen = new Map<string, string>()

	async claim(key: string, result_run_id: string): Promise<boolean> {
		const existing = this.seen.get(key)
		if (existing === undefined) {
			this.seen.set(key, result_run_id)
			return true
		}
		if (existing !== result_run_id) {
			throw new IdempotencyConflictError(key, existing, result_run_id)
		}
		return false
	}

	async has(key: string): Promise<boolean> {
		return this.seen.has(key)
	}
}
