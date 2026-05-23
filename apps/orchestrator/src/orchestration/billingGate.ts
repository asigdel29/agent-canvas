/**
 * BillingGate — refuses new run-starts when a project has exhausted its
 * compute budget.
 *
 * Bound: a per-project budget window (typically day or month) with a
 * dollar ceiling. Each agent run accrues spend from its vendor; the
 * gate consults current spend before authorizing a start.
 *
 * The audit log records every run's per-vendor spend; this module
 * holds the live tally. Production uses a Postgres table updated by an
 * outbox worker as vendor billing webhooks arrive.
 */

export interface ProjectBudget {
	readonly project_id: string
	/** Window length in seconds (86400 = day, 2592000 = 30-day month). */
	readonly window_seconds: number
	/** Budget ceiling for the window, in micro-dollars (1_000_000 = $1). */
	readonly ceiling_micros: number
}

export interface SpendSnapshot {
	readonly project_id: string
	readonly window_started_at: string
	readonly accrued_micros: number
}

export type GateDecision =
	| { allow: true; remaining_micros: number }
	| { allow: false; reason: 'budget_exhausted' | 'no_budget_configured'; accrued_micros: number; ceiling_micros: number }

export interface BillingGateStore {
	getBudget(project_id: string): Promise<ProjectBudget | null>
	getCurrentSpend(project_id: string): Promise<SpendSnapshot>
	recordSpend(project_id: string, micros: number): Promise<SpendSnapshot>
}

export class BillingGate {
	constructor(private readonly store: BillingGateStore) {}

	async check(project_id: string): Promise<GateDecision> {
		const budget = await this.store.getBudget(project_id)
		if (!budget) {
			const snap = await this.store.getCurrentSpend(project_id)
			return {
				allow: false,
				reason: 'no_budget_configured',
				accrued_micros: snap.accrued_micros,
				ceiling_micros: 0,
			}
		}
		const snap = await this.store.getCurrentSpend(project_id)
		const remaining = budget.ceiling_micros - snap.accrued_micros
		if (remaining <= 0) {
			return {
				allow: false,
				reason: 'budget_exhausted',
				accrued_micros: snap.accrued_micros,
				ceiling_micros: budget.ceiling_micros,
			}
		}
		return { allow: true, remaining_micros: remaining }
	}

	async recordSpend(project_id: string, micros: number): Promise<SpendSnapshot> {
		if (micros < 0) throw new Error('spend cannot be negative')
		return this.store.recordSpend(project_id, micros)
	}
}

// ─────────────────────────────────────────────────────────────────────
// In-memory store (tests + reference)
// ─────────────────────────────────────────────────────────────────────

export class InMemoryBillingGateStore implements BillingGateStore {
	private readonly budgets = new Map<string, ProjectBudget>()
	private readonly spends = new Map<string, SpendSnapshot>()

	setBudget(b: ProjectBudget): void {
		this.budgets.set(b.project_id, b)
		if (!this.spends.has(b.project_id)) {
			this.spends.set(b.project_id, {
				project_id: b.project_id,
				window_started_at: new Date().toISOString(),
				accrued_micros: 0,
			})
		}
	}

	async getBudget(project_id: string): Promise<ProjectBudget | null> {
		return this.budgets.get(project_id) ?? null
	}

	async getCurrentSpend(project_id: string): Promise<SpendSnapshot> {
		const existing = this.spends.get(project_id)
		if (existing) return existing
		const fresh: SpendSnapshot = {
			project_id,
			window_started_at: new Date().toISOString(),
			accrued_micros: 0,
		}
		this.spends.set(project_id, fresh)
		return fresh
	}

	async recordSpend(project_id: string, micros: number): Promise<SpendSnapshot> {
		const current = await this.getCurrentSpend(project_id)
		const next: SpendSnapshot = {
			project_id,
			window_started_at: current.window_started_at,
			accrued_micros: current.accrued_micros + micros,
		}
		this.spends.set(project_id, next)
		return next
	}
}
