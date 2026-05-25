/**
 * App — the canvas client root.
 *
 * Top-level state machine has four states:
 *
 *   unauthenticated   no session; render <Login>
 *   onboarding        session exists but ONBOARDING_STORAGE_KEY is
 *                     unset; render <OnboardingWizard>
 *   ready             session + onboarded; render the three-zone
 *                     <Shell> with the canvas
 *   disconnected      ready, but the realtime client gave up;
 *                     still render Shell with a DisconnectedBanner
 *
 * The login/onboarding/disconnected states reuse the same dark
 * surface — there is no separate marketing chrome. Sign-in lives at
 * the same origin as the canvas, so the post-login redirect lands
 * on `/` with the session fresh in the URL.
 *
 * Realtime: when the URL carries `?room=<id>&session=<jwt>` the app
 * moves the session JWT into sessionStorage and strips it from the
 * URL via history.replaceState before any other code runs.
 *
 * Orchestrator base URL: VITE_ORCHESTRATOR_URL.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'

import { AgentShapeUtil } from './agent/AgentShapeUtil.js'
import { AgentApi, type AgentApiRecord, AgentApiError } from './agent/agentApi.js'
import { agentShapeId, recordToShapeProps } from './agent/agentToShape.js'
import { NewAgentModal, type NewAgentDraft } from './agent/NewAgentModal.js'
import { ApprovalInbox, type ApprovalCard } from './inbox/ApprovalInbox.js'
import { ConnectorStrip, type ConnectorTile } from './connectors/ConnectorStrip.js'
import { EmptyState, type StarterProvider } from './onboarding/EmptyState.js'
import {
	OnboardingWizard,
	ONBOARDING_STORAGE_KEY,
} from './onboarding/OnboardingWizard.js'
import { Login } from './auth/Login.js'
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
const HANDLE_STORAGE_KEY = 'agent-canvas:handle'

/**
 * 20 attempts (~9.5min at the 30s max-backoff cap) before we give
 * up reconnecting. A phone left on a dead network stops draining
 * battery; the user sees the DisconnectedBanner and decides when
 * to reload.
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
 */
function intakeAndStashCredentials(): {
	room: string
	session: string
	handle: string | null
} | null {
	if (typeof window === 'undefined') return null
	const url = new URL(window.location.href)
	const urlRoom = url.searchParams.get('room')
	const urlSession = url.searchParams.get('session')
	const urlHandle = url.searchParams.get('login_handle')
	if (urlRoom && urlSession) {
		try {
			window.sessionStorage.setItem(SESSION_STORAGE_KEY, urlSession)
			window.sessionStorage.setItem(ROOM_STORAGE_KEY, urlRoom)
			if (urlHandle) window.sessionStorage.setItem(HANDLE_STORAGE_KEY, urlHandle)
		} catch {
			// sessionStorage may be disabled (private mode, sandboxed iframe).
		}
		url.searchParams.delete('session')
		url.searchParams.delete('room')
		url.searchParams.delete('login_provider')
		url.searchParams.delete('login_handle')
		window.history.replaceState({}, '', url.toString())
		return { room: urlRoom, session: urlSession, handle: urlHandle }
	}
	try {
		const room = window.sessionStorage.getItem(ROOM_STORAGE_KEY)
		const session = window.sessionStorage.getItem(SESSION_STORAGE_KEY)
		const handle = window.sessionStorage.getItem(HANDLE_STORAGE_KEY)
		if (room && session) return { room, session, handle }
	} catch {
		// ignore
	}
	return null
}

function readOnboardedFlag(): boolean {
	try {
		return window.localStorage.getItem(ONBOARDING_STORAGE_KEY) === '1'
	} catch {
		return false
	}
}

function readCancelledFlag(): boolean {
	if (typeof window === 'undefined') return false
	return new URL(window.location.href).searchParams.get('auth') === 'cancelled'
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
	const [agentModalOpen, setAgentModalOpen] = useState<boolean>(false)
	const [agents, setAgents] = useState<readonly AgentApiRecord[]>([])
	const [agentError, setAgentError] = useState<string | null>(null)
	const editorRef = useRef<Editor | null>(null)

	const realtime = useMemo(() => intakeAndStashCredentials(), [])
	const [onboarded, setOnboarded] = useState<boolean>(readOnboardedFlag)
	const cancelled = useMemo(() => readCancelledFlag(), [])

	// SSE realtime — only when we have a session.
	useEffect(() => {
		if (!realtime || !onboarded) return
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
	}, [realtime, onboarded])

	// Open the New Agent modal when the user picks the Agent tool.
	useEffect(() => {
		if (activeTool === 'agent') {
			setAgentModalOpen(true)
			setActiveTool('select')
		}
	}, [activeTool])

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

	const agentApi = useMemo(() => {
		if (!realtime) return null
		return new AgentApi({
			baseUrl: ORCHESTRATOR_URL,
			session: realtime.session,
			workspaceId: realtime.room, // current proxy for workspace id; real ws ids land with users table
		})
	}, [realtime])

	// Initial load — fetch agents for this workspace once the session
	// is in place. Errors land in agentError for the toast banner.
	useEffect(() => {
		if (!agentApi || !onboarded) return
		let cancelled = false
		void (async () => {
			try {
				const items = await agentApi.list()
				if (!cancelled) setAgents(items)
			} catch (err) {
				if (cancelled) return
				const msg = err instanceof AgentApiError ? err.message : 'Failed to load agents'
				setAgentError(msg)
			}
		})()
		return () => {
			cancelled = true
		}
	}, [agentApi, onboarded])

	// When the tldraw editor mounts AND we have records, paint them on
	// the canvas. Subsequent record additions go through createAgent.
	const ensureShapesForRecords = useCallback(
		(editor: Editor, records: readonly AgentApiRecord[], roomId: string) => {
			for (const [i, record] of records.entries()) {
				const shapeId = agentShapeId(record.id)
				const existing = editor.getShape(shapeId as never)
				if (existing) continue
				// Lay out new shapes on a soft grid so they don't overlap.
				const col = i % 3
				const row = Math.floor(i / 3)
				editor.createShape({
					id: shapeId as never,
					type: 'agent',
					x: 80 + col * 360,
					y: 80 + row * 180,
					props: recordToShapeProps(record, roomId),
				})
			}
		},
		[]
	)

	useEffect(() => {
		if (!editorRef.current || !realtime) return
		ensureShapesForRecords(editorRef.current, agents, realtime.room)
	}, [agents, realtime, ensureShapesForRecords])

	async function handleCreateAgent(draft: NewAgentDraft) {
		if (!agentApi) return
		setAgentError(null)
		try {
			const created = await agentApi.create(draft)
			setAgents((prev) => [created, ...prev])
			setAgentModalOpen(false)
			// editor effect will pick up the new record on the next paint
		} catch (err) {
			const msg = err instanceof AgentApiError ? err.message : 'Failed to create agent'
			setAgentError(msg)
		}
	}

	const workflowItems: readonly RailItem[] = useMemo(
		() => [
			...agents.map((a) => ({
				id: a.id,
				label: a.name,
				sublabel: capsLineFromRecord(a),
			})),
			...connectors.map((c) => ({
				id: `wf:${c.id}`,
				label: `${c.label} workflow`,
				sublabel: 'no runs yet',
			})),
		],
		[agents, connectors]
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

	// Routing.
	if (!realtime) {
		return <Login orchestratorUrl={ORCHESTRATOR_URL} cancelled={cancelled} />
	}
	if (!onboarded) {
		return (
			<OnboardingWizard
				displayName={realtime.handle ?? undefined}
				onComplete={() => setOnboarded(true)}
				onSkip={() => setOnboarded(true)}
			/>
		)
	}

	const hasAnyConnector = connectors.length > 0
	const hasAnyAgent = agents.length > 0
	const showEmptyState = !hasAnyConnector && !hasAnyAgent

	const rightRailMode: RightRailMode = selectedRunId
		? 'inspector'
		: liveEvents.length > 0 || approvals.length > 0
			? 'activity'
			: 'empty'

	return (
		<>
			<Shell
				topBar={
					<TopBar
						workspaceName={realtime.handle ? `${realtime.handle}'s workspace` : 'Untitled workspace'}
						breadcrumbs={['canvas']}
						presenceAvatars={[
							{
								id: realtime.handle ?? 'u',
								label: realtime.handle ?? 'You',
								color: 'var(--accent)',
							},
						]}
						spend={
							<SpendIndicator accrued_micros={3_420_000} ceiling_micros={50_000_000} />
						}
					/>
				}
				leftRail={
					<>
						<LeftRail
							workflows={workflowItems}
							runs={runItems}
							selectedId={selectedRunId}
							onSelect={setSelectedRunId}
							onNewWorkflow={() => setAgentModalOpen(true)}
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
							<FloatingToolbar
								tools={TOOLS}
								activeId={activeTool}
								onSelect={setActiveTool}
							/>
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
					<Tldraw
						shapeUtils={SHAPE_UTILS}
						onMount={(editor) => {
							editorRef.current = editor
							if (realtime) {
								ensureShapesForRecords(editor, agents, realtime.room)
							}
						}}
					/>
				)}
			</Shell>
			{agentError && (
				<aside
					role="alert"
					style={{
						position: 'fixed',
						bottom: 'var(--space-3)',
						left: 'var(--space-3)',
						padding: 'var(--space-2) var(--space-3)',
						background: 'var(--live-soft)',
						border: '1px solid var(--live)',
						borderRadius: 'var(--radius-md)',
						fontSize: 'var(--font-12)',
						color: 'var(--text-strong)',
						zIndex: 'var(--z-floating)',
						boxShadow: 'var(--shadow-floating)',
						maxWidth: 420,
					}}
				>
					<strong>{agentError}</strong>
					<button
						type="button"
						onClick={() => setAgentError(null)}
						style={{
							marginLeft: 'var(--space-2)',
							background: 'transparent',
							border: 'none',
							color: 'var(--text-muted)',
							cursor: 'pointer',
						}}
					>
						×
					</button>
				</aside>
			)}

			<NewAgentModal
				open={agentModalOpen}
				onCreate={handleCreateAgent}
				onClose={() => setAgentModalOpen(false)}
			/>
		</>
	)
}

function capsLineFromRecord(a: AgentApiRecord): string {
	const c = a.capabilities
	const bits: string[] = []
	if (c.computer_use.enabled) bits.push('computer')
	if (c.browser_use.enabled) bits.push('browser')
	if (c.mcp_servers.length > 0) bits.push(`${c.mcp_servers.length} MCP`)
	return bits.length > 0 ? bits.join(' · ') : a.purpose || 'no capabilities'
}

/**
 * Disconnected banner — fires once the RoomEventClient gives up.
 * Tells the user the live feed stopped and offers a single reload
 * affordance. Auto-reload is avoided because the user may be mid-edit.
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
 * Minimal inspector body. Shows the run id and a short event
 * history; richer per-shape inspector lands in a follow-up.
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
