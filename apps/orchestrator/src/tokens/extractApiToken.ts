/**
 * extractApiToken — accepts an `Authorization: Bearer ack_...`
 * header and verifies it against the ApiTokenStore. Returns the
 * verified record or null.
 *
 * Routes that accept BOTH session JWTs and API tokens use the
 * `resolveAuth` helper below. Session takes precedence (the
 * canvas sends one); API tokens are the alternative path for
 * CLI / SDK / webhooks-out.
 *
 * Authentication context returned to the caller carries
 * everything a route needs to authorize: user_id, workspace_id
 * (from the token's workspace scope), and the auth kind so
 * routes can deny token holders from certain UI-only actions
 * (e.g. resolving approvals is intentionally session-only — a
 * CLI should not be able to approve a destructive call on the
 * operator's behalf).
 * @author asigdel29
 */

import type { UserId } from '@agent-canvas/orchestrator-types'
import { extractSession } from '../auth/session.js'
import type { ApiTokenStore, ApiTokenRecord, ApiTokenScope } from './apiTokenStore.js'
import type { WorkspaceId } from '../tenancy/tenancyTypes.js'

export type AuthKind = 'session' | 'api_token'

export interface AuthContext {
	readonly kind: AuthKind
	readonly user_id: UserId
	readonly workspace_id: WorkspaceId | null
	/** API-token scope; null when authenticated via session JWT. */
	readonly token_scope: ApiTokenScope | null
}

const API_TOKEN_PREFIX = 'ack_'

export async function extractApiToken(
	req: Request,
	store: ApiTokenStore
): Promise<ApiTokenRecord | null> {
	const auth = req.headers.get('authorization')
	if (!auth) return null
	const m = auth.match(/^Bearer\s+(\S+)\s*$/i)
	if (!m) return null
	const raw = m[1]!
	if (!raw.startsWith(API_TOKEN_PREFIX)) return null // not our token shape
	return store.verify(raw)
}

/**
 * Resolve a request's auth via session JWT OR API token.
 * Returns null when neither path matches. The route turns null
 * into 401; non-null is the context for the membership gate.
 *
 * Precedence: API token first when the header looks like ours
 * (cheap regex check), then session JWT. This ordering means
 * a CLI client with a token doesn't accidentally fall through
 * to session parsing if their token is somehow malformed.
 */
export async function resolveAuth(
	req: Request,
	tokenStore: ApiTokenStore,
	sessionSecret: string
): Promise<AuthContext | null> {
	const auth = req.headers.get('authorization')
	if (auth) {
		const m = auth.match(/^Bearer\s+(\S+)\s*$/i)
		if (m && m[1]!.startsWith(API_TOKEN_PREFIX)) {
			const record = await tokenStore.verify(m[1]!)
			if (!record) return null
			return {
				kind: 'api_token',
				user_id: record.user_id,
				workspace_id: record.workspace_id,
				token_scope: record.scope,
			}
		}
	}
	const session = extractSession(req, sessionSecret)
	if (!session) return null
	return {
		kind: 'session',
		user_id: session.sub as UserId,
		workspace_id: (session.workspace_id as WorkspaceId | undefined) ?? null,
		token_scope: null,
	}
}
