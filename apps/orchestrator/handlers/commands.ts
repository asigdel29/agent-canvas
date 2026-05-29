/**
 * POST /api/commands — accept a canvas-originated Command.
 *
 * The canvas client serializes a Command (Command type in
 * orchestrator-types) and POSTs JSON. The orchestrator runs it through
 * the CommandEndpoint: authz, billing gate, idempotency claim, event
 * log append, outbox enqueue, audit.
 *
 * Auth: per-request bearer token. The token resolves to a UserId via
 * the auth layer (separate concern; this handler trusts the resolver).
 *
 * Response: 200 with { seq, deduped, trace_id } on success.
 *          4xx with { error: 'rejection_reason' } on rejection.
 */

import { getRuntime } from '../dist/index.js'
import {
	CommandRejected,
} from '../dist/orchestration/commandEndpoint.js'
import { extractSession } from '../dist/auth/session.js'
import { preflightResponse, withCorsHeaders } from '../dist/http/cors.js'
import type { Command, UserId } from '@agent-canvas/orchestrator-types'

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight
	if (req.method !== 'POST') return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))

	const secret = process.env['JWT_SECRET']
	if (!secret) return withCorsHeaders(req, jsonError(500, 'jwt_secret_not_configured'))

	const session = extractSession(req, secret)
	if (!session) return withCorsHeaders(req, jsonError(401, 'unauthorized'))

	let rawCommand: Command
	try {
		const raw = await req.json()
		rawCommand = raw as Command
	} catch {
		return withCorsHeaders(req, jsonError(400, 'malformed_json'))
	}

	// Server-side trust: actor_user_id comes from the verified session,
	// never from the request body. A client trying to spoof
	// actor_user_id is silently corrected to their real session sub.
	const command: Command = { ...rawCommand, actor_user_id: session.sub as UserId }

	const traceparent = req.headers.get('traceparent') ?? undefined
	const { endpoint } = getRuntime()

	try {
		const result = await endpoint.accept(command, traceparent)
		return withCorsHeaders(
			req,
			new Response(JSON.stringify(result), {
				status: 200,
				headers: {
					'content-type': 'application/json',
					traceparent: result.trace_id,
				},
			})
		)
	} catch (err) {
		if (err instanceof CommandRejected) {
			return withCorsHeaders(
				req,
				jsonError(httpStatusForRejection(err.reason), err.reason, err.message)
			)
		}
		const msg = err instanceof Error ? err.message : 'internal_error'
		return withCorsHeaders(req, jsonError(500, 'internal_error', msg))
	}
}

function httpStatusForRejection(reason: CommandRejected['reason']): number {
	switch (reason) {
		case 'unauthorized':
			return 403
		case 'budget_exhausted':
		case 'no_budget_configured':
			return 402
		case 'stale_subscription_epoch':
		case 'invalid_action':
		case 'malformed_command':
		case 'idempotency_conflict':
			return 409
	}
}

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
