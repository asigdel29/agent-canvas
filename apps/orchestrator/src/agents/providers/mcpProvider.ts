/**
 * MCP provider — opens connections to the Model Context Protocol
 * servers listed in an agent's capabilities and exposes their tools
 * to the run loop.
 *
 * Connection model:
 *   - One Client per server, opened on `connect()`, closed on
 *     `teardown()`. We do NOT pool across runs because per-run
 *     auth and trust decisions should not bleed between agents.
 *   - Transport is SSE for now (streamable-HTTP support lands
 *     when needed). Bearer-auth headers are attached at connect
 *     time when the server config carries auth.type='bearer'.
 *   - Tool names are namespaced `mcp__<server_id>__<tool_name>` so
 *     two servers can expose tools with overlapping names without
 *     collision, and the run loop knows which server to dispatch
 *     to from the prefix alone.
 *
 * Safety:
 *   - Trust=untrusted (the default): every tool call is classified
 *     'destructive' so it pauses for approval. The model still sees
 *     the tool list; the operator decides whether each call goes.
 *   - Trust=trusted: tools are 'safe' by default; the operator
 *     explicitly opted into the server and accepts its tool
 *     surface.
 *
 * Failure modes:
 *   - Server unreachable at connect: throws McpConnectError, the
 *     caller decides whether to abort the run or proceed with the
 *     other providers.
 *   - Tool call throws: surfaced as ToolResult.error, the model
 *     reads it and revises its plan.
 * @author asigdel29
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

import type {
	McpServerRef,
} from '../agentRecord.js'
import type {
	ProviderContribution,
	ToolDescriptor,
	ToolResult,
	ToolSafety,
} from '../toolRegistry.js'

const TOOL_PREFIX = 'mcp__'
const TOOL_SEP = '__'
const CONNECT_TIMEOUT_MS = 8_000

export class McpConnectError extends Error {
	constructor(public readonly server_id: string, message: string) {
		super(`MCP connect to ${server_id} failed: ${message}`)
		this.name = 'McpConnectError'
	}
}

/**
 * Build a ProviderContribution for a single agent's MCP server list.
 * Opens every connection in parallel; if one fails, the rest still
 * proceed and the failure is reported per server. Caller decides
 * whether partial connectivity is acceptable.
 */
export async function buildMcpContribution(
	servers: readonly McpServerRef[],
	options: { onServerError?: (s: McpServerRef, err: Error) => void } = {}
): Promise<ProviderContribution> {
	if (servers.length === 0) {
		return {
			descriptors: [],
			async teardown() {
				/* nothing to close */
			},
		}
	}

	const opened: Array<{ server: McpServerRef; client: Client }> = []
	const descriptors: ToolDescriptor[] = []

	await Promise.all(
		servers.map(async (server) => {
			try {
				const client = await openMcpClient(server)
				opened.push({ server, client })
				const list = await client.listTools()
				for (const t of list.tools) {
					descriptors.push(makeDescriptor(server, client, t))
				}
			} catch (err) {
				const e = err instanceof Error ? err : new Error(String(err))
				options.onServerError?.(server, e)
			}
		})
	)

	return {
		descriptors,
		async teardown() {
			await Promise.allSettled(
				opened.map(async ({ client }) => {
					try {
						await client.close()
					} catch {
						/* swallow — teardown is best-effort */
					}
				})
			)
		},
	}
}

async function openMcpClient(server: McpServerRef): Promise<Client> {
	const url = new URL(server.url)
	const headers: Record<string, string> = {}
	if (server.auth?.type === 'bearer') {
		headers['authorization'] = `Bearer ${server.auth.token}`
	}
	const transport = new SSEClientTransport(url, {
		requestInit: { headers },
	})
	const client = new Client(
		{ name: 'agent-canvas', version: '0.0.1' },
		{ capabilities: {} }
	)
	const connectPromise = client.connect(transport)
	await Promise.race([
		connectPromise,
		new Promise<never>((_resolve, reject) =>
			setTimeout(
				() => reject(new McpConnectError(server.id, `timeout after ${CONNECT_TIMEOUT_MS}ms`)),
				CONNECT_TIMEOUT_MS
			)
		),
	])
	return client
}

function makeDescriptor(
	server: McpServerRef,
	client: Client,
	tool: {
		name: string
		description?: string | undefined
		inputSchema?:
			| { type: 'object'; properties?: unknown; required?: unknown }
			| undefined
	}
): ToolDescriptor {
	const namespacedName = `${TOOL_PREFIX}${server.id}${TOOL_SEP}${tool.name}`
	const safety: ToolSafety = server.trust === 'trusted' ? 'safe' : 'destructive'
	const inputSchema = {
		type: 'object' as const,
		properties: (tool.inputSchema?.properties ?? {}) as Record<string, unknown>,
		required: (tool.inputSchema?.required as readonly string[] | undefined) ?? [],
	}
	return {
		schema: {
			name: namespacedName,
			description:
				tool.description ??
				`Call ${tool.name} on MCP server ${server.id} (${server.url}).`,
			input_schema: inputSchema,
		},
		safety,
		describeCall(input) {
			const preview = JSON.stringify(input).slice(0, 240)
			return `${server.id} → ${tool.name}(${preview})`
		},
		async execute(input): Promise<ToolResult> {
			try {
				const result = await client.callTool({
					name: tool.name,
					arguments: input as Record<string, unknown>,
				})
				const content = (result.content as Array<{ type: string; text?: string }>) ?? []
				const text = content
					.filter((c) => c.type === 'text')
					.map((c) => c.text ?? '')
					.join('\n')
				return { ok: true, content: text || JSON.stringify(result) }
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				return { ok: false, error: `${tool.name} failed: ${msg}` }
			}
		},
	}
}
