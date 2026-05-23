import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { loadFixtures, runEval } from './runner.js'

const HERE = dirname(fileURLToPath(import.meta.url))

describe('taskSpec eval runner', () => {
	it('loads every JSON fixture across the category directories', () => {
		const records = loadFixtures(HERE)
		expect(records.length).toBeGreaterThan(0)
		const categories = new Set(records.map((r) => r.category))
		// At least happy and injection categories must exist; more land in
		// follow-up PRs that expand the corpus per eng review decision 41.
		expect(categories.has('happy')).toBe(true)
		expect(categories.has('injection')).toBe(true)
	})

	it('every fixture passes the judge (regression bar)', () => {
		const records = loadFixtures(HERE)
		const report = runEval(records)
		if (report.failed > 0) {
			const failures = report.results.filter((r) => !r.result.pass)
			const detail = failures
				.map((f) => {
					const reasons = f.result.pass === false ? f.result.reasons.join('; ') : ''
					return `  ${f.category}/${f.file}: ${reasons}`
				})
				.join('\n')
			throw new Error(`taskSpec eval failed ${report.failed}/${report.total}:\n${detail}`)
		}
		expect(report.failed).toBe(0)
	})

	it('aggregates results by category for the CI dashboard', () => {
		const records = loadFixtures(HERE)
		const report = runEval(records)
		for (const [category, bucket] of report.by_category) {
			expect(bucket.total).toBeGreaterThan(0)
			expect(bucket.passed + bucket.failed).toBe(bucket.total)
			// Sanity: at least one fixture per category in this initial corpus.
			expect(bucket.total).toBeGreaterThanOrEqual(1)
			expect(category.length).toBeGreaterThan(0)
		}
	})
})
