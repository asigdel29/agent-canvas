/**
 * ToolRegistry — the bridge between an agent's declared capabilities
 * and the concrete tools the run loop hands to Anthropic.
 *
 * Each capability provider (MCP, browser, computer-use) returns a
 * list of ToolDescriptors. The registry concatenates them and hands
 * back the Anthropic-shaped ToolSchema[] plus a dispatch table
 * keyed on tool name.
 *
 * Naming convention: tools are namespaced by provider so two
 * providers cannot collide. The model sees them as e.g. `mcp__github__create_issue`,
 * `browser__navigate`, `computer__screenshot`. The orchestrator
 * splits on the double underscore to route.
 * @author asigdel29
 */

import type { ToolSchema } from './anthropicClient.js'

/**
 * Result of executing a tool. Either text content (returned to the
 * model verbatim) or an error message (returned with is_error=true
 * so the model knows to revise its plan).
 */
export type ToolResult =
	| { ok: true; content: string | Array<{ type: 'text'; text: string }> }
	| { ok: false; error: string }

/**
 * Safety classification. Mirrors SafetyClassifier's existing enum.
 * The run loop reads this before executing — destructive and
 * irreversible tools pause for approval.
 */
export type ToolSafety = 'safe' | 'destructive' | 'irreversible'

export interface ToolDescriptor {
	readonly schema: ToolSchema
	readonly safety: ToolSafety
	/**
	 * Human-readable description of the *call* in context — used in
	 * the approval card so the operator sees plain English instead
	 * of just JSON. Receives the tool input so the message can
	 * include the most dangerous fields verbatim.
	 */
	describeCall(input: Readonly<Record<string, unknown>>): string
	/** Execute the tool. Must not throw — wrap errors into ToolResult. */
	execute(input: Readonly<Record<string, unknown>>): Promise<ToolResult>
}

/**
 * Per-run tool registry. Holds the tool descriptors that were live
 * when the run started; the loop looks up tools by name and
 * dispatches. Caller owns lifecycle (close MCP connections, end
 * computer-use sessions) via the `teardown` slot.
 */
export interface ToolCatalog {
	readonly tools: readonly ToolDescriptor[]
	readonly toolByName: ReadonlyMap<string, ToolDescriptor>
	readonly schemas: readonly ToolSchema[]
	teardown(): Promise<void>
}

/**
 * Compose a ToolCatalog from a list of provider contributions.
 * Each provider returns a `{ descriptors, teardown }` bundle; we
 * merge the descriptors and chain the teardowns so closing the
 * catalog closes every provider in order.
 */
export interface ProviderContribution {
	readonly descriptors: readonly ToolDescriptor[]
	teardown(): Promise<void>
}

export function composeToolCatalog(
	contributions: readonly ProviderContribution[]
): ToolCatalog {
	const tools = contributions.flatMap((c) => c.descriptors)
	const toolByName = new Map<string, ToolDescriptor>()
	for (const t of tools) {
		if (toolByName.has(t.schema.name)) {
			throw new Error(`Tool name collision: ${t.schema.name}`)
		}
		toolByName.set(t.schema.name, t)
	}
	return {
		tools,
		toolByName,
		schemas: tools.map((t) => t.schema),
		async teardown() {
			// Run every teardown even if one throws. Final composite
			// error carries every failure so operators see the full
			// picture on a partial cleanup failure.
			const errors: Error[] = []
			for (const c of contributions) {
				try {
					await c.teardown()
				} catch (e) {
					errors.push(e instanceof Error ? e : new Error(String(e)))
				}
			}
			if (errors.length > 0) {
				throw new Error(
					`teardown failures: ${errors.map((e) => e.message).join('; ')}`
				)
			}
		},
	}
}
