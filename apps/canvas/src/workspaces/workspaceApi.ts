/**
 * Thin REST client for /api/workspaces and /api/workspaces/:id/members.
 *
 * All calls carry the session JWT in Authorization: Bearer. Errors
 * throw WorkspaceApiError with the status + server-supplied detail
 * so the WorkspaceSwitcher / MembersPage can render a toast.
 */

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer'

export interface WorkspaceSummary {
	readonly id: string
	readonly name: string
	readonly owner_user_id: string
	readonly created_at: string
	readonly archived_at: string | null
}

export interface MembershipSummary {
	readonly workspace_id: string
	readonly user_id: string
	readonly role: WorkspaceRole
	readonly joined_at: string
}

export interface UserSummary {
	readonly id: string
	readonly github_id: string | null
	readonly github_login: string | null
	readonly email: string | null
	readonly name: string | null
}

export interface MemberRow {
	readonly user: UserSummary
	readonly membership: MembershipSummary
}

export class WorkspaceApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly detail?: string
	) {
		super(detail ? `[${status} ${code}] ${detail}` : `[${status}] ${code}`)
		this.name = 'WorkspaceApiError'
	}
}

async function throwOnError(res: Response): Promise<void> {
	if (res.ok) return
	let body: { error?: string; detail?: string } = {}
	try {
		body = (await res.json()) as typeof body
	} catch {
		/* swallow */
	}
	throw new WorkspaceApiError(res.status, body.error ?? `http_${res.status}`, body.detail)
}

export interface WorkspaceApiOptions {
	readonly baseUrl: string
	readonly session: string
}

export class WorkspaceApi {
	constructor(private readonly opts: WorkspaceApiOptions) {}

	private headers(json = false): Record<string, string> {
		const h: Record<string, string> = { authorization: `Bearer ${this.opts.session}` }
		if (json) h['content-type'] = 'application/json'
		return h
	}

	async list(): Promise<readonly { workspace: WorkspaceSummary; role: WorkspaceRole }[]> {
		const res = await fetch(`${this.opts.baseUrl}/api/workspaces`, {
			headers: this.headers(),
		})
		await throwOnError(res)
		const body = (await res.json()) as {
			items: { workspace: WorkspaceSummary; role: WorkspaceRole }[]
		}
		return body.items
	}

	async create(name: string): Promise<WorkspaceSummary> {
		const res = await fetch(`${this.opts.baseUrl}/api/workspaces`, {
			method: 'POST',
			headers: this.headers(true),
			body: JSON.stringify({ name }),
		})
		await throwOnError(res)
		const body = (await res.json()) as { workspace: WorkspaceSummary }
		return body.workspace
	}

	async listMembers(workspace_id: string): Promise<readonly MemberRow[]> {
		const res = await fetch(
			`${this.opts.baseUrl}/api/workspaces/${encodeURIComponent(workspace_id)}/members`,
			{ headers: this.headers() }
		)
		await throwOnError(res)
		const body = (await res.json()) as { items: MemberRow[] }
		return body.items
	}

	async invite(
		workspace_id: string,
		github_login: string,
		role: WorkspaceRole
	): Promise<MemberRow> {
		const res = await fetch(
			`${this.opts.baseUrl}/api/workspaces/${encodeURIComponent(workspace_id)}/members`,
			{
				method: 'POST',
				headers: this.headers(true),
				body: JSON.stringify({ github_login, role }),
			}
		)
		await throwOnError(res)
		const body = (await res.json()) as { membership: MembershipSummary; user: UserSummary }
		return { user: body.user, membership: body.membership }
	}

	async setRole(
		workspace_id: string,
		user_id: string,
		role: WorkspaceRole
	): Promise<MembershipSummary> {
		const res = await fetch(
			`${this.opts.baseUrl}/api/workspaces/${encodeURIComponent(workspace_id)}/members/${encodeURIComponent(user_id)}`,
			{
				method: 'PATCH',
				headers: this.headers(true),
				body: JSON.stringify({ role }),
			}
		)
		await throwOnError(res)
		const body = (await res.json()) as { membership: MembershipSummary }
		return body.membership
	}

	async remove(workspace_id: string, user_id: string): Promise<void> {
		const res = await fetch(
			`${this.opts.baseUrl}/api/workspaces/${encodeURIComponent(workspace_id)}/members/${encodeURIComponent(user_id)}`,
			{ method: 'DELETE', headers: this.headers() }
		)
		await throwOnError(res)
	}
}
