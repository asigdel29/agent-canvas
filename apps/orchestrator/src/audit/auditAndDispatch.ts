/**
 * auditAndDispatch — one-call helper for "append an audit row AND
 * fan it out to webhook subscribers".
 *
 * Every workspace-affecting mutation (token mint, token revoke,
 * webhook create / revoke, member add / role change / remove,
 * workspace create) needs both:
 *
 *   1. An audit-log row so workspace admins can inspect the action.
 *   2. A webhook dispatch so customer systems can react.
 *
 * Doing both inline from the route doubled the call-site noise and
 * made it easy to forget the dispatch. This wraps them in one
 * function with a single deps bundle.
 *
 * Fire-and-forget posture: the route should `void` the returned
 * promise and continue. Errors are swallowed; neither write blocks
 * the user's response. The audit row's id is reused as the webhook
 * event_id so a downstream consumer can correlate them.
 * @author asigdel29
 */

import { dispatchWebhook } from '../webhooks/dispatchWebhook.js'
import type { WebhookDeliveryStore } from '../webhooks/webhookDeliveryStore.js'
import type { WebhookEndpointStore } from '../webhooks/webhookEndpointStore.js'
import type {
	WorkspaceAuditStore,
	AppendInput,
} from './workspaceAuditStore.js'

export interface AuditAndDispatchDeps {
	readonly audit: WorkspaceAuditStore
	readonly endpointStore: WebhookEndpointStore
	readonly deliveryStore: WebhookDeliveryStore
}

export interface AuditAndDispatchInput extends AppendInput {
	/**
	 * Payload sent to webhook subscribers. When omitted, the audit
	 * `details` object is used verbatim. Use the explicit field when
	 * the public webhook shape differs from what gets stored in the
	 * audit trail (e.g. richer object shapes for receivers).
	 */
	readonly webhookPayload?: Record<string, unknown>
}

/**
 * Append the audit row and enqueue deliveries to matched subscribers.
 * Both writes are best-effort; errors are logged at the store level
 * (logger.error from the store impl) and otherwise swallowed.
 *
 * Returns the audit row's id when the audit write succeeded, or null
 * when it threw. The webhook dispatch uses the id for correlation;
 * if the audit failed, dispatch uses a synthetic id so receivers
 * still get the event.
 */
export async function auditAndDispatch(
	deps: AuditAndDispatchDeps,
	input: AuditAndDispatchInput
): Promise<string | null> {
	let eventId: string | null = null
	try {
		const row = await deps.audit.append(input)
		eventId = row.id
	} catch {
		// Audit-write failure must not block the route response or
		// suppress the webhook. Fall through to dispatch with a
		// synthetic id.
	}
	const effectiveId = eventId ?? `evt_local_${Date.now()}_${input.action}`
	const payload = input.webhookPayload ?? input.details ?? {}
	try {
		await dispatchWebhook(
			{
				endpointStore: deps.endpointStore,
				deliveryStore: deps.deliveryStore,
			},
			{
				workspace_id: input.workspace_id,
				event_type: input.action,
				event_id: effectiveId,
				payload,
			}
		)
	} catch {
		// Dispatch failure cannot revert the audit write. Best effort.
	}
	return eventId
}
