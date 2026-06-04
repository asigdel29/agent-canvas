/**
 * PostgresSubscriptionStore — per-subscription delegated capability
 * with subscription_epoch TOCTOU guard.
 * @author asigdel29
 */

import {
	StaleSubscriptionEpochError,
	type RoomId,
	type RunId,
	type Subscription,
	type SubscriptionAction,
} from '@agent-canvas/orchestrator-types'
import type {
	EstablishInput,
	SubscriptionStore,
} from '../orchestration/subscriptionStore.js'
import type { SqlClient } from './client.js'

export class PostgresSubscriptionStore implements SubscriptionStore {
	constructor(private readonly sql: SqlClient) {}

	async establish(input: EstablishInput): Promise<Subscription> {
		const id = `sub_${crypto.randomUUID()}`
		const created_at = new Date().toISOString()
		const allowed = input.allowed_actions ?? (['approve', 'reject', 'cancel'] as const)
		const rows = await this.sql<SubscriptionRow[]>`
			INSERT INTO subscriptions
				(id, run_id, origin_room_id, target_room_id, established_by_user_id,
				 allowed_actions, subscription_epoch, created_at, revoked_at)
			VALUES (${id}, ${input.run_id}, ${input.origin_room_id}, ${input.target_room_id},
				${input.established_by_user_id}, ${this.sql.array([...allowed])}, 1, ${created_at}, NULL)
			RETURNING *
		`
		return rowToSubscription(rows[0]!)
	}

	async get(id: string): Promise<Subscription | null> {
		const rows = await this.sql<SubscriptionRow[]>`
			SELECT * FROM subscriptions WHERE id = ${id}
		`
		return rows[0] ? rowToSubscription(rows[0]) : null
	}

	async getForRun(run_id: RunId): Promise<readonly Subscription[]> {
		const rows = await this.sql<SubscriptionRow[]>`
			SELECT * FROM subscriptions
			 WHERE run_id = ${run_id} AND revoked_at IS NULL
		`
		return rows.map(rowToSubscription)
	}

	async getForRunAndTarget(
		run_id: RunId,
		target_room_id: RoomId
	): Promise<Subscription | null> {
		const rows = await this.sql<SubscriptionRow[]>`
			SELECT * FROM subscriptions
			 WHERE run_id = ${run_id}
			   AND target_room_id = ${target_room_id}
			   AND revoked_at IS NULL
			 LIMIT 1
		`
		return rows[0] ? rowToSubscription(rows[0]) : null
	}

	async edit(id: string, allowed_actions: readonly SubscriptionAction[]): Promise<Subscription> {
		const rows = await this.sql<SubscriptionRow[]>`
			UPDATE subscriptions
			   SET allowed_actions    = ${this.sql.array([...allowed_actions])},
			       subscription_epoch = subscription_epoch + 1
			 WHERE id = ${id}
			RETURNING *
		`
		const row = rows[0]
		if (!row) throw new Error(`subscription not found: ${id}`)
		return rowToSubscription(row)
	}

	async revoke(id: string): Promise<Subscription> {
		const rows = await this.sql<SubscriptionRow[]>`
			UPDATE subscriptions
			   SET revoked_at         = ${new Date().toISOString()},
			       subscription_epoch = subscription_epoch + 1
			 WHERE id = ${id}
			RETURNING *
		`
		const row = rows[0]
		if (!row) throw new Error(`subscription not found: ${id}`)
		return rowToSubscription(row)
	}

	async authorize(
		run_id: RunId,
		target_room_id: RoomId,
		action: SubscriptionAction,
		observed_epoch: number
	): Promise<Subscription | null> {
		const sub = await this.getForRunAndTarget(run_id, target_room_id)
		if (!sub) return null
		if (sub.subscription_epoch !== observed_epoch) {
			throw new StaleSubscriptionEpochError(observed_epoch, sub.subscription_epoch)
		}
		if (!sub.allowed_actions.includes(action)) return null
		return sub
	}
}

interface SubscriptionRow {
	id: string
	run_id: string
	origin_room_id: string
	target_room_id: string
	established_by_user_id: string
	allowed_actions: string[]
	subscription_epoch: number
	created_at: string
	revoked_at: string | null
}

function rowToSubscription(row: SubscriptionRow): Subscription {
	return {
		id: row.id,
		run_id: row.run_id as RunId,
		origin_room_id: row.origin_room_id as RoomId,
		target_room_id: row.target_room_id as RoomId,
		established_by_user_id: row.established_by_user_id as Subscription['established_by_user_id'],
		allowed_actions: row.allowed_actions as readonly SubscriptionAction[],
		subscription_epoch: row.subscription_epoch,
		created_at: row.created_at,
		revoked_at: row.revoked_at,
	}
}
