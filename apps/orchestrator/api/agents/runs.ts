/**
 * POST /api/agents/runs
 *   body: { agent_id, room_id, initial_message }
 *
 * Starts a run for an existing agent. Returns immediately with the
 * run_id; the run itself executes asynchronously and publishes its
 * progress through the room SSE bus. The client connects to the
 * room and watches events stream in.
 *
 * Why a flat /api/agents/runs route (not /api/agents/:id/runs)?
 * Vercel's file router treats [id]/runs as a nested dynamic
 * segment that needs its own folder; the flat shape keeps the
 * dev-server router simple and the request body already carries
 * agent_id. The semantic mapping is the same.
 *
 * Production hardening still missing:
 *   - BillingGate check before spending tokens (P8 will add this)
 *
 * Hardened in earlier tiers:
 *   - Per-workspace membership check (P1)
 *   - Rate limit per user (P5; 30 starts/min)
 */

import type { RoomId } from '@agent-canvas/orchestrator-types'

import { getRuntime } from '../../dist/index.js'
import { extractSession } from '../../dist/auth/session.js'
import { preflightResponse, withCorsHeaders } from '../../dist/http/cors.js'
import { withRateLimit } from '../../dist/rateLimit/withRateLimit.js'
import type { AgentId } from '../../dist/agents/agentRecord.js'
import { AnthropicClient } from '../../dist/agents/anthropicClient.js'
import { buildBrowserContribution } from '../../dist/agents/providers/browserProvider.js'
import { buildComputerUseContribution } from '../../dist/agents/providers/computerUseProvider.js'
import {
	E2BComputerUseSandbox,
} from '../../dist/agents/providers/computerUseSandbox.js'
import { buildMcpContribution } from '../../dist/agents/providers/mcpProvider.js'
import {
	BusRunEventSink,
	newRunId,
	runLoop,
} from '../../dist/agents/runLoop.js'
import { composeToolCatalog } from '../../dist/agents/toolRegistry.js'

export default async function handler(req: Request): Promise<Response> {
	const preflight = preflightResponse(req)
	if (preflight) return preflight
	if (req.method !== 'POST') {
		return withCorsHeaders(req, jsonError(405, 'method_not_allowed'))
	}

	const secret = process.env['JWT_SECRET']
	if (!secret) return withCorsHeaders(req, jsonError(500, 'jwt_secret_not_configured'))
	const session = extractSession(req, secret)
	if (!session) return withCorsHeaders(req, jsonError(401, 'unauthorized'))

	const runtime = getRuntime() as unknown as {
		agentStore?: import('../../dist/agents/agentStore.js').AgentStore
		approvalGate?: import('../../dist/agents/storeBackedApprovalGate.js').StoreBackedApprovalGate
		roomEventBus?: import('../../dist/sync/roomEventBus.js').RoomEventBus
		rateLimitStore?: import('../../dist/rateLimit/rateLimitStore.js').RateLimitStore
	}
	const agentStore = runtime.agentStore
	const approvalGate = runtime.approvalGate
	const bus = runtime.roomEventBus
	const rateLimit = runtime.rateLimitStore
	if (!agentStore || !approvalGate || !bus || !rateLimit) {
		return withCorsHeaders(req, jsonError(500, 'runtime_not_fully_initialized'))
	}

	// Rate limit run starts at 30/min per user. A Claude run can spend
	// real money on every iteration; 30/min keeps a runaway client
	// loop from draining the workspace budget before billing catches
	// up (P8). Reads against /api/agents/runs/:id are not limited.
	// Arrow form (not function declaration) so the narrowing of
	// agentStore / approvalGate / bus survives into the closure.
	const startRun = async (): Promise<Response> => {

	// Resolve the Anthropic key. Per-request header takes precedence
	// (Bring-Your-Own-Key path from the canvas Settings drawer); fall
	// back to ANTHROPIC_API_KEY env if the header is absent (still
	// useful for ops-controlled deployments). Without either, we 503
	// with a remediation message the canvas's ErrorToast translates.
	const anthropicKey =
		req.headers.get('x-anthropic-api-key')?.trim() ||
		process.env['ANTHROPIC_API_KEY'] ||
		null
	if (!anthropicKey) {
		return withCorsHeaders(
			req,
			jsonError(
				503,
				'anthropic_not_configured',
				'Set your Claude API key in Settings, or set ANTHROPIC_API_KEY on the orchestrator.'
			)
		)
	}
	const anthropic = new AnthropicClient({ apiKey: anthropicKey })

	let body: { agent_id?: string; room_id?: string; initial_message?: string }
	try {
		body = (await req.json()) as typeof body
	} catch {
		return withCorsHeaders(req, jsonError(400, 'malformed_json'))
	}
	if (!body.agent_id || !body.room_id || !body.initial_message) {
		return withCorsHeaders(
			req,
			jsonError(400, 'missing_fields', 'agent_id, room_id, initial_message all required')
		)
	}

	const agent = await agentStore.get(body.agent_id as AgentId)
	if (!agent) return withCorsHeaders(req, jsonError(404, 'agent_not_found'))

	// Membership gate. Running an agent is a write-class action, so
	// member+ is required. Viewers see the canvas but cannot start runs.
	const runtimeTenancy = (runtime as unknown as {
		tenancyStore?: import('../../dist/tenancy/tenancyStore.js').TenancyStore
	}).tenancyStore
	if (!runtimeTenancy) {
		return withCorsHeaders(req, jsonError(500, 'tenancy_store_not_initialized'))
	}
	try {
		const { TenancyForbiddenError } = await import('../../dist/tenancy/tenancyTypes.js')
		await runtimeTenancy.requireMembership(
			session.sub as never,
			agent.workspace_id,
			'member'
		)
		void TenancyForbiddenError // imported above for clarity
	} catch (err) {
		const name = err instanceof Error ? err.name : ''
		if (name === 'TenancyForbiddenError') {
			return withCorsHeaders(req, jsonError(403, 'workspace_forbidden'))
		}
		throw err
	}

	const run_id = newRunId()
	const room_id = body.room_id as RoomId

	// Build the provider contributions before responding so connect
	// failures surface as 502 instead of going silent on a 202.
	const mcpContribution = await buildMcpContribution(
		agent.capabilities.mcp_servers,
		{
			onServerError: (server, err) => {
				bus.publish(room_id, {
					seq: 0,
					run_id,
					kind: 'mcp_connect_failed' as never,
					ts: new Date().toISOString(),
					schema_version: 1,
					payload: { server_id: server.id, message: err.message },
				})
			},
		}
	)
	const browserContribution = await buildBrowserContribution({
		config: agent.capabilities.browser_use,
		agent_id: agent.id,
	})

	// Computer-use is gated on the agent flag AND a resolved E2B key.
	// Same BYOK preference as Anthropic: x-e2b-api-key header trumps
	// the env. When the key is missing, the run still starts; the
	// computer tool is just not exposed and a warn event lands on
	// the room bus so the canvas can surface why.
	const e2bKey =
		req.headers.get('x-e2b-api-key')?.trim() ||
		process.env['E2B_API_KEY'] ||
		null
	let screenshotSeq = 0
	const e2bLauncher =
		agent.capabilities.computer_use.enabled &&
		agent.capabilities.computer_use.provider === 'e2b' &&
		e2bKey
			? {
					create: () => E2BComputerUseSandbox.create({ apiKey: e2bKey }),
				}
			: null
	if (agent.capabilities.computer_use.enabled && !e2bLauncher) {
		bus.publish(room_id, {
			seq: 0,
			run_id,
			kind: 'computer_use_unavailable' as never,
			ts: new Date().toISOString(),
			schema_version: 1,
			payload: {
				reason:
					'E2B_API_KEY is not set; the computer tool is not exposed to the model.',
			},
		})
	}
	const computerUseContribution = await buildComputerUseContribution({
		config: agent.capabilities.computer_use,
		sandboxFactory: e2bLauncher
			? () => e2bLauncher.create()
			: async () => {
					throw new Error('no computer-use sandbox launcher configured')
				},
		onScreenshot: (dataUri) => {
			screenshotSeq += 1
			bus.publish(room_id, {
				seq: screenshotSeq,
				run_id,
				kind: 'computer_screenshot' as never,
				ts: new Date().toISOString(),
				schema_version: 1,
				payload: {
					agent_id: agent.id,
					data_uri: dataUri,
				},
			})
		},
	})

	const catalog = composeToolCatalog([
		mcpContribution,
		browserContribution,
		computerUseContribution,
	])

	const sink = new BusRunEventSink(bus, room_id)

	// Fire-and-forget — the run can outlive this HTTP request. We
	// return immediately with the run_id; events flow through SSE.
	void (async () => {
		try {
			await runLoop(
				{
					run_id,
					room_id,
					agent,
					initial_user_message: body.initial_message!,
				},
				{ anthropic, catalog, sink, approvalGate }
			)
		} catch (err) {
			// runLoop should never throw (catches its own errors and
			// returns a summary), but defend against future changes.
			bus.publish(room_id, {
				seq: 999_999,
				run_id,
				kind: 'run_failed' as never,
				ts: new Date().toISOString(),
				schema_version: 1,
				payload: {
					final_error: err instanceof Error ? err.message : String(err),
				},
			})
		}
	})()

	return withCorsHeaders(
		req,
		new Response(JSON.stringify({ run_id, agent_id: agent.id, room_id }), {
			status: 202,
			headers: { 'content-type': 'application/json' },
		})
	)
	}

	return withRateLimit(
		{
			store: rateLimit,
			key: `start-run:${session.sub}`,
			limit: 30,
			windowSec: 60,
			blockedBody: () => ({
				error: 'rate_limited',
				detail: 'too many run starts in the last minute',
			}),
		},
		startRun
	)
}

function jsonError(status: number, code: string, detail?: string): Response {
	return new Response(JSON.stringify({ error: code, detail }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
