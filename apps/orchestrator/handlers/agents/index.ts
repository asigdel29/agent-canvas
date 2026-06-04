/**
 * GET  /api/agents?workspace_id=...   list agents for the workspace
 * POST /api/agents                    create one
 *
 * Both require a session JWT. The list endpoint scopes by
 * workspace_id; the POST infers workspace_id from the body and
 * trusts the session's `sub` as the owner.
 *
 * Production note: there is no per-workspace membership check yet
 * (P1 work). Any authenticated user can hit any workspace. This is
 * acceptable for the current single-tenant deploy; the membership
 * gate lands with the users/workspaces tables.
 * @author asigdel29
 */

import { getRuntime } from '../../dist/index.js'
import { extractSession } from '../../dist/auth/session.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'
import {
	type CreateAgentInput,
	AgentValidationError,
	validateCreateInput,
	type WorkspaceId,
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

	if (req.method === 'GET') {
		const url = new URL(req.url)
		const workspace_id = url.searchParams.get('workspace_id') as WorkspaceId | null
		if (!workspace_id) {
			return withCorsHeaders(req, jsonError(400, 'missing_workspace_id'))
		}
		try {
			await tenancy.requireMembership(session.sub as UserId, workspace_id, 'viewer')
		} catch (err) {
			if (err instanceof TenancyForbiddenError) {
				return withCorsHeaders(req, jsonError(403, 'workspace_forbidden'))
			}
			throw err
		}
		const items = await store.listByWorkspace(workspace_id)
		return withCorsHeaders(
			req,
			new Response(JSON.stringify({ items }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		)
	}

	if (req.method === 'POST') {
		let body: CreateAgentInput
		try {
			body = (await req.json()) as CreateAgentInput
		} catch {
			return withCorsHeaders(req, jsonError(400, 'malformed_json'))
		}
		// Server-side trust: owner_user_id comes from the verified
		// session, never the request body. A client trying to spoof
		// owner_user_id is silently corrected.
		const input: CreateAgentInput = {
			...body,
			owner_user_id: session.sub,
		}
		// Workspace membership gate. Member or higher can create agents.
		// Body must carry workspace_id; the membership check ensures
		// the session user actually belongs to that workspace.
		try {
			await tenancy.requireMembership(session.sub as UserId, input.workspace_id, 'member')
		} catch (err) {
			if (err instanceof TenancyForbiddenError) {
				return withCorsHeaders(req, jsonError(403, 'workspace_forbidden'))
			}
			throw err
		}
		try {
			validateCreateInput(input)
		} catch (err) {
			if (err instanceof AgentValidationError) {
				return withCorsHeaders(
					req,
					jsonError(400, 'validation_failed', `${err.field}: ${err.message}`)
				)
			}
			throw err
		}
		const created = await store.create(input)
		return withCorsHeaders(
			req,
			new Response(JSON.stringify(created), {
				status: 201,
				headers: { 'content-type': 'application/json' },
			})
		)
	}

	return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))
}

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
