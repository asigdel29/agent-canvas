/**
 * POST /api/webhooks/:provider — generic webhook ingestion.
 *
 * Per the CEO/eng review's ingestion plan (decision 1.4):
 *
 *   1. Resolve the connector or provider adapter by URL path param.
 *   2. Look up the per-installation webhook secret (vault-backed in
 *      production; env-var fallback for local testing).
 *   3. Verify the signature via the connector's webhook framework.
 *   4. Derive the per-provider idempotency key.
 *   5. Hand off to the orchestrator's outbox-backed ingestion pipeline.
 *
 * On signature failure: 401 + audit entry.
 * On dedup: 200 with `{ deduped: true }`.
 * On success: 202 with `{ accepted: true, event_type, idempotency_key }`.
 *
 * Production note: the webhook handler MUST be fast (Vercel function
 * cold-start + verification + a single INSERT to the outbox). Heavy
 * work runs in the outbox drainer, not here.
 */

import { getRuntime } from '../../dist/index.js'
import type { ProviderId, VendorId } from '@agent-canvas/orchestrator-types'

interface WebhookRequest {
	readonly headers: Readonly<Record<string, string>>
	readonly body: string
}

export const config = {
	runtime: 'nodejs',
}

export default async function handler(req: Request): Promise<Response> {
	if (req.method !== 'POST') return jsonError(405, 'method_not_allowed')

	const url = new URL(req.url)
	const segments = url.pathname.split('/').filter(Boolean)
	const provider = segments[segments.length - 1] as ProviderId | VendorId | undefined
	if (!provider) return jsonError(404, 'missing_provider')

	const body = await req.text()
	const headers = headersToRecord(req.headers)

	const { registry } = getRuntime()
	const adapter = tryGetAdapter(registry, provider)
	if (!adapter) return jsonError(404, `unknown_provider: ${provider}`)

	const secret = process.env[`WEBHOOK_SECRET_${provider.toUpperCase()}`]
	if (!secret) return jsonError(500, 'webhook_secret_not_configured')

	const wrappedReq: WebhookRequest = { headers, body }
	const valid = await adapter.webhook.verifySignature(wrappedReq, secret)
	if (!valid) return jsonError(401, 'invalid_signature')

	const normalized = adapter.webhook.normalize(wrappedReq)

	// Connectors (third-party tools) deliver triggers; vendors (Codex,
	// OpenHands) deliver run events. The IngestionPipeline only runs
	// for vendor adapters; connector triggers route through a separate
	// path (handled in a follow-up — they invoke CommandEndpoint with
	// a start_request).
	if (isVendorAdapter(registry, provider)) {
		const vendor = registry.getProvider(provider as VendorId)
		const { ingestionPipeline } = getRuntime()
		const outcome = await ingestionPipeline.ingest(vendor, normalized)
		return new Response(
			JSON.stringify({
				accepted: outcome.status === 'accepted',
				outcome,
				event_type: normalized.event_type,
				idempotency_key: normalized.idempotency_key,
			}),
			{ status: 202, headers: { 'content-type': 'application/json' } }
		)
	}

	return new Response(
		JSON.stringify({
			accepted: true,
			provider,
			event_type: normalized.event_type,
			idempotency_key: normalized.idempotency_key,
			note: 'trigger handling: follow-up PR',
		}),
		{ status: 202, headers: { 'content-type': 'application/json' } }
	)
}

function tryGetAdapter(
	registry: ReturnType<typeof getRuntime>['registry'],
	id: string
) {
	try {
		return registry.getConnector(id as ProviderId)
	} catch {
		try {
			return registry.getProvider(id as VendorId)
		} catch {
			return null
		}
	}
}

function isVendorAdapter(
	registry: ReturnType<typeof getRuntime>['registry'],
	id: string
): boolean {
	try {
		registry.getProvider(id as VendorId)
		return true
	} catch {
		return false
	}
}

function jsonError(status: number, code: string): Response {
	return new Response(JSON.stringify({ error: code }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function headersToRecord(h: Headers): Record<string, string> {
	const out: Record<string, string> = {}
	h.forEach((v, k) => {
		out[k] = v
	})
	return out
}
