#!/usr/bin/env node
/**
 * add-author.mjs — stamp `@author asigdel29` into the leading doc comment
 * of every TypeScript source file that does not already carry one.
 *
 * The Oswego documentation standard requires each file to record its
 * authorship. This codebase already opens almost every file with a `/**`
 * header describing its purpose, so this pass only inserts the missing
 * `@author` line immediately before that header's closing `*​/`. Files
 * without a leading doc comment, and files that already name an author,
 * are left untouched and reported so they can be handled by hand.
 *
 * Usage:  node scripts/add-author.mjs [--apply] <path...>
 *   Without --apply it only reports what it would change (dry run).
 *
 * @author asigdel29
 */

import { readFileSync, writeFileSync } from 'node:fs'

const AUTHOR_LINE = ' * @author asigdel29'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const files = args.filter((a) => a !== '--apply')

let changed = 0
let skippedNoHeader = 0
let skippedHasAuthor = 0

for (const file of files) {
	const text = readFileSync(file, 'utf8')
	const lines = text.split('\n')

	// Must open with a /** doc comment (allowing a shebang first line).
	let start = 0
	if (lines[0]?.startsWith('#!')) start = 1
	if (!lines[start]?.trimStart().startsWith('/**')) {
		skippedNoHeader += 1
		continue
	}

	// Find the closing */ of that leading block.
	let end = -1
	for (let i = start; i < lines.length; i += 1) {
		if (lines[i].includes('*/')) {
			end = i
			break
		}
	}
	if (end === -1) {
		skippedNoHeader += 1
		continue
	}

	const header = lines.slice(start, end + 1).join('\n')
	if (header.includes('@author')) {
		skippedHasAuthor += 1
		continue
	}

	// Insert the author line just before the closing */. If the line
	// before the closer is blank-ish (" *"), keep it tidy by inserting
	// after the last content line.
	lines.splice(end, 0, AUTHOR_LINE)
	if (apply) writeFileSync(file, lines.join('\n'), 'utf8')
	changed += 1
}

console.log(
	`[add-author] ${apply ? 'updated' : 'would update'} ${changed} files; ` +
		`skipped ${skippedHasAuthor} (already authored), ${skippedNoHeader} (no header)`
)
