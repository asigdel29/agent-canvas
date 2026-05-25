/**
 * Starter agents — pre-canned `NewAgentDraft` templates the user
 * can clone with one click from the empty state.
 *
 * Each starter is a full draft including system prompt and
 * capability config. Cloning a starter just opens the
 * NewAgentModal pre-filled; the user can edit any field before
 * hitting Create, so the starters are suggestions, not commits.
 *
 * The list is intentionally short. Three is enough to cover the
 * three classes of work the canvas supports (browser, MCP, and
 * computer-use) without overwhelming the empty state. Longer
 * lists become a marketplace problem and a discovery problem;
 * keep that for later.
 */

import type { NewAgentDraft } from './NewAgentModal.js'
import { defaultCapabilities } from './capabilities.js'

export interface Starter {
	readonly id: string
	readonly label: string
	readonly tagline: string
	/** Emoji shown on the tile. Single character, present-tense feel. */
	readonly icon: string
	readonly draft: NewAgentDraft
}

export const STARTERS: readonly Starter[] = [
	{
		id: 'web-research',
		label: 'Web researcher',
		tagline: 'Browses public sites and summarizes.',
		icon: '🔎',
		draft: {
			name: 'web-research',
			purpose: 'Search the web and summarize',
			model: 'claude-sonnet-4-6',
			system_prompt:
				'You research questions on the open web using the browser tools. ' +
				'Prefer authoritative sources. When you cite a fact, include the URL ' +
				'and a one-line quote. Summarize concisely; do not pad. If a question ' +
				'is ambiguous, ask one clarifying question before browsing.',
			capabilities: {
				...defaultCapabilities(),
				browser_use: { enabled: true, persist_cookies: false },
			},
		},
	},
	{
		id: 'computer-tasks',
		label: 'Desktop operator',
		tagline: 'Drives a sandboxed Linux desktop with vision.',
		icon: '🖥',
		draft: {
			name: 'desktop-operator',
			purpose: 'Operate a sandboxed Linux desktop',
			model: 'claude-sonnet-4-6',
			system_prompt:
				'You operate a sandboxed Linux desktop via the computer tool. ' +
				'Take a screenshot first, then plan one step at a time. After each ' +
				'action take another screenshot to verify the result. Move slowly ' +
				'and announce what you are about to do before each click.',
			capabilities: {
				...defaultCapabilities(),
				computer_use: { enabled: true, provider: 'e2b' },
			},
		},
	},
	{
		id: 'mcp-template',
		label: 'MCP toolsmith',
		tagline: 'Connect your own MCP server. Browser stays optional.',
		icon: '🔌',
		draft: {
			name: 'mcp-agent',
			purpose: 'Use my MCP server to do work',
			model: 'claude-sonnet-4-6',
			system_prompt:
				'You use the tools exposed by the configured MCP servers. ' +
				'Read each tool description before calling it. When a tool fails, ' +
				'try a different approach instead of repeating the same call. ' +
				'Stop and ask the operator if you are about to do something irreversible.',
			capabilities: {
				...defaultCapabilities(),
				// MCP servers slot is empty — the user fills it in the modal.
			},
		},
	},
] as const
