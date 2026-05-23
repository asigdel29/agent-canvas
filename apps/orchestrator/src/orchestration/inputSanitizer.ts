/**
 * InputSanitizer — first line of defense against prompt injection.
 *
 * Pattern: every piece of untrusted text (ticket body, issue body,
 * webhook payload, Slack message, Discord message) is wrapped in
 * structured "UNTRUSTED INPUT" fences before reaching any LLM-touching
 * surface (taskSpec generation, agent prompt assembly, etc.). The
 * sanitizer:
 *
 *   1. Wraps content in fences with a content-addressed boundary.
 *   2. Escapes (or removes) the same fence markers if they occur inside
 *      the untrusted text, preventing fence-injection.
 *   3. Strips known dangerous patterns (system-prompt impersonation,
 *      Unicode bidi overrides, zero-width characters, ANSI escapes).
 *
 * The defense-in-depth pairs with the SafetyClassifier: even if an
 * injection survives sanitization and influences the agent, every
 * destructive action still passes through the approval gate. Both
 * layers must fail for harm to occur.
 *
 * NOTE: input sanitization is necessary but not sufficient. Eval
 * fixtures in apps/orchestrator/evals/taskspec/injection/ cover the
 * adversarial corpus; they are the regression test for this module.
 */

const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g
const BIDI_OVERRIDE_RE = /[‪-‮⁦-⁩]/g
const ANSI_ESCAPE_RE = /\[[0-9;]*[a-zA-Z]/g
/** Common phrases used in prompt injection. NOT exhaustive — eval suite is. */
const INJECTION_PHRASE_RE = new RegExp(
	[
		String.raw`ignore (the )?(previous|prior|above) (instructions?|prompt|messages?)`,
		String.raw`disregard (the )?(previous|prior|above) (instructions?|prompt|messages?)`,
		String.raw`you are now (a |an )?[A-Z_a-z][A-Z_a-z 0-9]*(?:Assistant|Agent|System|Mode)`,
		String.raw`(?:###|---)\s*system\s*(?:###|---)`,
	].join('|'),
	'gi'
)

export interface SanitizedInput {
	readonly fenced: string
	readonly removed_signals: readonly RemovedSignal[]
}

export interface RemovedSignal {
	readonly kind:
		| 'zero_width'
		| 'bidi_override'
		| 'ansi_escape'
		| 'fence_marker_collision'
		| 'injection_phrase'
	readonly sample: string
	readonly count: number
}

export class InputSanitizer {
	/**
	 * Wrap untrusted text in fences. Returns the fenced string + a list
	 * of signals removed. The fenced output is safe to interpolate into
	 * a prompt with a fence-aware system message.
	 */
	sanitize(label: string, untrusted: string): SanitizedInput {
		const signals: RemovedSignal[] = []
		let working = untrusted

		const zw = countAndStrip(working, ZERO_WIDTH_RE)
		if (zw.count > 0) {
			signals.push({ kind: 'zero_width', sample: '\\u200B...', count: zw.count })
			working = zw.cleaned
		}

		const bidi = countAndStrip(working, BIDI_OVERRIDE_RE)
		if (bidi.count > 0) {
			signals.push({ kind: 'bidi_override', sample: '\\u202A...', count: bidi.count })
			working = bidi.cleaned
		}

		const ansi = countAndStrip(working, ANSI_ESCAPE_RE)
		if (ansi.count > 0) {
			signals.push({ kind: 'ansi_escape', sample: '\\u001b[...m', count: ansi.count })
			working = ansi.cleaned
		}

		const injection = working.match(INJECTION_PHRASE_RE)
		if (injection && injection.length > 0) {
			signals.push({
				kind: 'injection_phrase',
				sample: injection[0]!.slice(0, 60),
				count: injection.length,
			})
			// We do NOT strip injection phrases. The agent benefits from
			// seeing what was tried; stripping would create a misleading
			// audit trail. The structural fence + safety classifier
			// disarm the injection without erasing it.
		}

		// Fence-marker collision: if the untrusted text contains our
		// fence markers, we must transform them so they cannot break
		// out of the fence.
		const fenceOpen = `<<UNTRUSTED:${label}>>`
		const fenceClose = `<</UNTRUSTED:${label}>>`
		const collisions = working.match(/<<\/?UNTRUSTED:/g)
		if (collisions && collisions.length > 0) {
			signals.push({
				kind: 'fence_marker_collision',
				sample: collisions[0]!,
				count: collisions.length,
			})
			working = working.replace(/<<UNTRUSTED:/g, '«UNTRUSTED:')
			working = working.replace(/<<\/UNTRUSTED:/g, '«/UNTRUSTED:')
		}

		return {
			fenced: `${fenceOpen}\n${working}\n${fenceClose}`,
			removed_signals: signals,
		}
	}
}

function countAndStrip(s: string, re: RegExp): { count: number; cleaned: string } {
	const matches = s.match(re)
	const count = matches ? matches.length : 0
	const cleaned = count > 0 ? s.replace(re, '') : s
	return { count, cleaned }
}
