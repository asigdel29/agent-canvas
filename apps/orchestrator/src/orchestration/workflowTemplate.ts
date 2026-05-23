/**
 * WorkflowTemplate — a parameterizable recipe for starting a run from a
 * connector trigger.
 *
 * The four-tile starter menu in the canvas surfaces a handful of common
 * templates ("Triage GitHub issues", "Deploy from Linear ticket"). At
 * runtime, a connector webhook (e.g. `linear.issue_created`) maps to
 * one or more templates; the TriggerRouter instantiates each into a
 * `start_request` command.
 *
 * Templates are PURE DATA — no closures, no captured state — so they
 * round-trip through Postgres/JSON cleanly.
 */

import type { ProviderId, RoomId, UserId } from '@agent-canvas/orchestrator-types'

export interface WorkflowTemplate {
	readonly id: string
	readonly name: string
	readonly description: string
	/** Optional connector triggers that auto-instantiate this template. */
	readonly auto_triggers: readonly TriggerMatch[]
	/** Tool ids the run needs; passed to RunCoordinator for vendor selection. */
	readonly required_tools: readonly string[]
	/**
	 * Pure goal template. `{{trigger.foo}}` placeholders interpolate
	 * fields from the incoming trigger event's payload at instantiation
	 * time. Leave empty for templates the user starts manually.
	 */
	readonly goal_template: string
	/** Which room a triggered run lands in. */
	readonly target_room: 'origin' | RoomId
	/** Optional cap on concurrent runs of this template per actor. */
	readonly concurrency_limit?: number
}

export interface TriggerMatch {
	readonly provider: ProviderId
	readonly event_type: string
	/**
	 * Optional payload predicate — only matches when every key in this
	 * object is present in the trigger payload with the matching value.
	 * Strings compare equality; numbers do too. Arrays match if the
	 * payload array contains all listed values.
	 */
	readonly payload_equals?: Readonly<Record<string, unknown>>
}

export interface WorkflowTemplateStore {
	get(id: string): Promise<WorkflowTemplate | null>
	list(): Promise<readonly WorkflowTemplate[]>
	/** Find templates whose `auto_triggers` match the given event. */
	matchTrigger(
		provider: ProviderId,
		event_type: string,
		payload: Readonly<Record<string, unknown>>
	): Promise<readonly WorkflowTemplate[]>
}

export class InMemoryWorkflowTemplateStore implements WorkflowTemplateStore {
	private readonly templates = new Map<string, WorkflowTemplate>()

	register(t: WorkflowTemplate): void {
		this.templates.set(t.id, t)
	}

	async get(id: string): Promise<WorkflowTemplate | null> {
		return this.templates.get(id) ?? null
	}

	async list(): Promise<readonly WorkflowTemplate[]> {
		return [...this.templates.values()]
	}

	async matchTrigger(
		provider: ProviderId,
		event_type: string,
		payload: Readonly<Record<string, unknown>>
	): Promise<readonly WorkflowTemplate[]> {
		const out: WorkflowTemplate[] = []
		for (const t of this.templates.values()) {
			for (const m of t.auto_triggers) {
				if (m.provider !== provider) continue
				if (m.event_type !== event_type) continue
				if (m.payload_equals && !payloadMatches(payload, m.payload_equals)) continue
				out.push(t)
				break
			}
		}
		return out
	}
}

function payloadMatches(
	actual: Readonly<Record<string, unknown>>,
	required: Readonly<Record<string, unknown>>
): boolean {
	for (const [k, expected] of Object.entries(required)) {
		const v = pickPath(actual, k)
		if (Array.isArray(expected)) {
			if (!Array.isArray(v)) return false
			for (const e of expected) if (!v.includes(e)) return false
			continue
		}
		if (v !== expected) return false
	}
	return true
}

function pickPath(obj: Readonly<Record<string, unknown>>, dottedPath: string): unknown {
	let cur: unknown = obj
	for (const part of dottedPath.split('.')) {
		if (cur === null || typeof cur !== 'object') return undefined
		cur = (cur as Record<string, unknown>)[part]
	}
	return cur
}

/**
 * Interpolate `{{trigger.path.to.field}}` placeholders in a template's
 * `goal_template`. Unresolved placeholders are left in place — the
 * user can still edit the goal in the canvas before hitting start.
 */
export function instantiateGoal(
	template: WorkflowTemplate,
	trigger_payload: Readonly<Record<string, unknown>>
): string {
	return template.goal_template.replace(/\{\{trigger\.([\w.]+)\}\}/g, (_match, path: string) => {
		const v = pickPath(trigger_payload, path)
		if (v === undefined || v === null) return `{{trigger.${path}}}`
		return String(v)
	})
}

export interface TemplateInstantiation {
	readonly template: WorkflowTemplate
	readonly goal: string
	readonly required_tools: readonly string[]
	readonly target_room: RoomId
	readonly actor_user_id: UserId
}
