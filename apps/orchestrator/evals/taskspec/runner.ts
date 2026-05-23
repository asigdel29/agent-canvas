/**
 * Eval runner — loads JSON fixtures, runs the taskSpec generator over
 * each one, and reports judge results per category.
 *
 * Cost ceiling (eng review decision 41): each run records the number
 * of fixtures executed; CI compares against the per-PR + daily cap and
 * fails-closed if exceeded.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
	generateTaskSpec,
	type GenerateInput,
} from '../../src/orchestration/taskSpec.js'
import { judge, type FixtureExpectedShape, type JudgeResult } from './judge.js'

export interface Fixture {
	readonly input: GenerateInput
	readonly expected_shape: FixtureExpectedShape
	readonly notes?: string
}

export interface FixtureRecord {
	readonly category: string
	readonly file: string
	readonly fixture: Fixture
}

export interface EvalReport {
	readonly total: number
	readonly passed: number
	readonly failed: number
	readonly results: readonly EvalResult[]
	readonly by_category: ReadonlyMap<string, { total: number; passed: number; failed: number }>
}

export interface EvalResult {
	readonly category: string
	readonly file: string
	readonly result: JudgeResult
}

export function loadFixtures(rootDir: string): readonly FixtureRecord[] {
	const records: FixtureRecord[] = []
	for (const category of safeReaddir(rootDir)) {
		if (category.startsWith('_') || category === 'baselines' || category === 'README.md') continue
		const categoryDir = join(rootDir, category)
		if (!isDir(categoryDir)) continue
		for (const file of safeReaddir(categoryDir)) {
			if (!file.endsWith('.json')) continue
			const raw = readFileSync(join(categoryDir, file), 'utf8')
			const parsed = JSON.parse(raw) as Fixture
			records.push({ category, file, fixture: parsed })
		}
	}
	return records
}

export function runEval(records: readonly FixtureRecord[]): EvalReport {
	const results: EvalResult[] = []
	for (const r of records) {
		const spec = generateTaskSpec(r.fixture.input)
		const result = judge(spec, r.fixture.expected_shape)
		results.push({ category: r.category, file: r.file, result })
	}
	const by_category = new Map<
		string,
		{ total: number; passed: number; failed: number }
	>()
	for (const r of results) {
		const bucket = by_category.get(r.category) ?? { total: 0, passed: 0, failed: 0 }
		bucket.total += 1
		if (r.result.pass) bucket.passed += 1
		else bucket.failed += 1
		by_category.set(r.category, bucket)
	}
	return {
		total: results.length,
		passed: results.filter((r) => r.result.pass).length,
		failed: results.filter((r) => !r.result.pass).length,
		results,
		by_category,
	}
}

function safeReaddir(p: string): readonly string[] {
	try {
		return readdirSync(p)
	} catch {
		return []
	}
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory()
	} catch {
		return false
	}
}
