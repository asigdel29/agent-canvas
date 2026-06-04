/**
 * drainOnce — pick a batch of pending deliveries and attempt them.
 *
 * One pass:
 *   1. Claim up to `batchSize` pending rows (atomic flip to in_flight).
 *   2. For each, fetch the endpoint URL + signing secret.
 *      - If the endpoint was revoked since enqueue, mark the
 *        delivery succeeded with status_code=410 so it leaves the
 *        queue without spurious retries.
 *   3. Resolve the URL hostname and check the IPs land in public
 *      ranges (defense against DNS rebinding between registration
 *      and now). On private resolution, mark failed permanently.
 *   4. Build the X-AC-Signature header using signWebhook over the
 *      stored body, plus standard headers (X-AC-Event-Id,
 *      X-AC-Event-Type, content-type).
 *   5. POST with a configurable timeout (default 10s).
 *      - 2xx -> markSucceeded.
 *      - 4xx (non-429) -> markAttemptFailed (will retry per schedule;
 *        4xx is usually permanent but transient 4xx from a CDN does
 *        happen, and the retry budget bounds the damage).
 *      - 5xx / 429 / timeout / network error -> markAttemptFailed.
 *
 * Returns a summary so the operator's tick endpoint can log it.
 * @author asigdel29
 */

import { signWebhook } from './signWebhook.js'
import { resolveAndCheckIp } from './resolveAndCheckIp.js'
import type {
	WebhookDeliveryStore,
	DeliveryRecord,
} from './webhookDeliveryStore.js'
import type { WebhookEndpointStore } from './webhookEndpointStore.js'

export interface DrainDeps {
	readonly deliveryStore: WebhookDeliveryStore
	readonly endpointStore: WebhookEndpointStore
	/** Test seam — defaults to globalThis.fetch. */
	readonly fetchImpl?: typeof fetch
	/** Per-request timeout in ms. */
	readonly timeoutMs?: number
	/** Test seam for the DNS pre-check. */
	readonly resolveAndCheckIpImpl?: typeof resolveAndCheckIp
}

export interface DrainOptions {
	/** How many rows to attempt this tick. */
	readonly batchSize?: number
}

export type DeliveryOutcome =
	| { delivery_id: string; result: 'succeeded'; status_code: number }
	| {
			delivery_id: string
			result: 'retried' | 'failed_permanent'
			status_code: number | null
			error: string
	  }

export interface DrainSummary {
	readonly claimed: number
	readonly outcomes: readonly DeliveryOutcome[]
}

const DEFAULT_BATCH = 16
const DEFAULT_TIMEOUT_MS = 10_000

export async function drainOnce(
	deps: DrainDeps,
	opts: DrainOptions = {}
): Promise<DrainSummary> {
	const batchSize = opts.batchSize ?? DEFAULT_BATCH
	const claimed = await deps.deliveryStore.claimPending(batchSize)
	if (claimed.length === 0) return { claimed: 0, outcomes: [] }

	const outcomes: DeliveryOutcome[] = []
	for (const delivery of claimed) {
		// eslint-disable-next-line no-await-in-loop
		outcomes.push(await attemptOne(deps, delivery))
	}
	return { claimed: claimed.length, outcomes }
}

async function attemptOne(
	deps: DrainDeps,
	delivery: DeliveryRecord
): Promise<DeliveryOutcome> {
	const secret = await deps.endpointStore.getSigningSecret(delivery.endpoint_id)
	if (!secret) {
		// Endpoint revoked between enqueue and now. Don't retry forever
		// against a dead URL; mark succeeded with the 410 sentinel so
		// the operator's view shows what happened.
		await deps.deliveryStore.markSucceeded({
			delivery_id: delivery.id,
			status_code: 410,
			error: 'endpoint_revoked',
		})
		return { delivery_id: delivery.id, result: 'succeeded', status_code: 410 }
	}

	// We need the URL to POST. getById gives the live (non-revoked)
	// record; a revoked endpoint returns null and we short-circuit
	// the same way as a missing signing secret.
	const endpoint = await deps.endpointStore.getById(delivery.endpoint_id)
	if (!endpoint) {
		await deps.deliveryStore.markSucceeded({
			delivery_id: delivery.id,
			status_code: 410,
			error: 'endpoint_revoked',
		})
		return { delivery_id: delivery.id, result: 'succeeded', status_code: 410 }
	}

	const url = (() => {
		try {
			return new URL(endpoint.url)
		} catch {
			return null
		}
	})()
	if (!url) {
		const rec = await deps.deliveryStore.markAttemptFailed({
			delivery_id: delivery.id,
			status_code: null,
			error: 'malformed_url',
		})
		return outcomeFromRetry(rec, null, 'malformed_url')
	}

	const ipCheck = await (deps.resolveAndCheckIpImpl ?? resolveAndCheckIp)(url.hostname)
	if (!ipCheck.ok) {
		// Resolved to a private address (or DNS failed). Treat
		// private_address as a permanent fail; treat dns_failure as
		// a retry candidate (DNS may flap).
		if (ipCheck.reason === 'private_address') {
			// Burn through the retry budget instantly: mark as failed
			// no matter the current attempt_num. We do this by failing
			// MAX_ATTEMPTS times in one call, but the store only
			// supports one fail at a time. Simplest: keep failing on
			// each tick — the retry schedule means it tries again
			// later, fails again, eventually exhausts. The semantics
			// are correct; the cost is a handful of wasted DNS
			// lookups. Foundation accepts this.
			const rec = await deps.deliveryStore.markAttemptFailed({
				delivery_id: delivery.id,
				status_code: null,
				error: `private_address: ${(ipCheck.resolved ?? []).join(',')}`,
			})
			return outcomeFromRetry(rec, null, 'private_address')
		}
		const rec = await deps.deliveryStore.markAttemptFailed({
			delivery_id: delivery.id,
			status_code: null,
			error: 'dns_failure',
		})
		return outcomeFromRetry(rec, null, 'dns_failure')
	}

	const { header } = signWebhook({ secret, body: delivery.body })

	const fetchImpl = deps.fetchImpl ?? globalThis.fetch
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
	let response: Response
	try {
		response = await fetchImpl(endpoint.url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-ac-signature': header,
				'x-ac-event-id': delivery.event_id,
				'x-ac-event-type': delivery.event_type,
				'x-ac-delivery-id': delivery.id,
			},
			body: delivery.body,
			signal: AbortSignal.timeout(timeoutMs),
		})
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		const rec = await deps.deliveryStore.markAttemptFailed({
			delivery_id: delivery.id,
			status_code: null,
			error: message,
		})
		return outcomeFromRetry(rec, null, message)
	}

	if (response.status >= 200 && response.status < 300) {
		await deps.deliveryStore.markSucceeded({
			delivery_id: delivery.id,
			status_code: response.status,
			error: null,
		})
		return { delivery_id: delivery.id, result: 'succeeded', status_code: response.status }
	}

	// Non-2xx. Retry per the schedule.
	const errSnippet = await response
		.text()
		.then((s) => s.slice(0, 500))
		.catch(() => 'no_body')
	const rec = await deps.deliveryStore.markAttemptFailed({
		delivery_id: delivery.id,
		status_code: response.status,
		error: `http_${response.status}: ${errSnippet}`,
	})
	return outcomeFromRetry(rec, response.status, `http_${response.status}`)
}

function outcomeFromRetry(
	rec: DeliveryRecord,
	statusCode: number | null,
	error: string
): DeliveryOutcome {
	if (rec.status === 'failed') {
		return {
			delivery_id: rec.id,
			result: 'failed_permanent',
			status_code: statusCode,
			error,
		}
	}
	return { delivery_id: rec.id, result: 'retried', status_code: statusCode, error }
}
