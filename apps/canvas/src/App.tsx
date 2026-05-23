/**
 * App — the canvas client root.
 *
 * Renders tldraw with the custom AgentShapeUtil registered, plus the
 * surrounding workspace chrome (connector strip, approval inbox, spend
 * banner) per design review hierarchy.
 *
 * Realtime: if the URL carries `?room=<id>&token=<jwt>`, the app opens
 * a RoomEventClient against the orchestrator's `/api/sync/:room` SSE
 * stream and renders incoming events in the LiveEvents panel. Without
 * those params the canvas runs in standalone demo mode (mocked data).
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

export function App() {
	const [connectors, setConnectors] = useState<readonly ConnectorTile[]>([])
	const [approvals, setApprovals] = useState<readonly ApprovalCard[]>([])
	const [liveEvents, setLiveEvents] = useState<readonly RunEventPayload[]>([])

	const realtime = useMemo(() => {
		if (typeof window === 'undefined') return null
		const params = new URLSearchParams(window.location.search)
		const room = params.get('room')
		const session = params.get('session')
		if (!room || !session) return null
		return { room, session }
	}, [])

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
