/**
 * POST /api/feedback — accept a free-text feedback note from the
 * canvas operator with an optional attached event tail.
 *
 * The route is intentionally minimal. The point is to lower the
 * activation energy for a user to say 'this broke' — a single
 * textarea + submit, no triage form. Storage is the existing
 * audit_log table with a fixed action name. Operators reading
 * the audit log can filter on that name to triage.
 *
 * The session sub is recorded as actor_user_id so we know who
 * sent which note without a user ever logging in twice.
 *
 * Required:    body.message (non-empty)
 * Optional:    body.recent_events (array of RunEvent-like blobs)
 *              body.agent_id, body.run_id (context hints)
 *              body.url (the canvas URL the user was on)
 *
 * No rate limit yet — the BillingGate doesn't apply, and the
 * audit_log table can absorb thousands of rows. Revisit if abuse
 * shows up.
 * @author asigdel29
 */

import { getRuntime } from '../dist/index.js'
import { extractSession } from '../dist/auth/session.js'
import { preflightResponse, withCorsHeaders } from '../dist/http/cors.js'

const MAX_MESSAGE = 4000
const MAX_EVENTS = 20

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight
	if (req.method !== 'POST') {
		return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))
	}

	const secret = process.env['JWT_SECRET']
	if (!secret) return withCorsHeaders(req, jsonError(500, 'jwt_secret_not_configured'))
	const session = extractSession(req, secret)
	if (!session) return withCorsHeaders(req, jsonError(401, 'unauthorized'))

	let body: {
		message?: string
		recent_events?: Array<Record<string, unknown>>
		agent_id?: string
		run_id?: string
		url?: string
	}
	try {
		body = (await req.json()) as typeof body
	} catch {
		return withCorsHeaders(req, jsonError(400, 'malformed_json'))
	}

	const message = (body.message ?? '').trim()
	if (!message) return withCorsHeaders(req, jsonError(400, 'missing_message'))
	if (message.length > MAX_MESSAGE) {
		return withCorsHeaders(
			req,
			jsonError(400, 'message_too_long', `max ${MAX_MESSAGE} chars`)
		)
	}

	const recent = Array.isArray(body.recent_events)
		? body.recent_events.slice(-MAX_EVENTS)
		: []

	const runtime = getRuntime() as unknown as {
		auditLog?: import('../dist/orchestration/auditLog.js').AuditLog
	}
	const auditLog = runtime.auditLog
	if (!auditLog) {
		return withCorsHeaders(req, jsonError(500, 'audit_log_not_initialized'))
	}

	const traceparent = req.headers.get('traceparent') ?? 'na'
	try {
		await auditLog.record({
			actor_user_id: session.sub,
			room_id: 'system' as never,
			run_id: (body.run_id ?? null) as never,
			action: 'operator_feedback',
			result: 'rejected', // 'rejected'|'pending'|'succeeded' — feedback isn't a command, mark it pending-style
			trace_id: traceparent,
			details: {
				message,
				agent_id: body.agent_id ?? null,
				url: body.url ?? null,
				recent_events: recent,
				user_agent: req.headers.get('user-agent') ?? 'unknown',
			} as never,
		})
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		return withCorsHeaders(
			req,
			jsonError(500, 'audit_write_failed', msg.slice(0, 320))
		)
	}

	return withCorsHeaders(
		req,
		new Response(JSON.stringify({ recorded: true }), {
			status: 202,
			headers: { 'content-type': 'application/json' },
		})
	)
}

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
