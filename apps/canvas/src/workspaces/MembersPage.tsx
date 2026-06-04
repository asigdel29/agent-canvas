/**
 * MembersPage — standalone page at /workspace/members.
 *
 * Lists the current workspace's members, lets an admin+ invite by
 * github login, change a role, or remove someone. Owner+ may also
 * promote to owner.
 *
 * Designed to render as a route, not as a modal — workspace admin
 * is rare and benefits from address-bar-shareable state.
 *
 * Auth posture: every API call is session-only (the bearer header
 * holds the session JWT). Errors surface inline; we do not toast.
 * @author asigdel29
 */

import { useEffect, useState } from 'react'
import {
	WorkspaceApi,
	WorkspaceApiError,
	type MemberRow,
	type WorkspaceRole,
} from './workspaceApi.js'

export interface MembersPageProps {
	readonly orchestratorUrl: string
	readonly session: string
	readonly workspaceId: string
	readonly currentUserId: string
	readonly onBack: () => void
}

const ROLE_ORDER: readonly WorkspaceRole[] = ['viewer', 'member', 'admin', 'owner']

export function MembersPage(props: MembersPageProps) {
	const api = new WorkspaceApi({ baseUrl: props.orchestratorUrl, session: props.session })
	const [rows, setRows] = useState<readonly MemberRow[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [pendingInvite, setPendingInvite] = useState({ login: '', role: 'member' as WorkspaceRole, busy: false })

	async function refresh(): Promise<void> {
		try {
			const items = await api.listMembers(props.workspaceId)
			setRows(items)
			setError(null)
		} catch (err) {
			setError(err instanceof WorkspaceApiError ? err.message : 'failed_to_load')
		}
	}

	useEffect(() => {
		void refresh()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.workspaceId])

	const actorRow = rows?.find((r) => r.user.id === props.currentUserId)
	const actorRole = actorRow?.membership.role ?? 'viewer'

	async function handleInvite(): Promise<void> {
		if (!pendingInvite.login.trim()) return
		setPendingInvite((p) => ({ ...p, busy: true }))
		try {
			await api.invite(props.workspaceId, pendingInvite.login.trim(), pendingInvite.role)
			setPendingInvite({ login: '', role: 'member', busy: false })
			await refresh()
		} catch (err) {
			setPendingInvite((p) => ({ ...p, busy: false }))
			setError(err instanceof WorkspaceApiError ? err.message : 'invite_failed')
		}
	}

	async function handleRole(row: MemberRow, newRole: WorkspaceRole): Promise<void> {
		try {
			await api.setRole(props.workspaceId, row.user.id, newRole)
			await refresh()
		} catch (err) {
			setError(err instanceof WorkspaceApiError ? err.message : 'role_change_failed')
		}
	}

	async function handleRemove(row: MemberRow): Promise<void> {
		const confirmed = window.confirm(
			`Remove ${row.user.github_login ?? row.user.id} from the workspace?`
		)
		if (!confirmed) return
		try {
			await api.remove(props.workspaceId, row.user.id)
			await refresh()
		} catch (err) {
			setError(err instanceof WorkspaceApiError ? err.message : 'remove_failed')
		}
	}

	return (
		<div
			style={{
				position: 'fixed',
				inset: 0,
				overflowY: 'auto',
				background: 'var(--surface)',
				color: 'var(--text-strong)',
				padding: 'var(--space-7) var(--space-5)',
				fontFamily: 'var(--font-ui)',
				fontSize: 'var(--font-14)',
			}}
		>
			<div style={{ maxWidth: 720, margin: '0 auto' }}>
				<nav style={{ marginBottom: 'var(--space-5)' }}>
					<button
						type="button"
						onClick={props.onBack}
						style={{
							background: 'none',
							border: 'none',
							color: 'var(--accent)',
							fontSize: 'var(--font-12)',
							cursor: 'pointer',
							padding: 0,
						}}
					>
						← Back to canvas
					</button>
				</nav>
				<h1
					style={{
						fontSize: 'var(--font-24)',
						fontWeight: 500,
						margin: '0 0 var(--space-5)',
					}}
				>
					Workspace members
				</h1>

				{error && (
					<div
						role="alert"
						style={{
							padding: 12,
							marginBottom: 'var(--space-4)',
							background: 'rgba(255, 80, 80, 0.1)',
							border: '1px solid var(--text-danger)',
							borderRadius: 6,
							color: 'var(--text-danger)',
							fontSize: 'var(--font-12)',
						}}
					>
						{error}
					</div>
				)}

				{(actorRole === 'admin' || actorRole === 'owner') && (
					<section style={{ marginBottom: 'var(--space-5)' }}>
						<h2 style={{ fontSize: 'var(--font-16)', fontWeight: 500, marginBottom: 8 }}>
							Invite by github login
						</h2>
						<div style={{ display: 'flex', gap: 8 }}>
							<input
								placeholder="github handle"
								value={pendingInvite.login}
								onChange={(e) => setPendingInvite((p) => ({ ...p, login: e.target.value }))}
								disabled={pendingInvite.busy}
								style={inputStyle}
							/>
							<select
								value={pendingInvite.role}
								onChange={(e) =>
									setPendingInvite((p) => ({ ...p, role: e.target.value as WorkspaceRole }))
								}
								disabled={pendingInvite.busy}
								style={inputStyle}
							>
								{ROLE_ORDER.filter((r) => actorRole === 'owner' || r !== 'owner').map((r) => (
									<option key={r} value={r}>
										{r}
									</option>
								))}
							</select>
							<button
								type="button"
								onClick={handleInvite}
								disabled={pendingInvite.busy || pendingInvite.login.trim().length === 0}
								style={primaryButtonStyle}
							>
								{pendingInvite.busy ? 'Inviting…' : 'Invite'}
							</button>
						</div>
						<p style={{ fontSize: 'var(--font-12)', color: 'var(--text-muted)', marginTop: 4 }}>
							The invitee must have signed in to agent-canvas at least once.
						</p>
					</section>
				)}

				<section>
					<h2 style={{ fontSize: 'var(--font-16)', fontWeight: 500, marginBottom: 8 }}>
						Members ({rows?.length ?? 0})
					</h2>
					{!rows && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}
					{rows && rows.length === 0 && (
						<p style={{ color: 'var(--text-muted)' }}>No members yet.</p>
					)}
					{rows && rows.length > 0 && (
						<table
							style={{
								width: '100%',
								borderCollapse: 'collapse',
								fontSize: 'var(--font-12)',
							}}
						>
							<thead>
								<tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
									<th style={cellStyle}>Member</th>
									<th style={cellStyle}>Role</th>
									<th style={cellStyle}>Joined</th>
									<th style={cellStyle}></th>
								</tr>
							</thead>
							<tbody>
								{rows.map((row) => (
									<MemberTableRow
										key={row.user.id}
										row={row}
										actorRole={actorRole}
										actorUserId={props.currentUserId}
										onRole={(r) => handleRole(row, r)}
										onRemove={() => handleRemove(row)}
									/>
								))}
							</tbody>
						</table>
					)}
				</section>
			</div>
		</div>
	)
}

const cellStyle: React.CSSProperties = {
	padding: '8px 4px',
	verticalAlign: 'middle',
}
const inputStyle: React.CSSProperties = {
	padding: '6px 8px',
	fontFamily: 'var(--font-ui)',
	fontSize: 'var(--font-12)',
	background: 'var(--surface-sunk)',
	border: '1px solid var(--border)',
	borderRadius: 4,
	color: 'var(--text-strong)',
}
const primaryButtonStyle: React.CSSProperties = {
	padding: '6px 12px',
	background: 'var(--accent)',
	border: 'none',
	borderRadius: 4,
	color: 'white',
	fontFamily: 'var(--font-ui)',
	fontSize: 'var(--font-12)',
	cursor: 'pointer',
}

function MemberTableRow(props: {
	row: MemberRow
	actorRole: WorkspaceRole
	actorUserId: string
	onRole: (r: WorkspaceRole) => Promise<void>
	onRemove: () => Promise<void>
}) {
	const { row, actorRole, actorUserId } = props
	const isSelf = row.user.id === actorUserId
	const canModify =
		(actorRole === 'owner' || (actorRole === 'admin' && row.membership.role !== 'owner')) &&
		!isSelf
	const display =
		row.user.name ?? row.user.github_login ?? row.user.email ?? row.user.id
	return (
		<tr style={{ borderBottom: '1px solid var(--border)' }}>
			<td style={cellStyle}>
				<div>{display}</div>
				<div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
					{row.user.github_login ?? row.user.email ?? ''}
				</div>
			</td>
			<td style={cellStyle}>
				{canModify ? (
					<select
						value={row.membership.role}
						onChange={(e) => void props.onRole(e.target.value as WorkspaceRole)}
						style={inputStyle}
					>
						{ROLE_ORDER.filter((r) => actorRole === 'owner' || r !== 'owner').map((r) => (
							<option key={r} value={r}>
								{r}
							</option>
						))}
					</select>
				) : (
					<span>{row.membership.role}</span>
				)}
			</td>
			<td style={cellStyle}>
				<span style={{ color: 'var(--text-muted)' }}>
					{new Date(row.membership.joined_at).toLocaleDateString()}
				</span>
			</td>
			<td style={cellStyle}>
				{canModify && (
					<button
						type="button"
						onClick={() => void props.onRemove()}
						style={{
							background: 'transparent',
							border: '1px solid var(--text-danger)',
							borderRadius: 4,
							color: 'var(--text-danger)',
							padding: '4px 8px',
							fontSize: 'var(--font-12)',
							cursor: 'pointer',
						}}
					>
						Remove
					</button>
				)}
			</td>
		</tr>
	)
}
