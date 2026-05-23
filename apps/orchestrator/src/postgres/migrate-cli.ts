/**
 * Migration CLI runner.
 *
 *   node --import tsx apps/orchestrator/src/postgres/migrate-cli.ts
 *
 * Reads DATABASE_URL from the environment, applies any new migrations,
 * and prints a small summary. Exit code 0 on success, 1 on any error.
 */

import { createSqlClient } from './client.js'
import { runMigrations } from './migrate.js'

async function main(): Promise<void> {
	if (!process.env['DATABASE_URL']) {
		process.stderr.write('DATABASE_URL is required\n')
		process.exit(1)
	}
	const sql = createSqlClient()
	try {
		const { applied, skipped } = await runMigrations(sql)
		if (applied.length === 0) {
			process.stdout.write(`already up to date (${skipped.length} migrations recorded)\n`)
		} else {
			process.stdout.write(`applied ${applied.length} migration(s):\n`)
			for (const f of applied) process.stdout.write(`  ${f}\n`)
		}
	} finally {
		await sql.end({ timeout: 5 })
	}
}

main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err)
	process.stderr.write(`migration failed: ${msg}\n`)
	process.exit(1)
})
