#!/usr/bin/env node
/**
 * setup-env.mjs — produce a usable .env from .env.example at the repo
 * root, with cryptographically-random secrets pre-filled.
 *
 * What gets filled in:
 *   JWT_SECRET, SSE_TOKEN_SECRET, AUTH_STATE_SECRET, VAULT_KEY — four
 *   independent 32-byte hex strings via crypto.randomBytes, so leaking
 *   one never compromises the others.
 *
 * What is left blank (and the script tells you so):
 *   - DATABASE_URL, DATABASE_URL_SESSION (Postgres / Railway)
 *   - ANTHROPIC_API_KEY, E2B_API_KEY (BYOK; can also live in the
 *     browser via the Settings drawer)
 *   - GITHUB_OAUTH_CLIENT_ID / SECRET (needed only for AUTH_MODE=github)
 *   - WEBHOOK_SECRET_GITHUB (only if you wire GitHub webhooks)
 *
 * Refuses to overwrite an existing .env — pass --force to blow away the
 * existing file (lossy; the prior secrets are gone).
 *
 * Usage:
 *   npm run setup:env              # creates ./.env if missing
 *   npm run setup:env -- --force   # overwrites
 *
 * @author asigdel29
 */

import { randomBytes } from 'node:crypto'
import { readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const EXAMPLE_PATH = join(REPO_ROOT, '.env.example')
const TARGET_PATH = join(REPO_ROOT, '.env')

const SECRETS_TO_FILL = ['JWT_SECRET', 'SSE_TOKEN_SECRET', 'AUTH_STATE_SECRET', 'VAULT_KEY']

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
	console.log(`[setup-env] edit ./.env to finish:`)
	console.log(`  DATABASE_URL      Postgres URL (without it, state is in-memory)`)
	console.log(`  ANTHROPIC_API_KEY optional — users can also paste a key in Settings`)
	console.log(`  AUTH_MODE=open    to let teammates join by name (no GitHub app), OR`)
	console.log(`  GITHUB_OAUTH_*    set both for AUTH_MODE=github`)
	console.log(``)
	console.log(`[setup-env] next: npm start  (or npm run dev for hot reload)`)
}

main().catch((err) => {
	console.error(`[setup-env] failed: ${err.message}`)
	process.exit(1)
})
