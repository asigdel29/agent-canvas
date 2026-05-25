/**
 * Agent capability types — what an agent is *allowed* to do.
 *
 * Lives in the canvas package because the agent shape carries these
 * fields, but the orchestrator and connector layers consume the
 * same shape so additions land in one place. Stays alongside the
 * agent ShapeUtil so the shape's tlschema + this file always agree.
 *
 * Three capabilities currently modeled:
 *
 *   computer_use  Full desktop control via the Claude Computer Use
 *                 tool. The agent receives screenshots and can issue
 *                 click / keystroke / scroll actions against a
 *                 sandboxed Linux desktop. Runtime impl lands later;
 *                 this branch only stores the flag.
 *
 *   browser_use   Headless browser access for navigation, scraping,
 *                 form-fill. Strictly less power than computer_use
 *                 (no OS-level control) so they are independently
 *                 toggleable rather than a single "internet" switch.
 *
 *   mcp_servers   Per-agent list of Model Context Protocol servers
 *                 the agent connects to at start-time. Each MCP
 *                 server contributes a set of tools the agent can
 *                 call. Authentication is per-server (bearer or
 *                 OAuth handover; OAuth handover lands later).
 */

/**
 * Single MCP server connection an agent will open at start-time.
 *
 *   id        Stable identifier the user picks. Surfaces on the
 *             agent shape so the user can tell which MCP server is
 *             which without expanding details.
 *   url       SSE or streamable-HTTP endpoint. The MCP client speaks
 *             both; the server announces which.
 *   auth      Optional. `bearer` carries a pre-shared static token;
 *             `oauth` defers to a future OAuth-handover flow.
 *   trust     Whether the agent should be allowed to call this
 *             server's tools without per-call confirmation. Defaults
 *             to `untrusted` so prompt-injection from a hostile MCP
 *             server cannot silently drive the agent.
 */
export interface McpServerRef {
	readonly id: string
	readonly url: string
	readonly auth?: McpAuth | undefined
	readonly trust: 'trusted' | 'untrusted'
}

export type McpAuth =
	| { readonly type: 'bearer'; readonly token: string }
	| { readonly type: 'oauth' }

/**
 * Computer-use configuration. Currently a single boolean plus a
 * placeholder for the sandbox provider; later branches add region,
 * desktop image, timeout, and per-session resource caps.
 */
export interface ComputerUseConfig {
	readonly enabled: boolean
	/**
	 * Which sandbox provider drives the desktop session. `none` is
	 * stored when enabled is false; the field is required so older
	 * shapes survive the schema migration when execution lands.
	 */
	readonly provider: 'e2b' | 'browserbase' | 'none'
}

/**
 * Browser-use configuration. Mirrors ComputerUseConfig shape so the
 * agent shape's capability section can render them uniformly.
 */
export interface BrowserUseConfig {
	readonly enabled: boolean
	/**
	 * Whether the agent's browser session persists cookies across
	 * calls. Off by default so a hostile site can't pin state on the
	 * agent between unrelated tasks.
	 */
	readonly persist_cookies: boolean
}

/**
 * Bundle of every capability slot. Each capability is a deliberate
 * named field rather than a flexible map so the shape's tlschema
 * validator can enforce the contract at the record boundary.
 */
export interface AgentCapabilities {
	readonly computer_use: ComputerUseConfig
	readonly browser_use: BrowserUseConfig
	readonly mcp_servers: readonly McpServerRef[]
}

/**
 * Default capability bundle for a freshly created agent. Everything
 * disabled, no MCP servers. Callers explicitly opt in.
 */
export function defaultCapabilities(): AgentCapabilities {
	return {
		computer_use: { enabled: false, provider: 'none' },
		browser_use: { enabled: false, persist_cookies: false },
		mcp_servers: [],
	}
}

/**
 * Count how many capabilities are enabled. Useful for the badge in
 * the agent shape header ("3 capabilities").
 */
export function capabilityCount(c: AgentCapabilities): number {
	let n = 0
	if (c.computer_use.enabled) n += 1
	if (c.browser_use.enabled) n += 1
	n += c.mcp_servers.length
	return n
}

/**
 * One-line summary of enabled capabilities. Falls back to "no
 * capabilities" when nothing is enabled so the badge always has a
 * stable shape.
 */
export function summarizeCapabilities(c: AgentCapabilities): string {
	const bits: string[] = []
	if (c.computer_use.enabled) bits.push('computer')
	if (c.browser_use.enabled) bits.push('browser')
	if (c.mcp_servers.length === 1) bits.push('1 MCP')
	else if (c.mcp_servers.length > 1) bits.push(`${c.mcp_servers.length} MCPs`)
	return bits.length > 0 ? bits.join(' · ') : 'no capabilities'
}
