/**
 * Closed enum of workspace-audit action names.
 *
 * Each action is namespaced with a dot: `<entity>.<verb>`. The set
 * here is the source of truth; the API surface and the read-side
 * filter validate against it. Adding a new action requires a code
 * change so we can't accidentally leak free-form strings into the
 * audit query response.
 *
 * The corresponding `details` shape is documented per action below.
 * Callers should match these shapes; the store is permissive (any
 * jsonb) but the audit query consumer expects them.
 * @author asigdel29
 */

export const WORKSPACE_AUDIT_ACTIONS = [
	// API tokens
	'token.minted', // details: { token_id, token_prefix, scope, name }
	'token.revoked', // details: { token_id, token_prefix }

	// Outbound webhook endpoints
	'webhook.created', // details: { endpoint_id, url_host, events }
	'webhook.revoked', // details: { endpoint_id, url_host }

	// Membership
	'member.added', // details: { user_id, role }
	'member.role_changed', // details: { user_id, from_role, to_role }
	'member.removed', // details: { user_id, prior_role }

	// Workspace itself
	'workspace.created', // details: { name }
	'workspace.renamed', // details: { from_name, to_name }
] as const

export type WorkspaceAuditAction = (typeof WORKSPACE_AUDIT_ACTIONS)[number]

export const WORKSPACE_AUDIT_TARGET_TYPES = [
	'api_token',
	'webhook_endpoint',
	'workspace_member',
	'workspace',
] as const

export type WorkspaceAuditTargetType = (typeof WORKSPACE_AUDIT_TARGET_TYPES)[number]

export function isWorkspaceAuditAction(s: string): s is WorkspaceAuditAction {
	return (WORKSPACE_AUDIT_ACTIONS as readonly string[]).includes(s)
}
