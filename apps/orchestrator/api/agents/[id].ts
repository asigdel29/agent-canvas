/**
 * GET    /api/agents/:id   fetch one
 * PATCH  /api/agents/:id   partial update
 * DELETE /api/agents/:id   soft delete (archive)
 *
 * All require a session JWT AND membership in the agent's
 * workspace. Read needs viewer+, write needs member+.
 */

import { getRuntime } from '../../dist/index.js'
import { extractSession } from '../../dist/auth/session.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'
import {
	type AgentId,
	AgentNotFoundError,
	type UpdateAgentInput,
} from '../../dist/agents/agentRecord.js'
import { TenancyForbiddenError } from '../../dist/tenancy/tenancyTypes.js'
import type { UserId } from '@agent-canvas/orchestrator-types'

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight

	const secret = process.env['JWT_SECRET']
	if (!secret) return withCorsHeaders(req, jsonError(500, 'jwt_secret_not_configured'))
	const session = extractSession(req, secret)
	if (!session) return withCorsHeaders(req, jsonError(401, 'unauthorized'))

	const runtime = getRuntime() as unknown as {
		agentStore?: import('../../dist/agents/agentStore.js').AgentStore
		tenancyStore?: import('../../dist/tenancy/tenancyStore.js').TenancyStore
	}
	const store = runtime.agentStore
	const tenancy = runtime.tenancyStore
	if (!store || !tenancy) {
		return withCorsHeaders(req, jsonError(500, 'runtime_not_fully_initialized'))
	}

	const url = new URL(req.url)
	const segments = url.pathname.split('/').filter(Boolean)
	const id = segments[segments.length - 1] as AgentId | undefined
	if (!id) return withCorsHeaders(req, jsonError(404, 'missing_id'))

	// Fetch first so the membership check uses the agent's actual
	// workspace_id, not anything the request body claims.
	const record = await store.get(id)
	if (!record) return withCorsHeaders(req, jsonError(404, 'not_found'))

	const minRole = req.method === 'GET' ? 'viewer' : 'member'
	try {
		await tenancy.requireMembership(session.sub as UserId, record.workspace_id, minRole)
	} catch (err) {
		if (err instanceof TenancyForbiddenError) {
			return withCorsHeaders(req, jsonError(403, 'workspace_forbidden'))
		}
		throw err
	}

	if (req.method === 'GET') {
		return withCorsHeaders(
			req,
			new Response(JSON.stringify(record), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		)
	}

	if (req.method === 'PATCH') {
		let patch: UpdateAgentInput
		try {
			patch = (await req.json()) as UpdateAgentInput
		} catch {
			return withCorsHeaders(req, jsonError(400, 'malformed_json'))
		}
		try {
			const updated = await store.update(id, patch)
			return withCorsHeaders(
				req,
				new Response(JSON.stringify(updated), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				})
			)
		} catch (err) {
			if (err instanceof AgentNotFoundError) {
				return withCorsHeaders(req, jsonError(404, 'not_found'))
			}
			throw err
		}
	}

	if (req.method === 'DELETE') {
		try {
			await store.archive(id)
			return withCorsHeaders(req, new Response(null, { status: 204 }))
		} catch (err) {
			if (err instanceof AgentNotFoundError) {
				return withCorsHeaders(req, jsonError(404, 'not_found'))
			}
			throw err
		}
	}

	return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))
}

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
