/**
 * GET    /api/workspaces/:id/members        list members (admin+)
 * POST   /api/workspaces/:id/members        invite by github login (admin+)
 * PATCH  /api/workspaces/:id/members/:uid   change role (admin+)
 * DELETE /api/workspaces/:id/members/:uid   remove (admin+)
 *
 * All routes session-only. API tokens cannot manage memberships —
 * a leaked machine token must not grant the ability to add itself
 * (or anyone) to other workspaces.
 *
 * Invite shape:
 *   POST body { github_login, role }
 *   - We resolve github_login → user_id via tenancy.findUserByGithubLogin.
 *   - If the invitee has never signed in, we return 404
 *     'user_not_found'; the caller asks them to sign in first.
 *     (We never pre-create user rows from a free-text github
 *     handle; only the OAuth callback creates users so claims
 *     stay verifiable.)
 *
 * Role-change rules:
 *   - The actor must outrank the target's CURRENT role. Otherwise
 *     a member-admin could demote an owner.
 *   - The actor must outrank the new role. Otherwise an admin
 *     could promote someone to owner past themselves.
 *   - The store refuses to demote / remove the last owner.
 */

import { getRuntime } from '../../dist/index.js'
import { extractSession } from '../../dist/auth/session.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'
import { auditAndDispatch } from '../../dist/audit/auditAndDispatch.js'
import type { UserId } from '@agent-canvas/orchestrator-types'
import {
	ROLE_RANK,
	type WorkspaceId,
	type WorkspaceRole,
} from '../../dist/tenancy/tenancyTypes.js'

const VALID_ROLES = ['owner', 'admin', 'member', 'viewer'] as const

function parsePath(pathname: string): { workspace_id: string; user_id?: string } | null {
	// /api/workspaces/<wid>/members           list/add
	// /api/workspaces/<wid>/members/<uid>     change/remove
	const m = pathname.match(/^\/api\/workspaces\/([^/]+)\/members(?:\/([^/]+))?\/?$/)
	if (!m) return null
	const result: { workspace_id: string; user_id?: string } = {
		workspace_id: m[1]!,
	}
	if (m[2] !== undefined) {
		result.user_id = m[2]
	}
	return result
}

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight

	const secret = process.env['JWT_SECRET']
	if (!secret) return withCorsHeaders(req, jsonError(500, 'jwt_secret_not_configured'))
	const session = extractSession(req, secret)
	if (!session) return withCorsHeaders(req, jsonError(401, 'unauthorized'))

	const runtime = getRuntime() as unknown as {
		tenancyStore?: import('../../dist/tenancy/tenancyStore.js').TenancyStore
		workspaceAuditStore?: import('../../dist/audit/workspaceAuditStore.js').WorkspaceAuditStore
		webhookEndpointStore?: import('../../dist/webhooks/webhookEndpointStore.js').WebhookEndpointStore
		webhookDeliveryStore?: import('../../dist/webhooks/webhookDeliveryStore.js').WebhookDeliveryStore
	}
	const tenancy = runtime.tenancyStore
	const audit = runtime.workspaceAuditStore
	const endpointStore = runtime.webhookEndpointStore
	const deliveryStore = runtime.webhookDeliveryStore
	if (!tenancy || !audit || !endpointStore || !deliveryStore) {
		return withCorsHeaders(req, jsonError(500, 'runtime_not_fully_initialized'))
	}

	const url = new URL(req.url)
	const parsed = parsePath(url.pathname)
	if (!parsed) return withCorsHeaders(req, jsonError(404, 'unknown_route'))
	const workspace_id = parsed.workspace_id as WorkspaceId
	const target_user_id = parsed.user_id as UserId | undefined

	const actor = session.sub as UserId
	// Every method requires admin+ on the workspace.
	let actorMembership
	try {
		actorMembership = await tenancy.requireMembership(actor, workspace_id, 'admin')
	} catch (err) {
		if (err instanceof Error && err.name === 'TenancyForbiddenError') {
			return withCorsHeaders(req, jsonError(403, 'workspace_forbidden'))
		}
		throw err
	}

	if (req.method === 'GET' && !target_user_id) {
		const items = await tenancy.listMembers(workspace_id)
		return withCorsHeaders(
			req,
			new Response(JSON.stringify({ items }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		)
	}

	if (req.method === 'POST' && !target_user_id) {
		let body: { github_login?: string; role?: string }
		try {
			body = (await req.json()) as typeof body
		} catch {
			return withCorsHeaders(req, jsonError(400, 'malformed_json'))
		}
		const login = (body.github_login ?? '').trim()
		if (!login) return withCorsHeaders(req, jsonError(400, 'missing_github_login'))
		const role = body.role as WorkspaceRole | undefined
		if (!role || !(VALID_ROLES as readonly string[]).includes(role)) {
			return withCorsHeaders(req, jsonError(400, 'invalid_role'))
		}
		if (!actorOutranks(actorMembership.role, role)) {
			return withCorsHeaders(
				req,
				jsonError(403, 'cannot_assign_higher_or_equal_role')
			)
		}
		const invitee = await tenancy.findUserByGithubLogin(login)
		if (!invitee) {
			return withCorsHeaders(
				req,
				jsonError(404, 'user_not_found', 'ask the invitee to sign in first')
			)
		}
		const m = await tenancy.addMember(workspace_id, invitee.id, role)
		void auditAndDispatch(
			{ audit, endpointStore, deliveryStore },
			{
				workspace_id,
				actor_user_id: actor,
				action: 'member.added',
				target_type: 'workspace_member',
				target_id: invitee.id,
				details: { github_login: invitee.github_login, role },
			}
		)
		return withCorsHeaders(
			req,
			new Response(JSON.stringify({ membership: m, user: invitee }), {
				status: 201,
				headers: { 'content-type': 'application/json' },
			})
		)
	}

	if (req.method === 'PATCH' && target_user_id) {
		let body: { role?: string }
		try {
			body = (await req.json()) as typeof body
		} catch {
			return withCorsHeaders(req, jsonError(400, 'malformed_json'))
		}
		const role = body.role as WorkspaceRole | undefined
		if (!role || !(VALID_ROLES as readonly string[]).includes(role)) {
			return withCorsHeaders(req, jsonError(400, 'invalid_role'))
		}
		// Outrank checks against the CURRENT role of the target.
		const current = await tenancy.getMembership(target_user_id, workspace_id)
		if (!current) return withCorsHeaders(req, jsonError(404, 'member_not_found'))
		if (!actorOutranks(actorMembership.role, current.role)) {
			return withCorsHeaders(req, jsonError(403, 'cannot_modify_higher_or_equal_role'))
		}
		if (!actorOutranks(actorMembership.role, role)) {
			return withCorsHeaders(req, jsonError(403, 'cannot_assign_higher_or_equal_role'))
		}
		try {
			const updated = await tenancy.setMemberRole(workspace_id, target_user_id, role)
			if (!updated) return withCorsHeaders(req, jsonError(404, 'member_not_found'))
			void auditAndDispatch(
				{ audit, endpointStore, deliveryStore },
				{
					workspace_id,
					actor_user_id: actor,
					action: 'member.role_changed',
					target_type: 'workspace_member',
					target_id: target_user_id,
					details: { from_role: current.role, to_role: role },
				}
			)
			return withCorsHeaders(
				req,
				new Response(JSON.stringify({ membership: updated }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				})
			)
		} catch (err) {
			if (err instanceof Error && err.name === 'TenancyForbiddenError') {
				return withCorsHeaders(req, jsonError(409, 'last_owner_protected'))
			}
			throw err
		}
	}

	if (req.method === 'DELETE' && target_user_id) {
		const current = await tenancy.getMembership(target_user_id, workspace_id)
		if (!current) return withCorsHeaders(req, jsonError(404, 'member_not_found'))
		if (!actorOutranks(actorMembership.role, current.role) && actor !== target_user_id) {
			// Same outrank rule, BUT we allow a user to remove themselves
			// (leave the workspace) regardless of rank, except the
			// last-owner protection below.
			return withCorsHeaders(req, jsonError(403, 'cannot_modify_higher_or_equal_role'))
		}
		try {
			const removed = await tenancy.removeMember(workspace_id, target_user_id)
			if (!removed) return withCorsHeaders(req, jsonError(404, 'member_not_found'))
			void auditAndDispatch(
				{ audit, endpointStore, deliveryStore },
				{
					workspace_id,
					actor_user_id: actor,
					action: 'member.removed',
					target_type: 'workspace_member',
					target_id: target_user_id,
					details: { prior_role: current.role },
				}
			)
			return withCorsHeaders(req, new Response(null, { status: 204 }))
		} catch (err) {
			if (err instanceof Error && err.name === 'TenancyForbiddenError') {
				return withCorsHeaders(req, jsonError(409, 'last_owner_protected'))
			}
			throw err
		}
	}

	return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))
}

/** True when actor's rank > target's rank (strict outrank). */
function actorOutranks(actor: WorkspaceRole, target: WorkspaceRole): boolean {
	return ROLE_RANK[actor] > ROLE_RANK[target]
}

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
