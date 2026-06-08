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
 * @author asigdel29
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasController, CanvasTool, PresencePeer } from './canvas/CanvasStage.js'

// The canvas surface loads on demand so the sign-in / onboarding path
// ships none of it; see canvas/CanvasStage.
const CanvasStage = lazy(() => import('./canvas/CanvasStage.js'))

import {
	AgentApi,
	type AgentApiRecord,
	AgentApiError,
	type PendingApprovalDto,
} from './agent/agentApi.js'
import { agentShapeId, recordToShapeProps } from './agent/agentToShape.js'
import { ErrorToast, type ErrorCard } from './errors/ErrorToast.js'
import { SettingsDrawer } from './settings/SettingsDrawer.js'
import { FeedbackModal } from './feedback/FeedbackModal.js'
import { track } from './analytics/posthog.js'
import { LegalPage } from './legal/LegalPage.js'
import { TERMS_OF_SERVICE, PRIVACY_POLICY } from './legal/legalContent.js'
import { WorkspaceSwitcher } from './workspaces/WorkspaceSwitcher.js'
import { MembersPage } from './workspaces/MembersPage.js'
import { NewAgentModal, type NewAgentDraft } from './agent/NewAgentModal.js'
import { ApprovalInbox, type ApprovalCard } from './inbox/ApprovalInbox.js'
import { ConnectorStrip, type ConnectorTile } from './connectors/ConnectorStrip.js'
import { EmptyState, type StarterProvider } from './onboarding/EmptyState.js'
import {
	OnboardingWizard,
	ONBOARDING_STORAGE_KEY,
} from './onboarding/OnboardingWizard.js'
import { Login } from './auth/Login.js'
import { ShareModal } from './share/ShareModal.js'
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
import { ORCHESTRATOR_URL } from './config.js'

const MAX_LIVE_EVENTS = 50

const SESSION_STORAGE_KEY = 'agent-canvas:session'
const ROOM_STORAGE_KEY = 'agent-canvas:room'
const HANDLE_STORAGE_KEY = 'agent-canvas:handle'
/** Access level of a share-link session ('viewer' | 'member'); absent for logins. */
const SHARE_ROLE_STORAGE_KEY = 'agent-canvas:share_role'

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

/** The `?share=<token>` value from the URL, if a share link is being opened. */
function readShareTokenFromUrl(): string | null {
	if (typeof window === 'undefined') return null
	return new URL(window.location.href).searchParams.get('share')
}

/** Presence/cursor palette — distinct, legible hues keyed by handle. */
const PRESENCE_COLORS = [
	'#4f8cff',
	'#ff6b9d',
	'#27c498',
	'#f5a623',
	'#a06bff',
	'#ff5d5d',
	'#3ec5d8',
	'#c0ca33',
] as const

/** Deterministically pick a presence colour for a handle. */
function colorForHandle(handle: string): string {
	let hash = 0
	for (let i = 0; i < handle.length; i += 1) hash = (hash * 31 + handle.charCodeAt(i)) | 0
	return PRESENCE_COLORS[Math.abs(hash) % PRESENCE_COLORS.length]!
}

/** The access level of the current share session, if any. */
function readShareRole(): 'viewer' | 'member' | null {
	try {
		const r = window.sessionStorage.getItem(SHARE_ROLE_STORAGE_KEY)
		return r === 'viewer' || r === 'member' ? r : null
	} catch {
		return null
	}
}

function readCancelledFlag(): boolean {
	if (typeof window === 'undefined') return false
	return new URL(window.location.href).searchParams.get('auth') === 'cancelled'
}

export function App() {
	const [connectors, setConnectors] = useState<readonly ConnectorTile[]>([])
	const [liveEvents, setLiveEvents] = useState<readonly RunEventPayload[]>([])
	const [realtimeStatus, setRealtimeStatus] = useState<'connected' | 'disconnected'>(
		'connected'
	)
	const [activeTool, setActiveTool] = useState<string>('select')
	const [zoomPercent, setZoomPercent] = useState<number>(100)
	// When true the zoom cluster forces every card full; otherwise the
	// canvas collapses crowded cards automatically (density).
	const [forceExpand, setForceExpand] = useState<boolean>(false)
	const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
	const [settingsOpen, setSettingsOpen] = useState<boolean>(false)
	const [feedbackOpen, setFeedbackOpen] = useState<boolean>(false)
	const [shareOpen, setShareOpen] = useState<boolean>(false)
	const [presencePeers, setPresencePeers] = useState<readonly PresencePeer[]>([])
	const [agentModalOpen, setAgentModalOpen] = useState<boolean>(false)
	const [agentModalInitial, setAgentModalInitial] = useState<NewAgentDraft | null>(null)
	const [agentModalEditingId, setAgentModalEditingId] = useState<string | null>(null)
	const [agents, setAgents] = useState<readonly AgentApiRecord[]>([])
	const [errorCards, setErrorCards] = useState<readonly ErrorCard[]>([])
	const [liveApprovals, setLiveApprovals] = useState<readonly PendingApprovalDto[]>([])
	const editorRef = useRef<CanvasController | null>(null)

	const pushError = useCallback((card: Omit<ErrorCard, 'id'>) => {
		const id = `e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
		setErrorCards((prev) => [...prev, { ...card, id }])
	}, [])
	const dismissError = useCallback((id: string) => {
		setErrorCards((prev) => prev.filter((c) => c.id !== id))
	}, [])

	const [realtime, setRealtime] = useState(() => intakeAndStashCredentials())
	const [onboarded, setOnboarded] = useState<boolean>(readOnboardedFlag)
	const cancelled = useMemo(() => readCancelledFlag(), [])

	// Read-only when this session came from a "view" share link. The
	// gate is informational for the UI; the orchestrator independently
	// enforces the granted role on every mutating call.
	const [shareRole, setShareRole] = useState<'viewer' | 'member' | null>(readShareRole)
	const readOnly = shareRole === 'viewer'

	// Share-link intake. When the URL carries `?share=<token>` and we
	// have no session yet, redeem it for a scoped session, stash it like
	// a login, and drop the token from the URL. Share visitors skip
	// onboarding. Runs once on mount.
	const [shareBooting, setShareBooting] = useState<boolean>(
		() => !intakeAndStashCredentials() && Boolean(readShareTokenFromUrl())
	)
	const [shareFailed, setShareFailed] = useState<boolean>(false)
	useEffect(() => {
		if (realtime) return
		const token = readShareTokenFromUrl()
		if (!token) return
		let cancelledRedeem = false
		void (async () => {
			try {
				const res = await fetch(`${ORCHESTRATOR_URL}/api/share/redeem`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ token }),
				})
				if (!res.ok) throw new Error('redeem_failed')
				const body = (await res.json()) as {
					session: string
					room: string
					role: 'viewer' | 'member'
				}
				if (cancelledRedeem) return
				try {
					window.sessionStorage.setItem(SESSION_STORAGE_KEY, body.session)
					window.sessionStorage.setItem(ROOM_STORAGE_KEY, body.room)
					window.sessionStorage.setItem(SHARE_ROLE_STORAGE_KEY, body.role)
				} catch {
					// sessionStorage disabled; the session still lives in state.
				}
				const url = new URL(window.location.href)
				url.searchParams.delete('share')
				window.history.replaceState({}, '', url.toString())
				setShareRole(body.role)
				setRealtime({ room: body.room, session: body.session, handle: null })
				setOnboarded(true)
			} catch {
				if (!cancelledRedeem) setShareFailed(true)
			} finally {
				if (!cancelledRedeem) setShareBooting(false)
			}
		})()
		return () => {
			cancelledRedeem = true
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// First mount with a real session counts as a completed login.
	// Fires once per fresh tab; intakeAndStashCredentials strips the
	// URL params, so a refresh re-uses sessionStorage and doesn't
	// re-fire.
	useEffect(() => {
		if (realtime) track('login_completed', { has_handle: Boolean(realtime.handle) })
	}, [realtime])

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
	// Read-only (view-share) sessions cannot create agents.
	useEffect(() => {
		if (activeTool === 'agent') {
			if (!readOnly) setAgentModalOpen(true)
			setActiveTool('select')
		}
	}, [activeTool, readOnly])

	function handleConnect(provider: StarterProvider) {
		setConnectors((prev) => [
			...prev,
			{ id: provider, label: providerLabel(provider), status: 'connected' },
		])
	}

	// Effective workspace id. Defaults to the realtime room id (the
	// auth callback puts the user's solo workspace there); the
	// WorkspaceSwitcher writes the chosen workspace into sessionStorage
	// so a reload remembers it.
	const [workspaceOverride, setWorkspaceOverride] = useState<string | null>(() => {
		if (typeof window === 'undefined') return null
		return window.sessionStorage.getItem('ac.workspace_id')
	})
	const effectiveWorkspaceId = workspaceOverride ?? realtime?.room ?? ''

	const agentApi = useMemo(() => {
		if (!realtime || !effectiveWorkspaceId) return null
		return new AgentApi({
			baseUrl: ORCHESTRATOR_URL,
			session: realtime.session,
			workspaceId: effectiveWorkspaceId,
		})
	}, [realtime, effectiveWorkspaceId])

	// Initial load — fetch agents for this workspace once the session
	// is in place. Errors land as structured toast cards.
	useEffect(() => {
		if (!agentApi || !onboarded) return
		let cancelled = false
		void (async () => {
			try {
				const items = await agentApi.list()
				if (!cancelled) setAgents(items)
			} catch (err) {
				if (cancelled) return
				pushError(toErrorCard(err, 'list agents', () => setSettingsOpen(true)))
			}
		})()
		return () => {
			cancelled = true
		}
	}, [agentApi, onboarded])

	// When the canvas mounts AND we have records, paint them on the
	// canvas. Subsequent record additions go through createAgent.
	const ensureShapesForRecords = useCallback(
		(editor: CanvasController, records: readonly AgentApiRecord[], roomId: string) => {
			// Place each new card in the next free grid slot after the cards
			// already present, so incremental creation never stacks shapes.
			// A saved per-workspace layout overrides this in the store.
			let slot = editor.getShapeCount()
			for (const record of records) {
				const shapeId = agentShapeId(record.id)
				if (editor.getShape(shapeId as never)) continue
				const col = slot % 3
				const row = Math.floor(slot / 3)
				slot += 1
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

	// Forward computer_screenshot events from the SSE bus into the
	// matching AgentShape's last_screenshot_data_uri prop. The shape
	// renders the thumbnail on the next paint.
	useEffect(() => {
		const editor = editorRef.current
		if (!editor) return
		const latest = liveEvents.slice(-5).filter((e) => e.kind === 'computer_screenshot')
		for (const e of latest) {
			const agentId = (e.payload as { agent_id?: string }).agent_id
			const dataUri = (e.payload as { data_uri?: string }).data_uri
			if (!agentId || !dataUri) continue
			const shapeId = agentShapeId(agentId)
			const existing = editor.getShape(shapeId as never)
			if (!existing) continue
			editor.updateShape({
				id: shapeId as never,
				type: 'agent',
				props: {
					last_screenshot_data_uri: dataUri,
					last_event_seq: e.seq,
					last_event_at: e.ts,
				},
			})
		}
	}, [liveEvents])

	// Track run terminal states from SSE so the funnel sees
	// run_succeeded vs run_failed without polling.
	useEffect(() => {
		const last = liveEvents[liveEvents.length - 1]
		if (!last) return
		if (last.kind === 'run_succeeded') {
			track('run_succeeded', {
				run_id: last.run_id,
				iterations: Number((last.payload as { iterations?: number }).iterations ?? 0),
			})
		} else if (last.kind === 'run_failed' || last.kind === 'run_cancelled') {
			track('run_failed', {
				run_id: last.run_id,
				kind: last.kind,
			})
		}
	}, [liveEvents])

	/**
	 * Forward orchestrator-side warnings published on the SSE bus
	 * into the error toast queue. Previously these events landed in
	 * liveEvents and were never surfaced.
	 *
	 * Three kinds today:
	 *   computer_use_unavailable  agent enabled computer_use but
	 *                             E2B_API_KEY isn't configured
	 *   mcp_connect_failed        one of the MCP servers refused
	 *                             the connection at run start
	 *   webhook_signature_failed  inbound webhook arrived with a
	 *                             bad signature (probably a misconfig)
	 *
	 * The handler reads the last few events and dedupes by event
	 * payload so a single bad config doesn't pile up dozens of toasts.
	 */
	useEffect(() => {
		const recentBackendWarnings = liveEvents.slice(-20).filter((e) =>
			e.kind === 'computer_use_unavailable' ||
			e.kind === 'mcp_connect_failed' ||
			e.kind === 'webhook_signature_failed'
		)
		if (recentBackendWarnings.length === 0) return
		const seenKey = (e: RunEventPayload): string =>
			`${e.kind}:${(e.payload as { server_id?: string }).server_id ?? ''}`
		const newCards: ErrorCard[] = []
		const known = new Set(errorCards.map((c) => c.id))
		for (const e of recentBackendWarnings) {
			const id = seenKey(e)
			if (known.has(id)) continue
			known.add(id)
			newCards.push(translateBackendEvent(e, id))
		}
		if (newCards.length > 0) {
			setErrorCards((prev) => [...prev, ...newCards])
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [liveEvents])

	async function handleCreateAgent(draft: NewAgentDraft) {
		if (!agentApi) return
		try {
			const created = await agentApi.create(draft)
			setAgents((prev) => [created, ...prev])
			setAgentModalOpen(false)
			track('agent_created', {
				model: draft.model,
				computer_use: draft.capabilities.computer_use.enabled,
				browser_use: draft.capabilities.browser_use.enabled,
				mcp_servers: draft.capabilities.mcp_servers.length,
			})
			// editor effect will pick up the new record on the next paint
		} catch (err) {
			pushError(toErrorCard(err, 'create agent', () => setSettingsOpen(true)))
		}
	}

	/**
	 * Fire a run for the supplied agent. Returns immediately; the
	 * results stream in over SSE and update the AgentShape's
	 * status field through the existing event subscriber.
	 */
	function handleOpenEdit(agent: AgentApiRecord) {
		setAgentModalEditingId(agent.id)
		setAgentModalInitial({
			name: agent.name,
			purpose: agent.purpose,
			provider: (agent.provider as NewAgentDraft['provider']) ?? 'anthropic',
			model: agent.model,
			model_base_url: agent.model_base_url ?? null,
			system_prompt: agent.system_prompt,
			capabilities: agent.capabilities,
		})
		setAgentModalOpen(true)
	}

	async function handleSaveAgent(draft: NewAgentDraft) {
		if (!agentApi || !agentModalEditingId) return
		try {
			const updated = await agentApi.update(agentModalEditingId, draft)
			setAgents((prev) =>
				prev.map((a) => (a.id === updated.id ? updated : a))
			)
			setAgentModalOpen(false)
			setAgentModalEditingId(null)
			setAgentModalInitial(null)
			// Refresh the shape on the canvas with the new capability
			// chips + cap_summary so the visible state matches the record.
			const editor = editorRef.current
			if (editor && realtime) {
				const shapeId = agentShapeId(updated.id)
				if (editor.getShape(shapeId as never)) {
					editor.updateShape({
						id: shapeId as never,
						type: 'agent',
						props: recordToShapeProps(updated, realtime.room),
					})
				}
			}
		} catch (err) {
			pushError(toErrorCard(err, 'save agent', () => setSettingsOpen(true)))
		}
	}

	async function handleRunAgent(agentId: string, initialMessage: string) {
		if (!agentApi) return
		try {
			await agentApi.startRun({ agent_id: agentId, initial_message: initialMessage })
			track('run_started', {
				agent_id: agentId,
				message_len: initialMessage.length,
			})
		} catch (err) {
			pushError(toErrorCard(err, 'start run', () => setSettingsOpen(true)))
		}
	}

	// Pending approvals refreshed on every SSE approval_required event
	// plus an initial fetch on mount. The fetch covers approvals that
	// landed before the SSE connection opened.
	useEffect(() => {
		if (!agentApi || !onboarded) return
		let cancelled = false
		void (async () => {
			try {
				const items = await agentApi.listApprovals()
				if (!cancelled) setLiveApprovals(items)
			} catch {
				// best-effort — surface in agentError if it matters
			}
		})()
		return () => {
			cancelled = true
		}
	}, [agentApi, onboarded])

	// React to approval_required events on the SSE stream by re-fetching
	// the pending list. Cheap because we throttle to the last event of
	// each render tick — every approval_required produces exactly one
	// refetch within ~16ms.
	useEffect(() => {
		if (!agentApi) return
		const hasNewApprovalEvent = liveEvents
			.slice(-10)
			.some((e) => e.kind === 'approval_required')
		if (!hasNewApprovalEvent) return
		let cancelled = false
		void (async () => {
			try {
				const items = await agentApi.listApprovals()
				if (!cancelled) setLiveApprovals(items)
			} catch {
				/* swallow */
			}
		})()
		return () => {
			cancelled = true
		}
	}, [liveEvents, agentApi])

	async function handleResolveApproval(
		approvalId: string,
		resolution: 'approved' | 'rejected'
	) {
		if (!agentApi) return
		try {
			await agentApi.resolveApproval(approvalId, resolution)
			setLiveApprovals((prev) => prev.filter((a) => a.id !== approvalId))
		} catch (err) {
			pushError(toErrorCard(err, 'resolve approval', () => setSettingsOpen(true)))
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

	// Translate the API-shape PendingApprovalDto into the
	// ApprovalCard shape the inbox renders.
	const approvalCards: readonly ApprovalCard[] = useMemo(
		() =>
			liveApprovals.map((a) => {
				const agent = agents.find((ag) => ag.id === a.agent_id)
				return {
					id: a.id,
					run_id: a.run_id,
					run_title: agent ? agent.name : a.agent_id,
					tool_name: a.tool_name,
					tool_description: a.tool_description,
					safety: a.safety,
					proposed_at: a.requested_at,
				}
			}),
		[liveApprovals, agents]
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

	// Path-level routing. The canvas is otherwise a SPA at /, but
	// /tos and /privacy render standalone legal pages so a crawler
	// or a 'view the terms' deep link lands somewhere readable.
	const pathname = typeof window !== 'undefined' ? window.location.pathname : '/'
	if (pathname === '/tos') {
		return <LegalPage title="Terms of Service" markdown={TERMS_OF_SERVICE} />
	}
	if (pathname === '/privacy') {
		return <LegalPage title="Privacy Policy" markdown={PRIVACY_POLICY} />
	}
	if (pathname === '/workspace/members' && realtime) {
		return (
			<MembersPage
				orchestratorUrl={ORCHESTRATOR_URL}
				session={realtime.session}
				workspaceId={effectiveWorkspaceId}
				currentUserId={realtime.handle ?? ''}
				onBack={() => {
					window.history.pushState({}, '', '/')
					window.location.reload()
				}}
			/>
		)
	}

	// Routing.
	if (!realtime) {
		if (shareBooting) return <FullScreenNotice title="Opening shared canvas…" />
		if (shareFailed) {
			return (
				<FullScreenNotice
					title="This link isn't valid."
					detail="It may have been revoked or expired. Ask whoever shared it for a new one."
				/>
			)
		}
		return <Login orchestratorUrl={ORCHESTRATOR_URL} cancelled={cancelled} />
	}
	if (!onboarded) {
		return (
			<OnboardingWizard
				displayName={realtime.handle ?? undefined}
				onComplete={(result) => {
					track('onboarding_step_done', {
						providers: result.providers.length,
					})
					setOnboarded(true)
				}}
				onSkip={() => {
					track('onboarding_skipped')
					setOnboarded(true)
				}}
			/>
		)
	}

	const hasAnyConnector = connectors.length > 0
	const hasAnyAgent = agents.length > 0
	const showEmptyState = !hasAnyConnector && !hasAnyAgent

	const rightRailMode: RightRailMode = settingsOpen
		? 'settings'
		: selectedRunId
			? 'inspector'
			: liveEvents.length > 0 || liveApprovals.length > 0
				? 'activity'
				: 'empty'

	return (
		<>
			<Shell
				topBar={
					<TopBar
						workspaceName={
							<WorkspaceSwitcher
								orchestratorUrl={ORCHESTRATOR_URL}
								session={realtime.session}
								currentWorkspaceId={effectiveWorkspaceId}
								onSwitch={(id) => {
									window.sessionStorage.setItem('ac.workspace_id', id)
									setWorkspaceOverride(id)
								}}
								onOpenMembers={() => {
									window.history.pushState({}, '', '/workspace/members')
									window.location.reload()
								}}
							/>
						}
						breadcrumbs={readOnly ? ['canvas', 'view only'] : ['canvas']}
						presenceAvatars={
							presencePeers.length > 0
								? presencePeers.map((p) => ({ id: p.id, label: p.label, color: p.color }))
								: [
										{
											id: realtime.handle ?? 'u',
											label: realtime.handle ?? 'You',
											color: colorForHandle(realtime.handle ?? 'You'),
										},
									]
						}
						onSettingsClick={() => {
							setSettingsOpen((s) => {
								if (!s) track('settings_opened')
								return !s
							})
						}}
						onFeedbackClick={() => setFeedbackOpen(true)}
						{...(readOnly ? {} : { onShareClick: () => setShareOpen(true) })}
					/>
				}
				leftRail={
					<>
						<LeftRail
							workflows={workflowItems}
							runs={runItems}
							selectedId={selectedRunId}
							onSelect={setSelectedRunId}
							{...(readOnly ? {} : { onNewWorkflow: () => setAgentModalOpen(true) })}
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
								<SelectionInspector
								selectedId={selectedRunId}
								agents={agents}
								events={liveEvents}
								onRun={(agentId, message) => handleRunAgent(agentId, message)}
								onEdit={(agent) => handleOpenEdit(agent)}
							/>
							) : null
						}
						activityEvents={liveEvents}
						approvalsContent={
							<ApprovalInbox
								cards={approvalCards}
								onApprove={(card) => handleResolveApproval(card.id, 'approved')}
								onReject={(card) => handleResolveApproval(card.id, 'rejected')}
							/>
						}
						settingsContent={
							<SettingsDrawer
								onClose={() => setSettingsOpen(false)}
								orchestratorUrl={ORCHESTRATOR_URL}
								session={realtime.session}
								onSave={(v) => {
									track('settings_saved', {
										has_anthropic: Boolean(v.anthropic_api_key),
										has_e2b: Boolean(v.e2b_api_key),
									})
									// Dismiss the anthropic_not_configured warning if it
									// was the active error; the next run will use the
									// new key from the header.
									setErrorCards((prev) =>
										prev.filter(
											(c) =>
												!c.title.includes("couldn't") &&
												!c.title.includes('disabled')
										)
									)
								}}
							/>
						}
					/>
				}
				overlays={
					<>
						{/*
						 * FloatingToolbar always renders so the user can create
						 * an agent from any state, including the empty canvas.
						 * Before this change, an empty-state canvas hid the
						 * toolbar, forcing users to first fake-click a
						 * connector tile before they could find the Agent tool.
						 */}
						<FloatingToolbar
							tools={TOOLS}
							activeId={activeTool}
							onSelect={setActiveTool}
						/>
						{!showEmptyState && (
							<ZoomCluster
								zoomPercent={zoomPercent}
								density={forceExpand ? 'full' : 'compact'}
								onZoomIn={() => editorRef.current?.zoomIn()}
								onZoomOut={() => editorRef.current?.zoomOut()}
								onZoomFit={() => editorRef.current?.zoomToFit()}
								onDensityToggle={() => setForceExpand((v) => !v)}
							/>
						)}
						{realtimeStatus === 'disconnected' && <DisconnectedBanner />}
					</>
				}
			>
				{showEmptyState ? (
					<EmptyState
						onConnect={(provider) => {
							if (readOnly) return
							handleConnect(provider)
						}}
						onCreateAgent={() => {
							if (readOnly) return
							setAgentModalInitial(null)
							setAgentModalOpen(true)
						}}
						onPickStarter={(starter) => {
							if (readOnly) return
							setAgentModalInitial(starter.draft)
							setAgentModalOpen(true)
							track('agent_starter_picked', { starter_id: starter.id })
						}}
					/>
				) : (
					<Suspense fallback={<CanvasLoading />}>
						<CanvasStage
							workspaceId={realtime.room}
							tool={(activeTool === 'hand' ? 'hand' : 'select') as CanvasTool}
							forceExpand={forceExpand}
							orchestratorUrl={ORCHESTRATOR_URL}
							session={realtime.session}
							userLabel={realtime.handle ?? 'You'}
							userColor={colorForHandle(realtime.handle ?? 'You')}
							readOnly={readOnly}
							onPresenceChange={setPresencePeers}
							onCameraChange={setZoomPercent}
							onShapeClick={(agentId) => {
								const record = agents.find((a) => a.id === agentId)
								if (record) handleOpenEdit(record)
							}}
							onMount={(editor) => {
								editorRef.current = editor
								if (realtime) {
									ensureShapesForRecords(editor, agents, realtime.room)
								}
							}}
						/>
					</Suspense>
				)}
			</Shell>
			<ErrorToast cards={errorCards} onDismiss={dismissError} />

			<NewAgentModal
				open={agentModalOpen}
				initialDraft={agentModalInitial}
				editingAgentId={agentModalEditingId}
				onCreate={handleCreateAgent}
				onSave={handleSaveAgent}
				onClose={() => {
					setAgentModalOpen(false)
					setAgentModalInitial(null)
					setAgentModalEditingId(null)
				}}
			/>
			<FeedbackModal
				open={feedbackOpen}
				recentEvents={liveEvents.slice(-20) as unknown as Record<string, unknown>[]}
				onClose={() => setFeedbackOpen(false)}
			/>
			<ShareModal
				open={shareOpen}
				orchestratorUrl={ORCHESTRATOR_URL}
				session={realtime.session}
				workspaceId={effectiveWorkspaceId}
				onClose={() => setShareOpen(false)}
			/>
		</>
	)
}

/**
 * Full-screen centered message on the app surface. Used for the brief
 * states that precede a session: redeeming a share link, or a share
 * link that turned out to be invalid.
 */
function FullScreenNotice({ title, detail }: { title: string; detail?: string }) {
	return (
		<div
			role="status"
			style={{
				position: 'fixed',
				inset: 0,
				display: 'grid',
				placeItems: 'center',
				background: 'var(--surface)',
				color: 'var(--text-strong)',
				padding: 'var(--space-5)',
				fontFamily: 'var(--font-ui)',
			}}
		>
			<div style={{ display: 'grid', gap: 'var(--space-2)', textAlign: 'center', maxWidth: 420 }}>
				<span style={{ fontSize: 'var(--font-16)', fontWeight: 500 }}>{title}</span>
				{detail && (
					<span style={{ fontSize: 'var(--font-13)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
						{detail}
					</span>
				)}
			</div>
		</div>
	)
}

/**
 * Placeholder shown while the lazily-loaded canvas chunk downloads.
 * Fills the canvas area on the app's dark surface so the layout does
 * not jump when the canvas mounts.
 */
function CanvasLoading() {
	return (
		<div
			role="status"
			aria-label="Loading the canvas"
			style={{
				position: 'absolute',
				inset: 0,
				display: 'grid',
				placeItems: 'center',
				background: 'var(--surface)',
				color: 'var(--text-muted)',
				fontSize: 'var(--font-13)',
			}}
		>
			Loading canvas…
		</div>
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
 * SelectionInspector — branches on what the LeftRail row id means:
 *
 *   Agent id    (starts with `ag_`)     → AgentRunPanel: instructions
 *                                          textarea, Run button, recent
 *                                          events for any of this agent's
 *                                          runs.
 *   Run id      (starts with `run_`)    → RunDetailPanel: live event
 *                                          history for that specific run.
 *   Unknown                              → empty.
 */
function SelectionInspector({
	selectedId,
	agents,
	events,
	onRun,
	onEdit,
}: {
	selectedId: string
	agents: readonly AgentApiRecord[]
	events: readonly RunEventPayload[]
	onRun: (agentId: string, message: string) => void
	onEdit?: (agent: AgentApiRecord) => void
}) {
	const agent = agents.find((a) => a.id === selectedId)
	if (agent) {
		return (
			<AgentRunPanel agent={agent} events={events} onRun={onRun} onEdit={onEdit} />
		)
	}
	return <RunDetailPanel runId={selectedId} events={events} />
}

function AgentRunPanel({
	agent,
	events,
	onRun,
	onEdit,
}: {
	agent: AgentApiRecord
	events: readonly RunEventPayload[]
	onRun: (agentId: string, message: string) => void
	onEdit?: ((agent: AgentApiRecord) => void) | undefined
}) {
	const [message, setMessage] = useState<string>('')
	const recent = events.filter((e) => e.run_id.startsWith('run_')).slice(-10)
	return (
		<div style={{ padding: 'var(--space-3)', display: 'grid', gap: 'var(--space-3)' }}>
			<Section label="Agent">
				<div
					style={{
						display: 'grid',
						gridTemplateColumns: '1fr auto',
						gap: 'var(--space-2)',
						alignItems: 'flex-start',
					}}
				>
					<div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
						<span style={{ fontSize: 'var(--font-13)', fontWeight: 500 }}>
							{agent.name}
						</span>
						{agent.purpose && (
							<span
								style={{
									fontSize: 'var(--font-12)',
									color: 'var(--text-muted)',
								}}
							>
								{agent.purpose}
							</span>
						)}
						<span
							style={{
								fontFamily: 'var(--font-mono)',
								fontSize: 11,
								color: 'var(--text-muted)',
							}}
						>
							{agent.model}
						</span>
					</div>
					{onEdit && (
						<button
							type="button"
							onClick={() => onEdit(agent)}
							title="Edit prompt or capabilities"
							style={{
								height: 24,
								padding: '0 var(--space-2)',
								background: 'transparent',
								color: 'var(--text-muted)',
								border: '1px solid var(--border)',
								borderRadius: 'var(--radius-md)',
								font: 'inherit',
								fontFamily: 'var(--font-ui)',
								fontSize: 11,
								fontWeight: 500,
								cursor: 'pointer',
							}}
						>
							Edit
						</button>
					)}
				</div>
			</Section>

			<Section label="Run instruction">
				{/*
				 * Suggestion chips tailored to the agent's capabilities.
				 * Clicking a chip fills the textarea so a user staring
				 * at a blank input has three concrete starting points.
				 * Browser/computer/MCP agents each get suggestions that
				 * match what they can actually do.
				 */}
				<PromptSuggestions agent={agent} onPick={setMessage} />
				<textarea
					value={message}
					onChange={(e) => setMessage(e.target.value)}
					placeholder="e.g. Summarize today's open PRs and post the digest in #engineering"
					rows={4}
					style={{
						width: '100%',
						padding: '8px var(--space-3)',
						background: 'var(--surface-sunk)',
						border: '1px solid var(--border)',
						borderRadius: 'var(--radius-md)',
						color: 'var(--text-strong)',
						font: 'inherit',
						fontFamily: 'var(--font-ui)',
						fontSize: 'var(--font-13)',
						resize: 'vertical',
					}}
				/>
				<button
					type="button"
					disabled={!message.trim()}
					onClick={() => {
						onRun(agent.id, message.trim())
						setMessage('')
					}}
					style={{
						marginTop: 'var(--space-2)',
						height: 32,
						width: '100%',
						padding: '0 var(--space-3)',
						background: message.trim() ? 'var(--accent)' : 'var(--surface-sunk)',
						color: message.trim() ? 'var(--text-on-accent)' : 'var(--text-muted)',
						border: 'none',
						borderRadius: 'var(--radius-md)',
						font: 'inherit',
						fontFamily: 'var(--font-ui)',
						fontSize: 'var(--font-13)',
						fontWeight: 500,
						cursor: message.trim() ? 'pointer' : 'not-allowed',
					}}
				>
					Run agent
				</button>
			</Section>

			{recent.length > 0 && (
				<Section label="Recent events">
					<ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 2 }}>
						{recent.slice(-10).reverse().map((e) => (
							<li
								key={`${e.run_id}:${e.seq}`}
								style={{
									fontFamily: 'var(--font-mono)',
									fontSize: 'var(--font-12)',
									color: 'var(--text-strong)',
								}}
							>
								<span style={{ color: 'var(--text-muted)' }}>{e.run_id.slice(-8)}</span>{' '}
								#{e.seq} {e.kind}
							</li>
						))}
					</ul>
				</Section>
			)}
		</div>
	)
}

/**
 * PromptSuggestions — three click-to-fill chips above the run-
 * instruction textarea. The suggestions are derived from the
 * agent's capability set so the user never sees a browser
 * suggestion on an MCP-only agent.
 *
 * Intent: a tinkerer staring at a blank input rarely knows what
 * the first prompt should look like. Three concrete examples
 * give them a starting point they can edit instead of inventing
 * from scratch.
 */
function PromptSuggestions({
	agent,
	onPick,
}: {
	agent: AgentApiRecord
	onPick: (text: string) => void
}) {
	const suggestions: string[] = []
	const c = agent.capabilities
	if (c.computer_use.enabled) {
		suggestions.push(
			'Open Firefox and screenshot today\'s top story on news.ycombinator.com'
		)
	}
	if (c.browser_use.enabled) {
		suggestions.push('What did Anthropic announce this week? Cite your sources.')
		suggestions.push('Find the GitHub stars count for tldraw/tldraw and report it.')
	}
	if (c.mcp_servers.length > 0) {
		suggestions.push('List the tools available from each MCP server and explain one.')
	}
	if (suggestions.length === 0) {
		// No capabilities yet — generic "what can you do" probe.
		suggestions.push('What can you do? List your tools.')
	}
	// Cap at three so the row doesn't visually compete with the textarea.
	const visible = suggestions.slice(0, 3)
	return (
		<div
			style={{
				display: 'flex',
				flexWrap: 'wrap',
				gap: 4,
				marginBottom: 'var(--space-2)',
			}}
			aria-label="Prompt suggestions"
		>
			{visible.map((s) => (
				<button
					key={s}
					type="button"
					onClick={() => onPick(s)}
					style={{
						padding: '4px var(--space-2)',
						background: 'var(--surface-sunk)',
						border: '1px solid var(--border)',
						borderRadius: 'var(--radius-pill)',
						color: 'var(--text-muted)',
						font: 'inherit',
						fontFamily: 'var(--font-ui)',
						fontSize: 11,
						cursor: 'pointer',
						maxWidth: '100%',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
					}}
					title={s}
					onMouseEnter={(e) => {
						e.currentTarget.style.borderColor = 'var(--accent)'
						e.currentTarget.style.color = 'var(--accent)'
					}}
					onMouseLeave={(e) => {
						e.currentTarget.style.borderColor = 'var(--border)'
						e.currentTarget.style.color = 'var(--text-muted)'
					}}
				>
					{s.length > 60 ? `${s.slice(0, 60)}…` : s}
				</button>
			))}
		</div>
	)
}

function RunDetailPanel({
	runId,
	events,
}: {
	runId: string
	events: readonly RunEventPayload[]
}) {
	const runEvents = events.filter((e) => e.run_id === runId).slice(-25).reverse()
	return (
		<div style={{ padding: 'var(--space-3)', display: 'grid', gap: 'var(--space-3)' }}>
			<Section label="Run id">
				<span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-13)' }}>{runId}</span>
			</Section>
			{runEvents.length > 0 && (
				<Section label="Events">
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
				</Section>
			)}
		</div>
	)
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div style={{ display: 'grid', gap: 4 }}>
			<div
				style={{
					fontSize: 11,
					color: 'var(--text-muted)',
					textTransform: 'uppercase',
					letterSpacing: 0.6,
				}}
			>
				{label}
			</div>
			{children}
		</div>
	)
}

/**
 * Convert an AgentApiError (or any other failure) into a structured
 * ErrorCard with a problem, a cause, and a remediation hint based
 * on the error code. New error codes from the orchestrator get a
 * branch here; unknown ones fall through to a generic shape.
 */
function toErrorCard(
	err: unknown,
	what: string,
	openSettings?: () => void
): Omit<ErrorCard, 'id'> {
	if (err instanceof AgentApiError) {
		const code = err.code
		// Errors with known remediation paths get their own copy.
		if (code === 'anthropic_not_configured') {
			return {
				title: `The agent couldn't ${what}.`,
				cause:
					'No Claude API key is set. Paste yours in Settings (or set ANTHROPIC_API_KEY on the orchestrator).',
				fix: openSettings ? { label: 'Open Settings', onClick: openSettings } : undefined,
				docsUrl: 'https://console.anthropic.com/settings/keys',
				severity: 'error',
			}
		}
		if (code === 'jwt_secret_not_configured' || code === 'sse_token_secret_not_configured') {
			return {
				title: `The orchestrator is half-configured.`,
				cause: `Required secret missing: ${code}.`,
				docsUrl: 'https://github.com/asigdel29/agent-canvas#setup',
				severity: 'error',
			}
		}
		if (code === 'validation_failed') {
			return {
				title: `Could not ${what} — validation failed.`,
				cause: err.detail ?? 'One of the fields was rejected by the orchestrator.',
				severity: 'error',
			}
		}
		return {
			title: `Could not ${what}.`,
			cause: err.detail ?? `Server returned ${err.status} ${err.code}.`,
			severity: 'error',
		}
	}
	const msg = err instanceof Error ? err.message : String(err)
	return {
		title: `Could not ${what}.`,
		cause: msg,
		severity: 'error',
	}
}

/**
 * Translate an orchestrator-side warning event into a toast card.
 * Each kind has its own user-facing copy and remediation pointer.
 */
function translateBackendEvent(e: RunEventPayload, id: string): ErrorCard {
	switch (e.kind) {
		case 'computer_use_unavailable':
			return {
				id,
				title: 'Computer-use is disabled.',
				cause:
					(e.payload as { reason?: string }).reason ??
					'The orchestrator has no E2B_API_KEY set; the computer tool is not exposed to this agent.',
				docsUrl: 'https://github.com/asigdel29/agent-canvas#setup',
				severity: 'warn',
			}
		case 'mcp_connect_failed':
			return {
				id,
				title: 'An MCP server failed to connect.',
				cause: `${(e.payload as { server_id?: string }).server_id ?? 'A server'} returned: ${
					(e.payload as { message?: string }).message ?? 'unknown error'
				}. Other capabilities still work.`,
				severity: 'warn',
			}
		case 'webhook_signature_failed':
			return {
				id,
				title: 'A webhook arrived with a bad signature.',
				cause: `Provider: ${(e.payload as { provider?: string }).provider ?? 'unknown'}. Check that the secret matches the sender.`,
				severity: 'warn',
			}
		default:
			return {
				id,
				title: 'Orchestrator warning.',
				cause: e.kind,
				severity: 'warn',
			}
	}
}

function providerLabel(p: StarterProvider): string {
	switch (p) {
		case 'github':
			return 'GitHub'
	}
}
