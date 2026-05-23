/**
 * TriggerRouter — connector trigger → start_request commands.
 *
 * Connector webhooks (Linear issue created, GitHub PR opened, Slack
 * mention) flow through this router. For each matching workflow
 * template, the router builds a Command and dispatches it to the
 * CommandEndpoint. Failures on one template do not block the others.
 *
 * Auth: triggers run with the room owner's authority. The room's
 * owner_user_id and run-agents capability are consulted by
 * CommandEndpoint as usual.
 */

import type { NormalizedWebhookEvent } from '@agent-canvas/connector-core'
import type {
	Command,
	ProviderId,
	RoomId,
	RunId,
	UserId,
} from '@agent-canvas/orchestrator-types'
import type { CommandEndpoint } from './commandEndpoint.js'
import {
	instantiateGoal,
	type WorkflowTemplateStore,
} from './workflowTemplate.js'

export interface TriggerRouterDeps {
	readonly templates: WorkflowTemplateStore
	readonly endpoint: CommandEndpoint
	readonly resolveRoomForTrigger: (
		provider: ProviderId,
		event: NormalizedWebhookEvent
	) => Promise<TriggerRoom | null>
}

export interface TriggerRoom {
	readonly room_id: RoomId
	readonly owner_user_id: UserId
}

export interface RouteResult {
	readonly matched: number
	readonly dispatched: number
	readonly errors: readonly { template_id: string; reason: string }[]
}

export class TriggerRouter {
	constructor(private readonly deps: TriggerRouterDeps) {}

	async route(
		provider: ProviderId,
		event: NormalizedWebhookEvent
	): Promise<RouteResult> {
		const room = await this.deps.resolveRoomForTrigger(provider, event)
		if (!room) {
			return { matched: 0, dispatched: 0, errors: [] }
		}

		const templates = await this.deps.templates.matchTrigger(
			provider,
			event.event_type,
			event.payload
		)

		const errors: { template_id: string; reason: string }[] = []
		let dispatched = 0
		for (const template of templates) {
			try {
				const goal = instantiateGoal(template, event.payload)
				const command: Command = {
					kind: 'start_request',
					run_id: synthesizeRunId(template.id, event.idempotency_key),
					room_id: room.room_id,
					actor_user_id: room.owner_user_id,
					idempotency_key: `trigger_${template.id}_${event.idempotency_key}`,
					payload: {
						taskSpec: {
							objective: goal,
							required_tools: template.required_tools,
						},
						trigger: {
							provider,
							event_type: event.event_type,
							template_id: template.id,
						},
					},
					ts: new Date().toISOString(),
				}
				await this.deps.endpoint.accept(command)
				dispatched += 1
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err)
				errors.push({ template_id: template.id, reason })
			}
		}
		return { matched: templates.length, dispatched, errors }
	}
}

/**
 * Deterministic run_id derived from the template + the trigger's
 * idempotency key. A redelivered trigger maps to the same run_id, so
 * CommandEndpoint's idempotency_key dedup catches the duplicate.
 */
function synthesizeRunId(template_id: string, idempotency_key: string): RunId {
	let h = 0
	const seed = `${template_id}::${idempotency_key}`
	for (let i = 0; i < seed.length; i += 1) {
		h = (h * 31 + seed.charCodeAt(i)) | 0
	}
	return `run_${(h >>> 0).toString(36)}` as RunId
}
