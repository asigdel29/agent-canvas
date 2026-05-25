/**
 * WorkspaceSwitcher — a small dropdown that lets the user switch
 * between the workspaces they belong to.
 *
 * Mounted into the canvas shell header. Selection persists the
 * chosen workspace_id into sessionStorage; the App reads from
 * there on the next render and rebuilds AgentApi with the new id.
 *
 * Read flow:
 *   1. On mount, fetch /api/workspaces.
 *   2. Show the current workspace's name in the trigger.
 *   3. On select, write the new id to sessionStorage and call
 *      onSwitch(id). The parent rebuilds its API clients.
 *
 * UI is deliberately minimal — no search box, no avatars. The
 * settings page is the place for membership management.
 */

import { useEffect, useState } from 'react'
import { WorkspaceApi, type WorkspaceRole, type WorkspaceSummary } from './workspaceApi.js'

export interface WorkspaceSwitcherProps {
	readonly orchestratorUrl: string
	readonly session: string
	readonly currentWorkspaceId: string
	readonly onSwitch: (workspace_id: string) => void
	/** Route the caller to /workspace/members. */
	readonly onOpenMembers: () => void
}

interface Entry {
	readonly workspace: WorkspaceSummary
	readonly role: WorkspaceRole
}

export function WorkspaceSwitcher(props: WorkspaceSwitcherProps) {
	const [open, setOpen] = useState(false)
	const [entries, setEntries] = useState<readonly Entry[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)

	useEffect(() => {
		let cancelled = false
		const api = new WorkspaceApi({ baseUrl: props.orchestratorUrl, session: props.session })
		api
			.list()
			.then((items) => {
				if (!cancelled) setEntries(items)
			})
			.catch((err: Error) => {
				if (!cancelled) setError(err.message)
			})
		return () => {
			cancelled = true
		}
	}, [props.orchestratorUrl, props.session])

	const current = entries?.find((e) => e.workspace.id === props.currentWorkspaceId)
	const label = current?.workspace.name ?? '…'

	async function handleCreate(name: string): Promise<void> {
		const api = new WorkspaceApi({ baseUrl: props.orchestratorUrl, session: props.session })
		const ws = await api.create(name)
		setEntries((prev) =>
			prev ? [...prev, { workspace: ws, role: 'owner' as WorkspaceRole }] : prev
		)
		setCreating(false)
		setOpen(false)
		props.onSwitch(ws.id)
	}

	return (
		<div style={{ position: 'relative', display: 'inline-block' }}>
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-haspopup="menu"
				aria-expanded={open}
				style={{
					display: 'inline-flex',
					alignItems: 'center',
					gap: 6,
					padding: '4px 10px',
					fontSize: 'var(--font-12)',
					fontFamily: 'var(--font-ui)',
					color: 'var(--text-strong)',
					background: 'var(--surface-raised)',
					border: '1px solid var(--border)',
					borderRadius: 6,
					cursor: 'pointer',
				}}
			>
				<span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
					{label}
				</span>
				<span aria-hidden style={{ opacity: 0.6 }}>▾</span>
			</button>
			{open && (
				<div
					role="menu"
					style={{
						position: 'absolute',
						top: 'calc(100% + 4px)',
						left: 0,
						minWidth: 220,
						background: 'var(--surface-raised)',
						border: '1px solid var(--border)',
						borderRadius: 6,
						boxShadow: '0 6px 16px rgba(0,0,0,0.3)',
						zIndex: 50,
						padding: 4,
					}}
				>
					{error && (
						<div style={{ padding: 8, fontSize: 'var(--font-12)', color: 'var(--text-danger)' }}>
							{error}
						</div>
					)}
					{!entries && !error && (
						<div style={{ padding: 8, fontSize: 'var(--font-12)', color: 'var(--text-muted)' }}>
							Loading…
						</div>
					)}
					{entries?.map((e) => (
						<button
							key={e.workspace.id}
							type="button"
							role="menuitem"
							onClick={() => {
								setOpen(false)
								props.onSwitch(e.workspace.id)
							}}
							style={{
								display: 'flex',
								justifyContent: 'space-between',
								alignItems: 'baseline',
								width: '100%',
								padding: '6px 8px',
								background:
									e.workspace.id === props.currentWorkspaceId ? 'var(--surface-sunk)' : 'transparent',
								border: 'none',
								textAlign: 'left',
								color: 'var(--text-strong)',
								fontFamily: 'var(--font-ui)',
								fontSize: 'var(--font-12)',
								borderRadius: 4,
								cursor: 'pointer',
							}}
						>
							<span>{e.workspace.name}</span>
							<span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{e.role}</span>
						</button>
					))}
					<div style={{ height: 1, background: 'var(--border)', margin: '4px 2px' }} />
					{creating ? (
						<CreateWorkspaceRow
							onCommit={handleCreate}
							onCancel={() => setCreating(false)}
						/>
					) : (
						<button
							type="button"
							onClick={() => setCreating(true)}
							style={{
								width: '100%',
								padding: '6px 8px',
								background: 'transparent',
								border: 'none',
								textAlign: 'left',
								color: 'var(--accent)',
								fontFamily: 'var(--font-ui)',
								fontSize: 'var(--font-12)',
								cursor: 'pointer',
							}}
						>
							+ New workspace
						</button>
					)}
					<button
						type="button"
						onClick={() => {
							setOpen(false)
							props.onOpenMembers()
						}}
						style={{
							width: '100%',
							padding: '6px 8px',
							background: 'transparent',
							border: 'none',
							textAlign: 'left',
							color: 'var(--text-muted)',
							fontFamily: 'var(--font-ui)',
							fontSize: 'var(--font-12)',
							cursor: 'pointer',
						}}
					>
						Manage members…
					</button>
				</div>
			)}
		</div>
	)
}

function CreateWorkspaceRow(props: {
	onCommit: (name: string) => Promise<void>
	onCancel: () => void
}) {
	const [name, setName] = useState('')
	const [busy, setBusy] = useState(false)
	return (
		<form
			onSubmit={async (ev) => {
				ev.preventDefault()
				const trimmed = name.trim()
				if (!trimmed) return
				setBusy(true)
				try {
					await props.onCommit(trimmed)
				} finally {
					setBusy(false)
				}
			}}
			style={{ display: 'flex', gap: 4, padding: 4 }}
		>
			<input
				autoFocus
				placeholder="Workspace name"
				value={name}
				onChange={(e) => setName(e.target.value)}
				disabled={busy}
				style={{
					flex: 1,
					padding: '4px 6px',
					fontFamily: 'var(--font-ui)',
					fontSize: 'var(--font-12)',
					background: 'var(--surface-sunk)',
					border: '1px solid var(--border)',
					borderRadius: 4,
					color: 'var(--text-strong)',
				}}
			/>
			<button
				type="button"
				onClick={props.onCancel}
				disabled={busy}
				style={{
					background: 'transparent',
					border: '1px solid var(--border)',
					borderRadius: 4,
					padding: '4px 8px',
					fontSize: 'var(--font-12)',
					color: 'var(--text-muted)',
					cursor: 'pointer',
				}}
			>
				Cancel
			</button>
			<button
				type="submit"
				disabled={busy || name.trim().length === 0}
				style={{
					background: 'var(--accent)',
					border: 'none',
					borderRadius: 4,
					padding: '4px 8px',
					fontSize: 'var(--font-12)',
					color: 'white',
					cursor: 'pointer',
				}}
			>
				{busy ? 'Creating…' : 'Create'}
			</button>
		</form>
	)
}
