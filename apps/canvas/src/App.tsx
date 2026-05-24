/**
 * App — the canvas client root.
 *
 * Renders tldraw with the custom AgentShapeUtil registered, plus the
 * surrounding workspace chrome (connector strip, approval inbox, spend
 * banner) per design review hierarchy.
 *
 * Realtime: if the URL carries `?room=<id>&session=<jwt>`, the app moves
 * the session JWT into sessionStorage and strips it from the URL via
 * `history.replaceState` BEFORE any other code runs. This collapses the
 * leak window for the long-lived session credential to the single round
 * trip that delivers the page; CDN access logs, Referer headers, and
 * browser history never see it. The session is then used to mint
 * short-lived (60s, single-use) SSE tokens for the realtime stream.
 *
 * Orchestrator base URL: VITE_ORCHESTRATOR_URL (default http://localhost:3000).
 */

import { useEffect, useMemo, useState } from 'react'
import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'

import { AgentShapeUtil } from './agent/AgentShapeUtil.js'
import { ApprovalInbox, type ApprovalCard } from './inbox/ApprovalInbox.js'
import { ConnectorStrip, type ConnectorTile } from './connectors/ConnectorStrip.js'
import { EmptyState, type StarterProvider } from './onboarding/EmptyState.js'
import { SpendBanner } from './spend/SpendBanner.js'
import { LiveEvents } from './sync/LiveEvents.js'
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
 * Pull the session JWT and room id out of the URL ONCE on first load,
 * stash them in sessionStorage, and rewrite the URL so the credential
 * does not survive in history / Referer / CDN access logs.
 *
 * Returns whatever pair is available — URL takes precedence on first
 * load, sessionStorage on subsequent reads (e.g. after replaceState).
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
			// sessionStorage may be disabled (private mode / iframe sandbox).
			// Fall through; the URL still carries the values for this load.
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
		})
		return () => client.close()
	}, [realtime])

	const hasAnyConnector = connectors.length > 0

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

	const view = useMemo(() => {
		if (!hasAnyConnector && !realtime) return <EmptyState onConnect={handleConnect} />
		return (
			<>
				<ConnectorStrip tiles={connectors} onClick={() => {}} />
				<ApprovalInbox
					cards={approvals}
					onApprove={(card) => setApprovals((p) => p.filter((c) => c.id !== card.id))}
					onReject={(card) => setApprovals((p) => p.filter((c) => c.id !== card.id))}
				/>
				<SpendBanner accrued_micros={3_420_000} ceiling_micros={50_000_000} />
				<LiveEvents events={liveEvents} />
				<Tldraw shapeUtils={SHAPE_UTILS} />
			</>
		)
	}, [hasAnyConnector, realtime, connectors, approvals, liveEvents])

	return <main style={{ position: 'relative', width: '100%', height: '100%' }}>{view}</main>
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
