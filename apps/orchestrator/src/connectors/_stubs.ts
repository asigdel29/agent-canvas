/**
 * Shared stubs and helpers for connector adapter skeletons.
 *
 * Real provider integration (OAuth client_id/secret, webhook secret,
 * actual API calls) lands in per-adapter follow-up PRs. The skeletons
 * declare the right Connector / ProviderAdapter shape — tool inventory,
 * safety classification, idempotency-key derivation — so the conformance
 * suite and the safety classifier are wired correctly from day one.
 */

import type {
	NormalizedWebhookEvent,
	OAuthFramework,
	WebhookFramework,
	WebhookRequest,
} from '@agent-canvas/connector-core'
import type { ProviderId, VendorId } from '@agent-canvas/orchestrator-types'

export class NotImplementedError extends Error {
	constructor(what: string) {
		super(`adapter stub: ${what} not implemented`)
		this.name = 'NotImplementedError'
	}
}

/** Throwing OAuth stub. Real adapters override `authorize`/`callback`/`refresh`/`revoke`. */
export const stubOAuth: OAuthFramework = {
	async authorize() {
		throw new NotImplementedError('oauth.authorize')
	},
	async callback() {
		throw new NotImplementedError('oauth.callback')
	},
	async refresh() {
		throw new NotImplementedError('oauth.refresh')
	},
	async revoke() {
		throw new NotImplementedError('oauth.revoke')
	},
}

export interface BuildWebhookOptions {
	readonly provider: ProviderId | VendorId
	readonly idempotencyKey: (req: WebhookRequest) => string
	readonly verifySignature: (req: WebhookRequest, secret: string) => Promise<boolean>
	readonly parseEventType?: (req: WebhookRequest) => string
}

/** Build a WebhookFramework around per-provider derivation. */
export function buildWebhook(opts: BuildWebhookOptions): WebhookFramework {
	return {
		verifySignature: opts.verifySignature,
		idempotencyKey: opts.idempotencyKey,
		normalize(req: WebhookRequest): NormalizedWebhookEvent {
			let payload: Record<string, unknown> = {}
			try {
				payload = JSON.parse(req.body) as Record<string, unknown>
			} catch {
				// non-JSON webhook (e.g., Slack url-verification challenges)
				payload = { raw: req.body }
			}
			const event_type = opts.parseEventType?.(req) ?? guessEventType(req, payload)
			return {
				provider: opts.provider,
				event_type,
				idempotency_key: opts.idempotencyKey(req),
				received_at: new Date().toISOString(),
				payload,
			}
		},
	}
}

function guessEventType(req: WebhookRequest, payload: Record<string, unknown>): string {
	// Conventional: header `X-{Provider}-Event` (GitHub, Linear, etc.)
	for (const k of Object.keys(req.headers)) {
		if (k.toLowerCase().endsWith('-event')) return req.headers[k]!
	}
	if (typeof payload['type'] === 'string') return payload['type']
	if (typeof payload['event'] === 'string') return payload['event']
	return 'unknown'
}

/**
 * Stub signature verifier that ALWAYS returns false — adapters override
 * with a real HMAC check. Default-deny is the safe default.
 */
export async function alwaysDenyVerify(): Promise<boolean> {
	return false
}
