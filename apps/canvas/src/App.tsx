/**
 * App — the canvas client root.
 *
 * Composes the three-zone Shell (TopBar / LeftRail / canvas /
 * RightRail) plus the floating chrome overlays (toolbar top centre,
 * zoom cluster bottom right). The canvas itself is Tldraw with the
 * agent ShapeUtil registered; when no connectors are configured the
 * canvas area shows the EmptyState card instead.
 *
 * Realtime: when the URL carries `?room=<id>&session=<jwt>` the app
 * moves the session JWT into sessionStorage and strips it from the
 * URL via history.replaceState BEFORE any other code runs. This
 * collapses the leak window for the long-lived session credential
 * to the single round trip that delivers the page; CDN access logs,
 * Referer headers, and browser history never see it. The session is
 * then used to mint short-lived (60s, single-use) SSE tokens for the
 * realtime stream.
 *
 * Orchestrator base URL: VITE_ORCHESTRATOR_URL (default
 * http://localhost:3000).
 */

import { useEffect, useMemo, useState } from 'react'
import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'

import { AgentShapeUtil } from './agent/AgentShapeUtil.js'
import { ApprovalInbox, type ApprovalCard } from './inbox/ApprovalInbox.js'
import { ConnectorStrip, type ConnectorTile } from './connectors/ConnectorStrip.js'
import { EmptyState, type StarterProvider } from './onboarding/EmptyState.js'
import { SpendIndicator } from './spend/SpendBanner.js'
import { Shell } from './layout/Shell.js'
import { TopBar } from './layout/TopBar.js'
import { LeftRail, type RailItem } from './layout/LeftRail.js'
import { RightRail, type RightRailMode } from './layout/RightRail.js'
import {
	FloatingToolbar,
	IconAgent,
	IconComment,
	IconConnector,
	IconHand,
	IconSelect,
	type ToolbarTool,
} from './layout/FloatingToolbar.js'
import { ZoomCluster } from './layout/ZoomCluster.js'
import { RoomEventClient, type RunEventPayload } from './sync/RoomEventClient.js'

const SHAPE_UTILS = [AgentShapeUtil]
const MAX_LIVE_EVENTS = 50

const ORCHESTRATOR_URL =
	(import.meta as unknown as { env?: Record<string, string> }).env?.[
		'VITE_ORCHESTRATOR_URL'
	] ?? 'http://localhost:3000'

const SESSION_STORAGE_KEY = 'agent-canvas:session'
const ROOM_STORAGE_KEY = 'agent-canvas:room'

/**
 * Roughly: 250ms, 500ms, 1s, 2s, 4s, 8s, 16s, 30s, 30s, ... — 20
 * attempts is roughly 9.5 minutes at the 30s max-backoff cap. After
 * that we give up and surface the disconnected banner so a phone
 * left on a dead network stops draining battery.
 */
const MAX_RECONNECT_ATTEMPTS = 20

const TOOLS: readonly ToolbarTool[] = [
	{ id: 'hand', label: 'Hand', shortcut: 'H', icon: <IconHand /> },
	{ id: 'select', label: 'Select', shortcut: 'V', icon: <IconSelect /> },
	{ id: 'agent', label: 'New agent', shortcut: 'A', icon: <IconAgent /> },
	{ id: 'connector', label: 'New connector', shortcut: 'C', icon: <IconConnector /> },
	{ id: 'comment', label: 'Comment', shortcut: '/', icon: <IconComment /> },
]

/**
 * Pulls the session JWT and room id out of the URL once on first
 * load, stashes them in sessionStorage, and rewrites the URL so the
 * credential does not survive in history, Referer, or CDN logs.
 *
 * Returns whatever pair is available — URL takes precedence on first
 * load, sessionStorage on subsequent reads.
 */
function intakeAndStashCredentials(): { room: string; session: string } | null {
	if (typeof window === 'undefined') return null
	const url = new URL(window.location.href)
	const urlRoom = url.searchParams.get('room')
	const urlSession = url.searchParams.get('session')
	if (urlRoom && urlSession) {
		try {
			window.sessionStorage.setItem(SESSION_STORAGE_KEY, urlSession)
			window.sessionStorage.setItem(ROOM_STORAGE_KEY, urlRoom)
		} catch {
			// sessionStorage may be disabled (private mode, sandboxed iframe).
			// The URL still carries the values for this load.
		}
		url.searchParams.delete('session')
		url.searchParams.delete('room')
		window.history.replaceState({}, '', url.toString())
		return { room: urlRoom, session: urlSession }
	}
	try {
		const room = window.sessionStorage.getItem(ROOM_STORAGE_KEY)
		const session = window.sessionStorage.getItem(SESSION_STORAGE_KEY)
		if (room && session) return { room, session }
	} catch {
		// ignore
	}
	return null
}

export function App() {
	const [connectors, setConnectors] = useState<readonly ConnectorTile[]>([])
	const [approvals, setApprovals] = useState<readonly ApprovalCard[]>([])
	const [liveEvents, setLiveEvents] = useState<readonly RunEventPayload[]>([])
	const [realtimeStatus, setRealtimeStatus] = useState<'connected' | 'disconnected'>(
		'connected'
	)
	const [activeTool, setActiveTool] = useState<string>('select')
	const [zoomPercent] = useState<number>(100)
	const [density, setDensity] = useState<'compact' | 'full'>('full')
	const [selectedRunId, setSelectedRunId] = useState<string | null>(null)

	const realtime = useMemo(() => intakeAndStashCredentials(), [])

	useEffect(() => {
		if (!realtime) return
		const client = new RoomEventClient({
			url: `${ORCHESTRATOR_URL}/api/sync/${encodeURIComponent(realtime.room)}`,
			tokenFactory: async () => {
				const res = await fetch(`${ORCHESTRATOR_URL}/api/auth/sse-token`, {
					method: 'POST',
					credentials: 'include',
					headers: {
						authorization: `Bearer ${realtime.session}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({ room_id: realtime.room }),
				})
				if (!res.ok) throw new Error(`sse-token mint failed: ${res.status}`)
				const body = (await res.json()) as { token: string }
				return body.token
			},
			onEvent: (event) => {
				setLiveEvents((prev) => {
					const next = [...prev, event]
					return next.length > MAX_LIVE_EVENTS ? next.slice(-MAX_LIVE_EVENTS) : next
				})
			},
			maxConsecutiveFailures: MAX_RECONNECT_ATTEMPTS,
			onGiveUp: () => setRealtimeStatus('disconnected'),
		})
		return () => client.close()
	}, [realtime])

	function handleConnect(provider: StarterProvider) {
		setConnectors((prev) => [
			...prev,
			{ id: provider, label: providerLabel(provider), status: 'connected' },
		])
		setApprovals([
			{
				id: 'demo_approval',
				run_id: 'run_demo',
				run_title: 'PR #4521 · add user export',
				tool_name: 'vercel.promote_to_production',
				tool_description:
					'Promote the preview deployment to the production alias. Irreversible.',
				safety: 'irreversible',
				proposed_at: new Date().toISOString(),
			},
		])
	}

	// Synthesise left-rail rows from current state.
	const workflowItems: readonly RailItem[] = useMemo(
		() =>
			connectors.map((c) => ({
				id: `wf:${c.id}`,
				label: `${c.label} workflow`,
				sublabel: 'no runs yet',
			})),
		[connectors]
	)

	const runItems: readonly RailItem[] = useMemo(() => {
		const byRun = new Map<string, { count: number; lastKind: string; isLive: boolean }>()
		for (const e of liveEvents) {
			const cur = byRun.get(e.run_id) ?? { count: 0, lastKind: e.kind, isLive: false }
			cur.count += 1
			cur.lastKind = e.kind
			cur.isLive = e.kind === 'running' || e.kind === 'progress'
			byRun.set(e.run_id, cur)
		}
		return Array.from(byRun.entries()).map(([run_id, s]) => ({
			id: run_id,
			label: run_id,
			sublabel: `${s.count} events · ${s.lastKind}`,
			isLive: s.isLive,
		}))
	}, [liveEvents])

	const hasAnyConnector = connectors.length > 0
	const showEmptyState = !hasAnyConnector && !realtime

	const rightRailMode: RightRailMode = selectedRunId
		? 'inspector'
		: liveEvents.length > 0 || approvals.length > 0
			? 'activity'
			: 'empty'

	return (
		<Shell
			topBar={
				<TopBar
					workspaceName="Untitled workspace"
					breadcrumbs={['canvas', 'starter']}
					presenceAvatars={[{ id: 'u_anu', label: 'Anu', color: 'var(--accent)' }]}
					spend={<SpendIndicator accrued_micros={3_420_000} ceiling_micros={50_000_000} />}
				/>
			}
			leftRail={
				<>
					<LeftRail
						workflows={workflowItems}
						runs={runItems}
						selectedId={selectedRunId}
						onSelect={setSelectedRunId}
					/>
					<ConnectorStrip
						tiles={connectors}
						onClick={() => {
							/* connector settings — wire in a follow-up */
						}}
					/>
				</>
			}
			rightRail={
				<RightRail
					mode={rightRailMode}
					inspectorContent={
						selectedRunId ? (
							<InspectorPlaceholder runId={selectedRunId} events={liveEvents} />
						) : null
					}
					activityEvents={liveEvents}
					approvalsContent={
						<ApprovalInbox
							cards={approvals}
							onApprove={(card) =>
								setApprovals((p) => p.filter((c) => c.id !== card.id))
							}
							onReject={(card) =>
								setApprovals((p) => p.filter((c) => c.id !== card.id))
							}
						/>
					}
				/>
			}
			overlays={
				!showEmptyState ? (
					<>
						<FloatingToolbar tools={TOOLS} activeId={activeTool} onSelect={setActiveTool} />
						<ZoomCluster
							zoomPercent={zoomPercent}
							density={density}
							onDensityToggle={() =>
								setDensity((d) => (d === 'compact' ? 'full' : 'compact'))
							}
						/>
						{realtimeStatus === 'disconnected' && <DisconnectedBanner />}
					</>
				) : null
			}
		>
			{showEmptyState ? (
				<EmptyState onConnect={handleConnect} />
			) : (
				<Tldraw shapeUtils={SHAPE_UTILS} />
			)}
		</Shell>
	)
}

/**
 * Disconnected banner — fires once the RoomEventClient gives up on
 * reconnecting. Tells the user the live feed stopped and offers a
 * single reload affordance. Auto-reload is deliberately avoided
 * because the user may be mid-edit.
 */
function DisconnectedBanner() {
	return (
		<aside
			role="alert"
			style={{
				position: 'absolute',
				top: 'var(--space-3)',
				right: 'var(--space-3)',
				padding: 'var(--space-2) var(--space-3)',
				background: 'var(--live-soft)',
				border: '1px solid var(--live)',
				borderRadius: 'var(--radius-md)',
				fontSize: 'var(--font-12)',
				color: 'var(--text-strong)',
				zIndex: 'var(--z-floating)',
				maxWidth: 320,
				boxShadow: 'var(--shadow-floating)',
				display: 'grid',
				gap: 2,
			}}
		>
			<strong style={{ fontSize: 'var(--font-13)' }}>Live feed disconnected.</strong>
			<span style={{ color: 'var(--text-muted)' }}>
				Canvas is still editable.{' '}
				<button
					type="button"
					onClick={() => window.location.reload()}
					style={{
						background: 'transparent',
						border: 'none',
						color: 'var(--accent)',
						cursor: 'pointer',
						padding: 0,
						font: 'inherit',
						fontFamily: 'var(--font-ui)',
						textDecoration: 'underline',
					}}
				>
					Reload to reconnect
				</button>
			</span>
		</aside>
	)
}

/**
 * Minimal inspector body until a real shape inspector lands in a
 * follow-up. Shows the run id and a short event history so the
 * right rail isn't empty when something is selected.
 */
function InspectorPlaceholder({
	runId,
	events,
}: {
	runId: string
	events: readonly RunEventPayload[]
}) {
	const runEvents = events.filter((e) => e.run_id === runId).slice(-10)
	return (
		<div style={{ padding: 'var(--space-3)', display: 'grid', gap: 'var(--space-3)' }}>
			<div style={{ display: 'grid', gap: 2 }}>
				<div
					style={{
						fontSize: 11,
						color: 'var(--text-muted)',
						textTransform: 'uppercase',
						letterSpacing: 0.6,
					}}
				>
					Run id
				</div>
				<div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-13)' }}>{runId}</div>
			</div>
			{runEvents.length > 0 && (
				<div style={{ display: 'grid', gap: 2 }}>
					<div
						style={{
							fontSize: 11,
							color: 'var(--text-muted)',
							textTransform: 'uppercase',
							letterSpacing: 0.6,
						}}
					>
						Recent events
					</div>
					<ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 2 }}>
						{runEvents.map((e) => (
							<li
								key={e.seq}
								style={{
									fontFamily: 'var(--font-mono)',
									fontSize: 'var(--font-12)',
									color: 'var(--text-strong)',
								}}
							>
								#{e.seq} {e.kind}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	)
}

function providerLabel(p: StarterProvider): string {
	switch (p) {
		case 'github':
			return 'GitHub'
		case 'linear':
			return 'Linear'
		case 'slack':
			return 'Slack'
		case 'vercel':
			return 'Vercel'
	}
}
