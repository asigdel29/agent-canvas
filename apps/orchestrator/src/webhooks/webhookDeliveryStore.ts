/**
 * webhookDeliveryStore — the worklist for the outbound dispatcher.
 *
 * One row per (endpoint, event) attempt. The dispatcher claims rows
 * via `claimPending()` (atomic: status pending → in_flight), POSTs,
 * then either marks success, schedules a retry, or marks failed
 * after the attempts budget is exhausted.
 *
 * Retry schedule (exponential backoff):
 *   attempt  delay
 *   1        0          first try, on enqueue
 *   2        5s
 *   3        30s
 *   4        2min
 *   5        10min
 *   6        1h
 *   7        6h
 *   8        24h
 *
 * After attempt 8 we mark failed_at. Customers needing higher
 * delivery durability can replay from the audit log; the queue is
 * not a long-term store.
 */

import { randomUUID } from 'node:crypto'

import type { SqlClient } from '../postgres/client.js'

export type DeliveryStatus = 'pending' | 'in_flight' | 'succeeded' | 'failed'

export const MAX_ATTEMPTS = 8

/** Delay before the next attempt at this attempt_num (1-based). */
export function nextDelayMs(attemptNum: number): number {
	const schedule = [
		0, // attempt 1: enqueue → immediate
		5_000, // 5s
		30_000, // 30s
		2 * 60_000, // 2min
		10 * 60_000, // 10min
		60 * 60_000, // 1h
		6 * 60 * 60_000, // 6h
		24 * 60 * 60_000, // 24h
	]
	const idx = Math.min(Math.max(0, attemptNum - 1), schedule.length - 1)
	return schedule[idx]!
}

export interface DeliveryRecord {
	readonly id: string
	readonly endpoint_id: string
	readonly event_id: string
	readonly event_type: string
	readonly body: string
	readonly status: DeliveryStatus
	readonly attempt_num: number
	readonly next_attempt_at: string | null
	readonly last_status_code: number | null
	readonly last_error: string | null
	readonly created_at: string
	readonly succeeded_at: string | null
	readonly failed_at: string | null
}

export interface EnqueueInput {
	readonly endpoint_id: string
	readonly event_id: string
	readonly event_type: string
	readonly body: string
}

export interface MarkOutcomeInput {
	readonly delivery_id: string
	readonly status_code: number | null
	readonly error: string | null
}

export interface WebhookDeliveryStore {
	/** Insert a row in `pending` status with attempt_num=0 and next_attempt_at=now. */
	enqueue(input: EnqueueInput): Promise<DeliveryRecord>
	/**
	 * Atomically pick up to `n` pending rows whose next_attempt_at <= now,
	 * flip them to `in_flight`, and return them. The flip ensures two
	 * concurrent drains never pick the same row.
	 */
	claimPending(n: number): Promise<readonly DeliveryRecord[]>
	/** Mark a row succeeded; status_code carries the 2xx for the operator's view. */
	markSucceeded(input: MarkOutcomeInput): Promise<void>
	/**
	 * Schedule the next retry, or mark failed if attempts are exhausted.
	 * Returns the post-update record so the dispatcher can log it.
	 */
	markAttemptFailed(input: MarkOutcomeInput): Promise<DeliveryRecord>
	/** Visibility for the operator's debug surface. */
	listByEndpoint(endpoint_id: string, limit?: number): Promise<readonly DeliveryRecord[]>
}

/* -------------------------------------------------------------- *
 * In-memory                                                       *
 * -------------------------------------------------------------- */

export class InMemoryWebhookDeliveryStore implements WebhookDeliveryStore {
	private readonly rows = new Map<string, DeliveryRecord>()

	async enqueue(input: EnqueueInput): Promise<DeliveryRecord> {
		const id = `whd_${randomUUID()}`
		const now = new Date().toISOString()
		const rec: DeliveryRecord = {
			id,
			endpoint_id: input.endpoint_id,
			event_id: input.event_id,
			event_type: input.event_type,
			body: input.body,
			status: 'pending',
			attempt_num: 0,
			next_attempt_at: now,
			last_status_code: null,
			last_error: null,
			created_at: now,
			succeeded_at: null,
			failed_at: null,
		}
		this.rows.set(id, rec)
		return rec
	}

	async claimPending(n: number): Promise<readonly DeliveryRecord[]> {
		const now = Date.now()
		const claimed: DeliveryRecord[] = []
		for (const r of this.rows.values()) {
			if (claimed.length >= n) break
			if (r.status !== 'pending') continue
			if (r.next_attempt_at !== null && Date.parse(r.next_attempt_at) > now) continue
			const flipped: DeliveryRecord = { ...r, status: 'in_flight' }
			this.rows.set(r.id, flipped)
			claimed.push(flipped)
		}
		return claimed
	}

	async markSucceeded(input: MarkOutcomeInput): Promise<void> {
		const r = this.rows.get(input.delivery_id)
		if (!r) return
		const now = new Date().toISOString()
		this.rows.set(input.delivery_id, {
			...r,
			status: 'succeeded',
			last_status_code: input.status_code,
			last_error: input.error,
			succeeded_at: now,
			next_attempt_at: null,
			attempt_num: r.attempt_num + 1,
		})
	}

	async markAttemptFailed(input: MarkOutcomeInput): Promise<DeliveryRecord> {
		const r = this.rows.get(input.delivery_id)
		if (!r) throw new Error(`delivery ${input.delivery_id} not found`)
		const nextAttempt = r.attempt_num + 1
		const now = new Date().toISOString()
		if (nextAttempt >= MAX_ATTEMPTS) {
			const failed: DeliveryRecord = {
				...r,
				status: 'failed',
				attempt_num: nextAttempt,
				last_status_code: input.status_code,
				last_error: input.error,
				failed_at: now,
				next_attempt_at: null,
			}
			this.rows.set(input.delivery_id, failed)
			return failed
		}
		const next = new Date(Date.now() + nextDelayMs(nextAttempt + 1)).toISOString()
		const retried: DeliveryRecord = {
			...r,
			status: 'pending',
			attempt_num: nextAttempt,
			last_status_code: input.status_code,
			last_error: input.error,
			next_attempt_at: next,
		}
		this.rows.set(input.delivery_id, retried)
		return retried
	}

	async listByEndpoint(endpoint_id: string, limit = 100): Promise<readonly DeliveryRecord[]> {
		const out: DeliveryRecord[] = []
		for (const r of this.rows.values()) {
			if (r.endpoint_id === endpoint_id) out.push(r)
		}
		out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
		return out.slice(0, limit)
	}
}

/* -------------------------------------------------------------- *
 * Postgres                                                        *
 * -------------------------------------------------------------- */

interface DeliveryRow {
	id: string
	endpoint_id: string
	event_id: string
	event_type: string
	body: string
	status: DeliveryStatus
	attempt_num: number
	next_attempt_at: Date | null
	last_status_code: number | null
	last_error: string | null
	created_at: Date
	succeeded_at: Date | null
	failed_at: Date | null
}

function rowToRecord(row: DeliveryRow): DeliveryRecord {
	return {
		id: row.id,
		endpoint_id: row.endpoint_id,
		event_id: row.event_id,
		event_type: row.event_type,
		body: row.body,
		status: row.status,
		attempt_num: row.attempt_num,
		next_attempt_at: row.next_attempt_at ? row.next_attempt_at.toISOString() : null,
		last_status_code: row.last_status_code,
		last_error: row.last_error,
		created_at: row.created_at.toISOString(),
		succeeded_at: row.succeeded_at ? row.succeeded_at.toISOString() : null,
		failed_at: row.failed_at ? row.failed_at.toISOString() : null,
	}
}

export class PostgresWebhookDeliveryStore implements WebhookDeliveryStore {
	constructor(private readonly sql: SqlClient) {}

	async enqueue(input: EnqueueInput): Promise<DeliveryRecord> {
		const id = `whd_${randomUUID()}`
		const rows = await this.sql<DeliveryRow[]>`
			INSERT INTO webhook_deliveries (
				id, endpoint_id, event_id, event_type, body,
				status, attempt_num, next_attempt_at
			) VALUES (
				${id}, ${input.endpoint_id}, ${input.event_id}, ${input.event_type},
				${input.body}, 'pending', 0, now()
			)
			RETURNING *
		`
		return rowToRecord(rows[0]!)
	}

	async claimPending(n: number): Promise<readonly DeliveryRecord[]> {
		// FOR UPDATE SKIP LOCKED is the canonical pattern for a
		// Postgres-backed queue: every concurrent drain picks a
		// disjoint set of rows, no advisory locks or contention.
		const rows = await this.sql<DeliveryRow[]>`
			UPDATE webhook_deliveries SET status = 'in_flight'
			WHERE id IN (
				SELECT id FROM webhook_deliveries
				WHERE status = 'pending'
				  AND (next_attempt_at IS NULL OR next_attempt_at <= now())
				ORDER BY next_attempt_at
				LIMIT ${n}
				FOR UPDATE SKIP LOCKED
			)
			RETURNING *
		`
		return rows.map(rowToRecord)
	}

	async markSucceeded(input: MarkOutcomeInput): Promise<void> {
		await this.sql`
			UPDATE webhook_deliveries
			SET status = 'succeeded',
			    attempt_num = attempt_num + 1,
			    last_status_code = ${input.status_code},
			    last_error = ${input.error},
			    succeeded_at = now(),
			    next_attempt_at = NULL
			WHERE id = ${input.delivery_id}
		`
	}

	async markAttemptFailed(input: MarkOutcomeInput): Promise<DeliveryRecord> {
		const rows = await this.sql<DeliveryRow[]>`
			SELECT * FROM webhook_deliveries WHERE id = ${input.delivery_id}
		`
		const current = rows[0]
		if (!current) throw new Error(`delivery ${input.delivery_id} not found`)
		const nextAttempt = current.attempt_num + 1
		if (nextAttempt >= MAX_ATTEMPTS) {
			const failed = await this.sql<DeliveryRow[]>`
				UPDATE webhook_deliveries
				SET status = 'failed',
				    attempt_num = ${nextAttempt},
				    last_status_code = ${input.status_code},
				    last_error = ${input.error},
				    failed_at = now(),
				    next_attempt_at = NULL
				WHERE id = ${input.delivery_id}
				RETURNING *
			`
			return rowToRecord(failed[0]!)
		}
		const delayMs = nextDelayMs(nextAttempt + 1)
		const retried = await this.sql<DeliveryRow[]>`
			UPDATE webhook_deliveries
			SET status = 'pending',
			    attempt_num = ${nextAttempt},
			    last_status_code = ${input.status_code},
			    last_error = ${input.error},
			    next_attempt_at = now() + (${delayMs} || ' milliseconds')::interval
			WHERE id = ${input.delivery_id}
			RETURNING *
		`
		return rowToRecord(retried[0]!)
	}

	async listByEndpoint(endpoint_id: string, limit = 100): Promise<readonly DeliveryRecord[]> {
		const rows = await this.sql<DeliveryRow[]>`
			SELECT * FROM webhook_deliveries
			WHERE endpoint_id = ${endpoint_id}
			ORDER BY created_at DESC
			LIMIT ${limit}
		`
		return rows.map(rowToRecord)
	}
}
