/**
 * Tiny forward-only migration runner.
 *
 * Reads all SQL files in this directory's `migrations/` subdir,
 * applies any that haven't been recorded in `schema_migrations`, and
 * records each application. Each migration runs in its own transaction.
 *
 *   npm exec node --import tsx apps/orchestrator/src/postgres/migrate.ts
 *
 * Production deploys run this as a pre-deploy step; Vercel's build
 * hook is the natural place.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SqlClient } from './client.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, 'migrations')

export interface MigrationResult {
	readonly applied: readonly string[]
	readonly skipped: readonly string[]
}

export async function runMigrations(sql: SqlClient): Promise<MigrationResult> {
	await sql.unsafe(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			name        text PRIMARY KEY,
			applied_at  timestamptz NOT NULL DEFAULT now()
		)
	`)
	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith('.sql'))
		.sort()
	const applied: string[] = []
	const skipped: string[] = []
	for (const file of files) {
		const seen = await sql<{ name: string }[]>`
			SELECT name FROM schema_migrations WHERE name = ${file}
		`
		if (seen.length > 0) {
			skipped.push(file)
			continue
		}
		const sqlText = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
		await sql.begin(async (tx) => {
			await tx.unsafe(sqlText)
			await tx`INSERT INTO schema_migrations (name) VALUES (${file})`
		})
		applied.push(file)
	}
	return { applied, skipped }
}
