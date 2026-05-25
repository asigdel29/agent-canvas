import { describe, expect, it, vi } from 'vitest'
import type { UserId } from '@agent-canvas/orchestrator-types'
import { drainOnce } from './drainOnce.js'
import { InMemoryWebhookDeliveryStore } from './webhookDeliveryStore.js'
import { InMemoryWebhookEndpointStore } from './webhookEndpointStore.js'
import type { WorkspaceId } from '../tenancy/tenancyTypes.js'
import { verifyWebhook } from './signWebhook.js'

const W = 'ws_a' as WorkspaceId
const U = 'gh:1' as UserId

async function setupOne(): Promise<{
	endpointStore: InMemoryWebhookEndpointStore
	deliveryStore: InMemoryWebhookDeliveryStore
	endpointId: string
	signingSecret: string
	deliveryId: string
}> {
	const endpointStore = new InMemoryWebhookEndpointStore()
	const deliveryStore = new InMemoryWebhookDeliveryStore()
	const created = await endpointStore.create({
		workspace_id: W,
		user_id: U,
		url: 'https://hook.example.com/in',
	})
	const enqueued = await deliveryStore.enqueue({
		endpoint_id: created.record.id,
		event_id: 'evt_1',
		event_type: 'token.minted',
		body: '{"hello":"world"}',
	})
	return {
		endpointStore,
		deliveryStore,
		endpointId: created.record.id,
		signingSecret: created.signing_secret,
		deliveryId: enqueued.id,
	}
}

/** Always-ok DNS resolution for tests; the real lookup hits the network. */
const okDns = (async (_h: string) => ({ ok: true, resolved: ['1.2.3.4'] })) as unknown as typeof import('./resolveAndCheckIp.js').resolveAndCheckIp

describe('drainOnce', () => {
	it('POSTs the signed body and marks the delivery succeeded on 200', async () => {
		const ctx = await setupOne()
		let capturedHeaders: Headers | null = null
		let capturedBody: string | null = null
		const fakeFetch = (async (
			_url: string | URL | Request,
			init?: RequestInit
		) => {
			capturedHeaders = new Headers(init?.headers ?? {})
			capturedBody = typeof init?.body === 'string' ? init.body : null
			return new Response('ok', { status: 200 })
		}) as unknown as typeof fetch

		const summary = await drainOnce({
			endpointStore: ctx.endpointStore,
			deliveryStore: ctx.deliveryStore,
			fetchImpl: fakeFetch,
			resolveAndCheckIpImpl: okDns,
		})

		expect(summary.claimed).toBe(1)
		expect(summary.outcomes[0]!.result).toBe('succeeded')
		// Header set we promised the customer.
		expect(capturedHeaders!.get('x-ac-event-id')).toBe('evt_1')
		expect(capturedHeaders!.get('x-ac-event-type')).toBe('token.minted')
		expect(capturedHeaders!.get('x-ac-signature')).toMatch(/^t=\d+,v1=[0-9a-f]+$/)
		// And the body verifies against the signing secret.
		const verify = verifyWebhook({
			secret: ctx.signingSecret,
			header: capturedHeaders!.get('x-ac-signature')!,
			body: capturedBody!,
		})
		expect(verify.ok).toBe(true)
		// Delivery row is terminal.
		const after = (await ctx.deliveryStore.listByEndpoint(ctx.endpointId))[0]!
		expect(after.status).toBe('succeeded')
		expect(after.last_status_code).toBe(200)
	})

	it('marks failed on 5xx and reschedules for retry', async () => {
		const ctx = await setupOne()
		const fakeFetch = (async () =>
			new Response('boom', { status: 500 })) as unknown as typeof fetch
		const summary = await drainOnce({
			endpointStore: ctx.endpointStore,
			deliveryStore: ctx.deliveryStore,
			fetchImpl: fakeFetch,
			resolveAndCheckIpImpl: okDns,
		})
		expect(summary.outcomes[0]!.result).toBe('retried')
		const after = (await ctx.deliveryStore.listByEndpoint(ctx.endpointId))[0]!
		expect(after.status).toBe('pending')
		expect(after.attempt_num).toBe(1)
		expect(after.next_attempt_at).not.toBeNull()
	})

	it('marks failed_permanent when a final-attempt request throws', async () => {
		const ctx = await setupOne()
		// Pre-set the row to one-below the budget so a single drain
		// pushes it over. We poke the InMemory store's internal map
		// directly — same test-only seam used elsewhere.
		const internal = ctx.deliveryStore as unknown as {
			rows: Map<string, { attempt_num: number; status: string; next_attempt_at: string | null }>
		}
		const row = internal.rows.get(ctx.deliveryId)!
		row.attempt_num = 7 // next failure pushes to 8 = MAX_ATTEMPTS
		row.next_attempt_at = new Date(0).toISOString()

		const fakeFetch = (async () => {
			throw new Error('connect ETIMEDOUT')
		}) as unknown as typeof fetch
		const summary = await drainOnce({
			endpointStore: ctx.endpointStore,
			deliveryStore: ctx.deliveryStore,
			fetchImpl: fakeFetch,
			resolveAndCheckIpImpl: okDns,
		})
		expect(summary.outcomes[0]!.result).toBe('failed_permanent')
		const final = (await ctx.deliveryStore.listByEndpoint(ctx.endpointId))[0]!
		expect(final.status).toBe('failed')
		expect(final.failed_at).not.toBeNull()
	})

	it('treats a private resolved IP as a delivery failure', async () => {
		const ctx = await setupOne()
		const fakeFetch = vi.fn() as unknown as typeof fetch
		const privateDns = (async () => ({
			ok: false as const,
			reason: 'private_address' as const,
			resolved: ['10.0.0.1'],
		})) as unknown as typeof import('./resolveAndCheckIp.js').resolveAndCheckIp
		const summary = await drainOnce({
			endpointStore: ctx.endpointStore,
			deliveryStore: ctx.deliveryStore,
			fetchImpl: fakeFetch,
			resolveAndCheckIpImpl: privateDns,
		})
		expect(summary.outcomes[0]!.result).toBe('retried')
		expect((fakeFetch as unknown as { mock?: { calls: unknown[] } }).mock?.calls.length ?? 0).toBe(0)
		const after = (await ctx.deliveryStore.listByEndpoint(ctx.endpointId))[0]!
		expect(after.last_error).toContain('private_address')
	})

	it('a revoked endpoint short-circuits with status 410', async () => {
		const ctx = await setupOne()
		await ctx.endpointStore.revoke(ctx.endpointId, U)
		const fakeFetch = vi.fn() as unknown as typeof fetch
		const summary = await drainOnce({
			endpointStore: ctx.endpointStore,
			deliveryStore: ctx.deliveryStore,
			fetchImpl: fakeFetch,
			resolveAndCheckIpImpl: okDns,
		})
		expect(summary.outcomes[0]!.result).toBe('succeeded')
		expect(summary.outcomes[0]!.status_code).toBe(410)
		expect((fakeFetch as unknown as { mock?: { calls: unknown[] } }).mock?.calls.length ?? 0).toBe(0)
	})

	it('returns claimed=0 when nothing is pending', async () => {
		const endpointStore = new InMemoryWebhookEndpointStore()
		const deliveryStore = new InMemoryWebhookDeliveryStore()
		const summary = await drainOnce({ endpointStore, deliveryStore })
		expect(summary.claimed).toBe(0)
		expect(summary.outcomes).toHaveLength(0)
	})
})
