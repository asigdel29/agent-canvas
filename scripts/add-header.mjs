#!/usr/bin/env node
/**
 * add-header.mjs — prepend a minimal doc header to source files that lack
 * one, so every file satisfies the Oswego standard's file-documentation
 * rule (a leading comment stating the file's purpose and author).
 *
 * A purpose line is derived from the path: test and spec files document
 * the unit they cover, *.config.ts files document their tool, and a few
 * known entry points get a hand-written line. Files that already open
 * with a `/**` header are left untouched.
 *
 * Usage:  node scripts/add-header.mjs [--apply] <path...>
 *
 * @author asigdel29
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const files = args.filter((a) => a !== '--apply')

/** Hand-written purpose lines for entry points the heuristic can't name well. */
const KNOWN = {
	'main.tsx': 'Canvas client entry point — mounts <App> into the DOM.',
	'vite.config.ts': 'Vite build and dev-server configuration for the canvas app.',
	'playwright.config.ts': 'Playwright end-to-end test configuration for the canvas.',
}

/**
 * Derive a one-line purpose for a file from its path.
 *
 * @param file the file path.
 * @returns a human-readable purpose sentence.
 */
function purposeFor(file) {
	const name = basename(file)
	if (KNOWN[name]) return KNOWN[name]
	const unit = name.replace(/\.(test|spec)\.(ts|tsx)$/, '').replace(/\.(ts|tsx)$/, '')
	if (/\.(test|spec)\.(ts|tsx)$/.test(name)) return `Tests for ${unit}.`
	if (/\.config\.ts$/.test(name)) return `Configuration for ${unit}.`
	return `${unit}.`
}

let changed = 0
let skipped = 0

for (const file of files) {
	const text = readFileSync(file, 'utf8')
	const lines = text.split('\n')
	const firstCode = lines[0]?.startsWith('#!') ? 1 : 0
	if (lines[firstCode]?.trimStart().startsWith('/**')) {
		skipped += 1
		continue
	}
	const header = `/**\n * ${purposeFor(file)}\n *\n * @author asigdel29\n */\n\n`
	const shebang = firstCode === 1 ? lines[0] + '\n' : ''
	const body = lines.slice(firstCode).join('\n')
	if (apply) writeFileSync(file, shebang + header + body, 'utf8')
	changed += 1
}

console.log(`[add-header] ${apply ? 'added' : 'would add'} headers to ${changed} files; skipped ${skipped}`)
