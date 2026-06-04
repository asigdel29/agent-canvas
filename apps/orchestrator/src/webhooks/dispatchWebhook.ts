/**
 * dispatchWebhook — fan out an event to every matched subscriber.
 *
 * Call site:
 *
 *   await dispatchWebhook(deps, {
 *     workspace_id,
 *     event_type: 'token.minted',
 *     event_id: audit_row.id,
 *     payload: { token_id, prefix, scope },
 *   })
 *
 * The function resolves the live subscribers via the endpoint
 * store, JSON-encodes the canonical body once, and enqueues one
 * row per (subscriber, event) into the delivery store. The actual
 * HTTP POST happens later when `drainOnce` runs.
 *
 * The body is JSON.stringify'd here, not at delivery time, because
 * the HMAC must be over the exact bytes we send and we lock those
 * bytes into the queue row.
 * @author asigdel29
 */

import type {
	WebhookEndpointStore,
} from './webhookEndpointStore.js'
import type { WebhookDeliveryStore } from './webhookDeliveryStore.js'
import type { WorkspaceId } from '../tenancy/tenancyTypes.js'

export interface DispatchDeps {
	readonly endpointStore: WebhookEndpointStore
	readonly deliveryStore: WebhookDeliveryStore
}

export interface DispatchInput {
	readonly workspace_id: WorkspaceId
	readonly event_type: string
	readonly event_id: string
	readonly payload: Record<string, unknown>
}

export interface CanonicalEventEnvelope {
	readonly id: string
	readonly type: string
	readonly created_at: string
	readonly data: Record<string, unknown>
}

/** Build the envelope we POST to subscribers. Stable shape across event types. */
export function buildEnvelope(input: DispatchInput): CanonicalEventEnvelope {
	return {
		id: input.event_id,
		type: input.event_type,
		created_at: new Date().toISOString(),
		data: input.payload,
	}
}

export async function dispatchWebhook(
	deps: DispatchDeps,
	input: DispatchInput
): Promise<{ enqueued: number }> {
	const subs = await deps.endpointStore.matchSubscribers(
		input.workspace_id,
		input.event_type
	)
	if (subs.length === 0) return { enqueued: 0 }
	const body = JSON.stringify(buildEnvelope(input))
	let count = 0
	for (const sub of subs) {
		await deps.deliveryStore.enqueue({
			endpoint_id: sub.record.id,
			event_id: input.event_id,
			event_type: input.event_type,
			body,
		})
		count += 1
	}
	return { enqueued: count }
}
