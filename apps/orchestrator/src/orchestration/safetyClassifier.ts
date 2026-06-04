/**
 * SafetyClassifier — gates destructive and irreversible agent actions.
 *
 * The agent vendor proposes a tool call. Before the orchestrator
 * dispatches it (sending the scoped credential), the classifier
 * decides:
 *
 *   safe          → dispatch immediately
 *   destructive   → pause run; emit approval_request event; await
 *                   approval_decision from the canvas
 *   irreversible  → same as destructive, but the approval card is
 *                   visually stronger (red, double-confirm) — purely
 *                   a UI hint; gating logic is identical
 *
 * Classification is data-driven: each ToolDescriptor declares its
 * safety class. Tools that accept arbitrary input (shell, SQL, generic
 * HTTP) MUST declare destructive or irreversible — the connector's own
 * test asserts this; conformance can only spot-check.
 *
 * This file is the runtime that consults the ConnectorRegistry and
 * routes per (provider_id, tool_id) → SafetyClass.
 * @author asigdel29
 */

import type { Connector, ConnectorRegistry, SafetyClass } from '@agent-canvas/connector-core'
import type { ProviderId } from '@agent-canvas/orchestrator-types'

export interface ProposedToolCall {
	readonly provider: ProviderId
	readonly tool_id: string
	readonly args: Readonly<Record<string, unknown>>
}

export interface ClassificationResult {
	readonly safety: SafetyClass
	/** Human-readable label for the approval card. */
	readonly tool_name: string
	/** Localized description for the approval card body. */
	readonly tool_description: string
}

export class SafetyClassifier {
	constructor(private readonly registry: ConnectorRegistry) {}

	classify(call: ProposedToolCall): ClassificationResult {
		const connector = this.registry.getConnector(call.provider)
		const tool = findTool(connector, call.tool_id)
		if (!tool) {
			// Unknown tool — fail-closed. The agent proposed something not
			// in our registry; treat as irreversible so a human reviews it.
			return {
				safety: 'irreversible',
				tool_name: `${call.provider}:${call.tool_id}`,
				tool_description:
					`Unknown tool proposed by agent. ` +
					`Approval required before any action is taken.`,
			}
		}
		return {
			safety: tool.safety,
			tool_name: tool.name,
			tool_description: tool.description,
		}
	}

	requiresApproval(call: ProposedToolCall): boolean {
		const result = this.classify(call)
		return result.safety === 'destructive' || result.safety === 'irreversible'
	}
}

function findTool(connector: Connector, tool_id: string) {
	return connector.tools.find((t) => t.id === tool_id)
}
