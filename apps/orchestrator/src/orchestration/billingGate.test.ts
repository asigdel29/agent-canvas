import { describe, expect, it } from 'vitest'
import { BillingGate, InMemoryBillingGateStore } from './billingGate.js'

describe('BillingGate', () => {
	it('rejects when no budget is configured', async () => {
		const store = new InMemoryBillingGateStore()
		const gate = new BillingGate(store)
		const decision = await gate.check('proj_x')
		expect(decision.allow).toBe(false)
		if (!decision.allow) expect(decision.reason).toBe('no_budget_configured')
	})

	it('allows when accrued spend is below the ceiling', async () => {
		const store = new InMemoryBillingGateStore()
		store.setBudget({ project_id: 'p1', window_seconds: 86400, ceiling_micros: 50_000_000 }) // $50
		const gate = new BillingGate(store)
		const decision = await gate.check('p1')
		expect(decision.allow).toBe(true)
		if (decision.allow) expect(decision.remaining_micros).toBe(50_000_000)
	})

	it('rejects with budget_exhausted when accrued >= ceiling', async () => {
		const store = new InMemoryBillingGateStore()
		store.setBudget({ project_id: 'p1', window_seconds: 86400, ceiling_micros: 1_000_000 })
		const gate = new BillingGate(store)
		await gate.recordSpend('p1', 1_500_000)
		const decision = await gate.check('p1')
		expect(decision.allow).toBe(false)
		if (!decision.allow) {
			expect(decision.reason).toBe('budget_exhausted')
			expect(decision.accrued_micros).toBe(1_500_000)
			expect(decision.ceiling_micros).toBe(1_000_000)
		}
	})

	it('recordSpend accumulates across calls', async () => {
		const store = new InMemoryBillingGateStore()
		store.setBudget({ project_id: 'p1', window_seconds: 86400, ceiling_micros: 10_000_000 })
		const gate = new BillingGate(store)
		await gate.recordSpend('p1', 1_000_000)
		await gate.recordSpend('p1', 2_500_000)
		const snap = await store.getCurrentSpend('p1')
		expect(snap.accrued_micros).toBe(3_500_000)
	})

	it('recordSpend rejects negative spend (programming error)', async () => {
		const store = new InMemoryBillingGateStore()
		store.setBudget({ project_id: 'p1', window_seconds: 86400, ceiling_micros: 1_000_000 })
		const gate = new BillingGate(store)
		await expect(gate.recordSpend('p1', -100)).rejects.toThrow()
	})

	it('rejects exactly at the ceiling (no fractional remaining)', async () => {
		const store = new InMemoryBillingGateStore()
		store.setBudget({ project_id: 'p1', window_seconds: 86400, ceiling_micros: 1_000_000 })
		const gate = new BillingGate(store)
		await gate.recordSpend('p1', 1_000_000)
		const decision = await gate.check('p1')
		expect(decision.allow).toBe(false)
	})
})
