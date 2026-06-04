/**
 * Tests for dispatchWebhook.
 *
 * @author asigdel29
 */

import { describe, expect, it } from 'vitest'
import type { UserId } from '@agent-canvas/orchestrator-types'
import {
	buildEnvelope,
	dispatchWebhook,
} from './dispatchWebhook.js'
import { InMemoryWebhookDeliveryStore } from './webhookDeliveryStore.js'
import {
	EVENT_TYPE_WILDCARD,
	InMemoryWebhookEndpointStore,
} from './webhookEndpointStore.js'
import type { WorkspaceId } from '../tenancy/tenancyTypes.js'

const W = 'ws_a' as WorkspaceId
const U = 'gh:1' as UserId

describe('buildEnvelope', () => {
	it('returns a stable shape', () => {
		const env = buildEnvelope({
			workspace_id: W,
			event_type: 'token.minted',
			event_id: 'evt_1',
			payload: { x: 1 },
		})
		expect(env.id).toBe('evt_1')
		expect(env.type).toBe('token.minted')
		expect(env.data).toEqual({ x: 1 })
		expect(typeof env.created_at).toBe('string')
	})
})

describe('dispatchWebhook', () => {
	async function setupWith(subs: Array<{ events?: string[] }>) {
		const endpointStore = new InMemoryWebhookEndpointStore()
		const deliveryStore = new InMemoryWebhookDeliveryStore()
		for (let i = 0; i < subs.length; i++) {
			// eslint-disable-next-line no-await-in-loop
			await endpointStore.create({
				workspace_id: W,
				user_id: U,
				url: `https://sub${i}.example/h`,
				...(subs[i]!.events ? { events: subs[i]!.events! } : {}),
			})
		}
		return { endpointStore, deliveryStore }
	}

	it('enqueues one delivery per matched subscriber', async () => {
		const { endpointStore, deliveryStore } = await setupWith([
			{}, // wildcard
			{ events: ['token.minted'] },
			{ events: ['run.completed'] }, // unmatched
		])
		const r = await dispatchWebhook(
			{ endpointStore, deliveryStore },
			{
				workspace_id: W,
				event_type: 'token.minted',
				event_id: 'evt_1',
				payload: { foo: 1 },
			}
		)
		expect(r.enqueued).toBe(2)
	})

	it('writes the envelope JSON into the delivery body', async () => {
		const { endpointStore, deliveryStore } = await setupWith([{}])
		await dispatchWebhook(
			{ endpointStore, deliveryStore },
			{
				workspace_id: W,
				event_type: 'token.minted',
				event_id: 'evt_1',
				payload: { foo: 1 },
			}
		)
		const list = await deliveryStore.listByEndpoint(
			(await endpointStore.listForWorkspace(W))[0]!.id
		)
		expect(list).toHaveLength(1)
		const env = JSON.parse(list[0]!.body) as { type: string; id: string; data: unknown }
		expect(env.type).toBe('token.minted')
		expect(env.id).toBe('evt_1')
		expect(env.data).toEqual({ foo: 1 })
	})

	it('enqueues 0 when no subscriber matches', async () => {
		const { endpointStore, deliveryStore } = await setupWith([
			{ events: ['agent.created'] },
		])
		const r = await dispatchWebhook(
			{ endpointStore, deliveryStore },
			{
				workspace_id: W,
				event_type: 'run.completed',
				event_id: 'evt_1',
				payload: {},
			}
		)
		expect(r.enqueued).toBe(0)
	})

	it('wildcard subscribers match every event', async () => {
		const { endpointStore, deliveryStore } = await setupWith([
			{ events: [EVENT_TYPE_WILDCARD] },
		])
		const r = await dispatchWebhook(
			{ endpointStore, deliveryStore },
			{
				workspace_id: W,
				event_type: 'whatever.thing',
				event_id: 'evt_1',
				payload: {},
			}
		)
		expect(r.enqueued).toBe(1)
	})
})
