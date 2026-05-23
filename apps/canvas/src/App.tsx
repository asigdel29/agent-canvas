/**
 * App — the canvas client root.
 *
 * Renders tldraw with the custom AgentShapeUtil registered, plus the
 * surrounding workspace chrome (connector strip, approval inbox, spend
 * banner) per design review hierarchy.
 *
 * Phase 1 wires presence + projection to the orchestrator over the
 * sync stack. This initial scaffold mounts the components against
 * mocked data so the layout and the AgentShape rendering can be
 * iterated without a backend.
 */

import { useMemo, useState } from 'react'
import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'

import { AgentShapeUtil } from './agent/AgentShapeUtil.js'
import { ApprovalInbox, type ApprovalCard } from './inbox/ApprovalInbox.js'
import { ConnectorStrip, type ConnectorTile } from './connectors/ConnectorStrip.js'
import { EmptyState, type StarterProvider } from './onboarding/EmptyState.js'
import { SpendBanner } from './spend/SpendBanner.js'

const SHAPE_UTILS = [AgentShapeUtil]

export function App() {
	const [connectors, setConnectors] = useState<readonly ConnectorTile[]>([])
	const [approvals, setApprovals] = useState<readonly ApprovalCard[]>([])

	const hasAnyConnector = connectors.length > 0

	function handleConnect(provider: StarterProvider) {
		setConnectors((prev) => [
			...prev,
			{ id: provider, label: providerLabel(provider), status: 'connected' },
		])
		// Mock a pending approval to demo the inbox after the first connect.
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
		if (!hasAnyConnector) return <EmptyState onConnect={handleConnect} />
		return (
			<>
				<ConnectorStrip tiles={connectors} onClick={() => {}} />
				<ApprovalInbox
					cards={approvals}
					onApprove={(card) => setApprovals((p) => p.filter((c) => c.id !== card.id))}
					onReject={(card) => setApprovals((p) => p.filter((c) => c.id !== card.id))}
				/>
				<SpendBanner accrued_micros={3_420_000} ceiling_micros={50_000_000} />
				<Tldraw shapeUtils={SHAPE_UTILS} />
			</>
		)
	}, [hasAnyConnector, connectors, approvals])

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
