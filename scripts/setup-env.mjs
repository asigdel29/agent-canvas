#!/usr/bin/env node
/**
 * setup-env.mjs — produce a usable apps/orchestrator/.env.local from
 * .env.example, with cryptographically-random secrets pre-filled.
 *
 * What gets filled in:
 *   JWT_SECRET, SSE_TOKEN_SECRET, AUTH_STATE_SECRET — three 32-byte
 *   hex strings via crypto.randomBytes. Each one is independent so
 *   a leak of one never compromises the others.
 *
 * What is left blank (and the script tells you so):
 *   - DATABASE_URL, DATABASE_URL_SESSION (Neon)
 *   - ANTHROPIC_API_KEY, E2B_API_KEY (BYOK; can also live in the
 *     browser via SettingsDrawer)
 *   - GITHUB_OAUTH_CLIENT_ID / SECRET (per-deploy OAuth app)
 *   - UPSTASH_REDIS_REST_URL / TOKEN (production-only)
 *   - WEBHOOK_SECRET_* (one per provider you wire)
 *   - KMS_KEY_ID (production-only)
 *
 * Refuses to overwrite an existing .env.local — pass --force to
 * blow away the existing file (lossy; the prior secrets are gone).
 *
 * Usage:
 *   npm run setup:env              # creates if missing
 *   npm run setup:env -- --force   # overwrites
 */

import { randomBytes } from 'node:crypto'
import { readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const EXAMPLE_PATH = join(REPO_ROOT, 'apps/orchestrator/.env.example')
const TARGET_PATH = join(REPO_ROOT, 'apps/orchestrator/.env.local')

const SECRETS_TO_FILL = ['JWT_SECRET', 'SSE_TOKEN_SECRET', 'AUTH_STATE_SECRET']

async function fileExists(path) {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

function rand() {
	return randomBytes(32).toString('hex')
}

function fill(source) {
	let out = source
	for (const key of SECRETS_TO_FILL) {
		const re = new RegExp(`^${key}=.*$`, 'm')
		out = out.replace(re, `${key}=${rand()}`)
	}
	return out
}

async function main() {
	const force = process.argv.includes('--force')

	if (!(await fileExists(EXAMPLE_PATH))) {
		console.error(`[setup-env] missing ${EXAMPLE_PATH}; run from repo root.`)
		process.exit(1)
	}

	if ((await fileExists(TARGET_PATH)) && !force) {
		console.error(
			`[setup-env] ${TARGET_PATH} already exists. Re-run with --force to overwrite (you will lose the existing secrets).`
		)
		process.exit(1)
	}

	const source = await readFile(EXAMPLE_PATH, 'utf8')
	const filled = fill(source)
	await writeFile(TARGET_PATH, filled, 'utf8')

	console.log(`[setup-env] wrote ${TARGET_PATH}`)
	console.log(`[setup-env] filled with fresh 32-byte hex secrets:`)
	for (const key of SECRETS_TO_FILL) console.log(`  ${key}`)
	console.log(`[setup-env] still TODO before you run dev:`)
	console.log(`  GITHUB_OAUTH_CLIENT_ID + GITHUB_OAUTH_CLIENT_SECRET`)
	console.log(`    (create at https://github.com/settings/developers)`)
	console.log(`  CANVAS_ORIGIN     defaults to http://localhost:5173 — fine for local`)
	console.log(`  ANTHROPIC_API_KEY (optional — can paste in the Settings drawer instead)`)
	console.log(`  E2B_API_KEY       (optional — only for computer-use agents)`)
	console.log(`  DATABASE_URL      (optional — without it the orchestrator runs in-memory)`)
	console.log(``)
	console.log(`[setup-env] next: npm run dev`)
}

main().catch((err) => {
	console.error(`[setup-env] failed: ${err.message}`)
	process.exit(1)
})
