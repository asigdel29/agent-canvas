/**
 * Thin client for /api/agents. Centralized here so the App
 * component does not bake in fetch shapes.
 *
 * Every call carries the session JWT in Authorization: Bearer.
 * Errors throw AgentApiError with the status + server-supplied
 * detail so the caller can surface a meaningful toast.
 */

import type { NewAgentDraft } from './NewAgentModal.js'

export interface AgentApiRecord {
	readonly id: string
	readonly workspace_id: string
	readonly owner_user_id: string
	readonly name: string
	readonly purpose: string
	readonly model: string
	readonly system_prompt: string
	readonly capabilities: NewAgentDraft['capabilities']
	readonly created_at: string
	readonly updated_at: string
	readonly archived_at: string | null
}

export class AgentApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		public readonly detail?: string
	) {
		super(detail ? `[${status} ${code}] ${detail}` : `[${status}] ${code}`)
		this.name = 'AgentApiError'
	}
}

export interface AgentApiOptions {
	readonly baseUrl: string
	readonly session: string
	readonly workspaceId: string
}

export class AgentApi {
	constructor(private readonly opts: AgentApiOptions) {}

	async list(): Promise<readonly AgentApiRecord[]> {
		const url = new URL(`${this.opts.baseUrl}/api/agents`)
		url.searchParams.set('workspace_id', this.opts.workspaceId)
		const res = await fetch(url.toString(), { headers: this.authHeaders() })
		await throwOnError(res)
		const body = (await res.json()) as { items: AgentApiRecord[] }
		return body.items
	}

	async create(draft: NewAgentDraft): Promise<AgentApiRecord> {
		const res = await fetch(`${this.opts.baseUrl}/api/agents`, {
			method: 'POST',
			headers: {
				...this.authHeaders(),
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				workspace_id: this.opts.workspaceId,
				name: draft.name,
				purpose: draft.purpose,
				model: draft.model,
				system_prompt: draft.system_prompt,
				capabilities: draft.capabilities,
			}),
		})
		await throwOnError(res)
		return (await res.json()) as AgentApiRecord
	}

	async update(id: string, patch: Partial<NewAgentDraft>): Promise<AgentApiRecord> {
		const res = await fetch(`${this.opts.baseUrl}/api/agents/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			headers: {
				...this.authHeaders(),
				'content-type': 'application/json',
			},
			body: JSON.stringify(patch),
		})
		await throwOnError(res)
		return (await res.json()) as AgentApiRecord
	}

	async archive(id: string): Promise<void> {
		const res = await fetch(`${this.opts.baseUrl}/api/agents/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			headers: this.authHeaders(),
		})
		await throwOnError(res)
	}

	/**
	 * Fire a fresh run for an agent. Returns immediately with the
	 * server-assigned run_id; events arrive over SSE on the room.
	 */
	async startRun(input: {
		agent_id: string
		initial_message: string
	}): Promise<{ run_id: string; agent_id: string; room_id: string }> {
		const res = await fetch(`${this.opts.baseUrl}/api/agents/runs`, {
			method: 'POST',
			headers: {
				...this.authHeaders(),
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				agent_id: input.agent_id,
				room_id: this.opts.workspaceId,
				initial_message: input.initial_message,
			}),
		})
		await throwOnError(res)
		return (await res.json()) as { run_id: string; agent_id: string; room_id: string }
	}

	async listApprovals(runId?: string): Promise<readonly PendingApprovalDto[]> {
		const url = new URL(`${this.opts.baseUrl}/api/approvals`)
		if (runId) url.searchParams.set('run_id', runId)
		const res = await fetch(url.toString(), { headers: this.authHeaders() })
		await throwOnError(res)
		const body = (await res.json()) as { items: PendingApprovalDto[] }
		return body.items
	}

	async resolveApproval(
		id: string,
		resolution: 'approved' | 'rejected'
	): Promise<PendingApprovalDto> {
		const res = await fetch(`${this.opts.baseUrl}/api/approvals/${encodeURIComponent(id)}`, {
			method: 'POST',
			headers: {
				...this.authHeaders(),
				'content-type': 'application/json',
			},
			body: JSON.stringify({ resolution }),
		})
		await throwOnError(res)
		return (await res.json()) as PendingApprovalDto
	}

	private authHeaders(): Record<string, string> {
		const out: Record<string, string> = {
			authorization: `Bearer ${this.opts.session}`,
		}
		// Bring-Your-Own-Key passthrough. The orchestrator's runs.ts
		// reads these and uses them instead of its own env vars.
		// sessionStorage is the source of truth (see SettingsDrawer).
		const anthropic = readBYOK('agent-canvas:anthropic_api_key')
		const e2b = readBYOK('agent-canvas:e2b_api_key')
		if (anthropic) out['x-anthropic-api-key'] = anthropic
		if (e2b) out['x-e2b-api-key'] = e2b
		return out
	}
}

function readBYOK(key: string): string {
	if (typeof window === 'undefined') return ''
	try {
		return (window.sessionStorage.getItem(key) ?? '').trim()
	} catch {
		return ''
	}
}

export interface PendingApprovalDto {
	readonly id: string
	readonly agent_id: string
	readonly run_id: string
	readonly tool_name: string
	readonly tool_input: Readonly<Record<string, unknown>>
	readonly tool_description: string
	readonly safety: 'destructive' | 'irreversible'
	readonly requested_at: string
	readonly resolved_at: string | null
	readonly resolution: 'approved' | 'rejected' | null
}

async function throwOnError(res: Response): Promise<void> {
	if (res.ok) return
	let code = 'unknown'
	let detail: string | undefined
	try {
		const body = (await res.json()) as { error?: string; detail?: string }
		code = body.error ?? code
		detail = body.detail
	} catch {
		// non-json error body; keep defaults
	}
	throw new AgentApiError(res.status, code, detail)
}
