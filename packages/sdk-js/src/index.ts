/**
 * @agent-canvas/sdk — TypeScript client for the orchestrator REST API.
 *
 * Public surface, kept narrow on purpose:
 *
 *   AgentCanvasClient    Bearer-authenticated client over the REST API.
 *                        One method per public route.
 *
 *   verifyWebhook        HMAC-SHA256 + timestamp-tolerance check for an
 *                        inbound webhook delivery. Same primitive the
 *                        orchestrator uses on egress; running it on the
 *                        receiver guarantees the contract holds.
 *
 *   ApiError             Thrown by every client method when the API
 *                        returns a non-2xx. Carries status + code +
 *                        detail so the caller can branch without
 *                        re-parsing the response body.
 *
 * Type re-exports are intentionally lean — only what the client
 * methods take as input or return. Internal orchestrator types stay
 * internal.
 */

export {
	AgentCanvasClient,
	ApiError,
	type AgentCanvasClientOptions,
} from './client.js'
export {
	verifyWebhook,
	type VerifyWebhookArgs,
	type VerifyWebhookResult,
	SIGNATURE_HEADER,
	DEFAULT_TOLERANCE_SEC,
} from './verifyWebhook.js'
export type {
	ApiTokenScope,
	ApiTokenSummary,
	IssuedToken,
	WebhookEndpointSummary,
	IssuedWebhookEndpoint,
	AuditEvent,
	RunStartInput,
	RunStartResult,
} from './types.js'
