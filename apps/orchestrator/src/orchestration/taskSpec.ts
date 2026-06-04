/**
 * TaskSpec generation — the single LLM-touching surface owned by this
 * product. Converts a user goal (and optional untrusted ticket body)
 * into a structured spec handed to the managed agent vendor.
 *
 * Phase 1 ships a DETERMINISTIC rule-based generator. Phase 2 may
 * upgrade to a small LLM call; until then, the deterministic version
 * is the regression baseline that the eval suite locks in.
 *
 * Defense invariants (verified by the eval suite):
 *
 *   1. Untrusted text NEVER reaches `objective` or `required_tools`.
 *      All untrusted content is wrapped via InputSanitizer and stored
 *      ONLY in `untrusted_context`.
 *
 *   2. `required_tools` is derived ONLY from the trusted user goal,
 *      via keyword heuristics. The agent may invoke additional tools
 *      at runtime; those still pass through the safety classifier.
 *
 *   3. `destructive_actions` is empty at spec time. Destructive intent
 *      is identified at tool-call time by the SafetyClassifier, not
 *      hardcoded into the spec.
 * @author asigdel29
 */

import type { ProviderId } from '@agent-canvas/orchestrator-types'
import { InputSanitizer, type SanitizedInput } from './inputSanitizer.js'

export interface TaskSpec {
	readonly objective: string
	readonly required_tools: readonly string[]
	readonly destructive_actions: readonly string[]
	readonly untrusted_context: SanitizedInput | null
	readonly metadata: {
		readonly source: 'user_typed' | 'linear_webhook' | 'github_webhook' | 'slack_webhook'
		readonly actor_user_id: string
		readonly room_id: string
		readonly generated_at: string
	}
}

export interface GenerateInput {
	readonly goal: string
	readonly source: TaskSpec['metadata']['source']
	readonly actor_user_id: string
	readonly room_id: string
	readonly untrusted_ticket_body?: string
	readonly untrusted_label?: string
}

const PROVIDER_KEYWORDS: ReadonlyArray<[ProviderId | 'shell', readonly string[]]> = [
	['github', ['github', 'pr', 'pull request', 'repo', 'commit', 'branch', 'issue', 'merge']],
	['linear', ['linear', 'ticket', 'issue', 'project', 'triage', 'label']],
	['slack', ['slack', 'channel', 'message', '#eng', '#growth', 'post', 'thread', 'standup', 'digest']],
	['discord', ['discord', 'server', 'guild']],
	['graphite', ['graphite', 'stack', 'review', 'stacked pr']],
	['railway', ['railway', 'service']],
	['vercel', ['vercel', 'deploy', 'preview', 'production']],
	['supabase', ['supabase', 'database', 'sql', 'query', 'schema']],
	['shell', ['shell', 'run command', 'bash']],
]

// Provider → suggested tool ids. Heuristic only; the agent vendor can
// (and does) invoke other tools at runtime.
const PROVIDER_DEFAULT_TOOLS: ReadonlyMap<string, readonly string[]> = new Map([
	['github', ['github.create_pr', 'github.write_file', 'github.comment_issue']],
	['linear', ['linear.list_issues', 'linear.update_issue', 'linear.comment_issue']],
	['slack', ['slack.post_message', 'slack.list_messages']],
	['discord', ['discord.send_message', 'discord.list_messages']],
	['graphite', ['graphite.submit_stack', 'graphite.submit_review']],
	['railway', ['railway.list_deployments', 'railway.get_logs']],
	['vercel', ['vercel.get_logs', 'vercel.deploy_preview']],
	['supabase', ['supabase.get_schema', 'supabase.run_query']],
	['shell', ['shell.run']],
])

const sanitizer = new InputSanitizer()

export function generateTaskSpec(input: GenerateInput): TaskSpec {
	const goal = input.goal.trim()
	const tools = inferTools(goal)
	const untrusted = input.untrusted_ticket_body
		? sanitizer.sanitize(input.untrusted_label ?? 'ticket_body', input.untrusted_ticket_body)
		: null
	return {
		objective: goal,
		required_tools: tools,
		destructive_actions: [], // intentionally empty; safety classifier decides at tool-call time
		untrusted_context: untrusted,
		metadata: {
			source: input.source,
			actor_user_id: input.actor_user_id,
			room_id: input.room_id,
			generated_at: new Date().toISOString(),
		},
	}
}

function inferTools(goal: string): readonly string[] {
	const lower = goal.toLowerCase()
	const matched = new Set<string>()
	for (const [provider, keywords] of PROVIDER_KEYWORDS) {
		for (const kw of keywords) {
			if (lower.includes(kw)) {
				matched.add(provider)
				break
			}
		}
	}
	const tools: string[] = []
	for (const provider of matched) {
		const list = PROVIDER_DEFAULT_TOOLS.get(provider) ?? []
		for (const t of list) tools.push(t)
	}
	return tools
}
