/**
 * PostgresBillingGateStore — spend ceiling per project.
 *
 * Reads the configured budget and accrued spend for a project; the
 * BillingGate decides whether to allow new run starts.
 *
 * NOTE: window rollover (e.g., resetting accrued_micros at midnight)
 * is handled by an out-of-band scheduler that compares
 * `window_started_at + window_seconds` against now() and resets the
 * row. Not in this adapter's responsibility.
 */

import type {
	BillingGateStore,
	ProjectBudget,
	SpendSnapshot,
} from '../orchestration/billingGate.js'
import type { SqlClient } from './client.js'

export class PostgresBillingGateStore implements BillingGateStore {
	constructor(private readonly sql: SqlClient) {}

	async getBudget(project_id: string): Promise<ProjectBudget | null> {
		const rows = await this.sql<ProjectBudget[]>`
			SELECT project_id, window_seconds, ceiling_micros
			  FROM project_budgets
			 WHERE project_id = ${project_id}
		`
		return rows[0] ?? null
	}

	async getCurrentSpend(project_id: string): Promise<SpendSnapshot> {
		const rows = await this.sql<SpendSnapshot[]>`
			SELECT project_id, window_started_at, accrued_micros
			  FROM project_spend
			 WHERE project_id = ${project_id}
		`
		const row = rows[0]
		if (row) return row
		const window_started_at = new Date().toISOString()
		await this.sql`
			INSERT INTO project_spend (project_id, window_started_at, accrued_micros)
			VALUES (${project_id}, ${window_started_at}, 0)
			ON CONFLICT (project_id) DO NOTHING
		`
		return { project_id, window_started_at, accrued_micros: 0 }
	}

	async recordSpend(project_id: string, micros: number): Promise<SpendSnapshot> {
		const rows = await this.sql<SpendSnapshot[]>`
			INSERT INTO project_spend (project_id, window_started_at, accrued_micros)
			VALUES (${project_id}, ${new Date().toISOString()}, ${micros})
			ON CONFLICT (project_id) DO UPDATE
			  SET accrued_micros = project_spend.accrued_micros + EXCLUDED.accrued_micros
			RETURNING project_id, window_started_at, accrued_micros
		`
		return rows[0]!
	}
}
