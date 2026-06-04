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
 * @author asigdel29
 */

import { getRuntime } from '../../../dist/index.js'
import type { ProviderId, VendorId } from '@agent-canvas/orchestrator-types'

interface WebhookRequest {
	readonly headers: Readonly<Record<string, string>>
	readonly body: string
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
	if (!valid) {
		// Record failed verifications. A burst of these is the canonical
		// signal of a rotated-but-not-redistributed secret OR an attacker
		// probing for unprotected endpoints. Best-effort: failures of the
		// audit write itself must NEVER mask the 401.
		try {
			const { auditLog } = getRuntime() as unknown as {
				auditLog?: import('../../dist/orchestration/auditLog.js').AuditLog
			}
			if (auditLog) {
				await auditLog.record({
					actor_user_id: 'anon_webhook' as never,
					room_id: 'system' as never,
					run_id: null,
					action: 'webhook_signature_failed',
					result: 'rejected',
					trace_id: req.headers.get('traceparent') ?? 'na',
					details: {
						provider,
						source_ip:
							firstHopIp(req.headers.get('x-forwarded-for')) ??
							sanitizeIp(req.headers.get('x-real-ip')) ??
							'unknown',
						user_agent: sanitizeHeader(req.headers.get('user-agent'), 256),
					},
				})
			}
		} catch {
			// swallow — the 401 below is the contract
		}
		return jsonError(401, 'invalid_signature')
	}

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

	// Connector trigger path: route through the workflow templates.
	const { triggerRouter } = getRuntime()
	const routed = await triggerRouter.route(provider as ProviderId, normalized)
	return new Response(
		JSON.stringify({
			accepted: routed.dispatched > 0,
			provider,
			event_type: normalized.event_type,
			idempotency_key: normalized.idempotency_key,
			matched_templates: routed.matched,
			dispatched: routed.dispatched,
			errors: routed.errors,
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

/**
 * Cap a request header to a sane length and strip ASCII control chars
 * (including ANSI escapes used to confuse operators reading logs).
 * Returns 'unknown' for null/undefined input.
 */
function sanitizeHeader(value: string | null | undefined, maxLen: number): string {
	if (!value) return 'unknown'
	const cleaned = value.replace(/[\x00-\x1f\x7f]/g, '')
	return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned
}

/** Validate something that should be an IP. Returns null on reject. */
function sanitizeIp(value: string | null | undefined): string | null {
	if (!value) return null
	const trimmed = value.trim()
	if (trimmed.length === 0 || trimmed.length > 45) return null // ipv6 max len
	// Permit only IP-safe chars; net.isIP would be stricter but this avoids
	// the import and the same shape rejects garbage.
	if (!/^[0-9a-fA-F:.]+$/.test(trimmed)) return null
	return trimmed
}

/** Take the first hop from X-Forwarded-For (closest to the client). */
function firstHopIp(xff: string | null | undefined): string | null {
	if (!xff) return null
	const first = xff.split(',')[0]?.trim()
	return sanitizeIp(first)
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
