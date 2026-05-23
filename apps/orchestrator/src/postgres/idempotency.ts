/**
 * PostgresIdempotencyStore — INSERT ... ON CONFLICT DO NOTHING.
 *
 * Returns true when the row was newly inserted (caller proceeds), or
 * false when the key was already bound to the same run (caller
 * short-circuits). If a different run_id tries to claim a key, the
 * routine throws IdempotencyConflictError (client bug).
 */

import {
	IdempotencyConflictError,
	type IdempotencyStore,
} from '../orchestration/idempotency.js'
import type { SqlClient } from './client.js'

export class PostgresIdempotencyStore implements IdempotencyStore {
	constructor(private readonly sql: SqlClient) {}

	async claim(key: string, result_run_id: string): Promise<boolean> {
		const inserted = await this.sql<{ inserted: boolean }[]>`
			WITH ins AS (
				INSERT INTO idempotency_keys (key, result_run_id)
				VALUES (${key}, ${result_run_id})
				ON CONFLICT (key) DO NOTHING
				RETURNING key
			)
			SELECT EXISTS (SELECT 1 FROM ins) AS inserted
		`
		if (inserted[0]?.inserted) return true
		const existing = await this.sql<{ result_run_id: string }[]>`
			SELECT result_run_id FROM idempotency_keys WHERE key = ${key}
		`
		const row = existing[0]
		if (!row) return false // race; treat as not-newly-inserted
		if (row.result_run_id !== result_run_id) {
			throw new IdempotencyConflictError(key, row.result_run_id, result_run_id)
		}
		return false
	}

	async has(key: string): Promise<boolean> {
		const rows = await this.sql<{ exists: boolean }[]>`
			SELECT EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ${key}) AS exists
		`
		return rows[0]?.exists ?? false
	}
}
