/**
 * Tests for auditAndDispatch.
 *
 * @author asigdel29
 */

import { describe, expect, it } from 'vitest'
import type { UserId } from '@agent-canvas/orchestrator-types'
import { auditAndDispatch } from './auditAndDispatch.js'
import { InMemoryWorkspaceAuditStore } from './workspaceAuditStore.js'
import { InMemoryWebhookEndpointStore } from '../webhooks/webhookEndpointStore.js'
import { InMemoryWebhookDeliveryStore } from '../webhooks/webhookDeliveryStore.js'
import type { WorkspaceId } from '../tenancy/tenancyTypes.js'

const W = 'ws_a' as WorkspaceId
const U = 'gh:1' as UserId

function setup() {
	const audit = new InMemoryWorkspaceAuditStore()
	const endpointStore = new InMemoryWebhookEndpointStore()
	const deliveryStore = new InMemoryWebhookDeliveryStore()
	return { audit, endpointStore, deliveryStore }
}

describe('auditAndDispatch', () => {
	it('appends the audit row AND enqueues deliveries to wildcard subs', async () => {
		const deps = setup()
		const sub = await deps.endpointStore.create({
			workspace_id: W,
			user_id: U,
			url: 'https://a.example/h',
		})
		const eventId = await auditAndDispatch(deps, {
			workspace_id: W,
			actor_user_id: U,
			action: 'token.minted',
			target_type: 'api_token',
			target_id: 'tok_1',
			details: { name: 'cli', scope: 'read' },
		})
		// Audit row exists.
		const audit = await deps.audit.query({ workspace_id: W })
		expect(audit).toHaveLength(1)
		expect(audit[0]!.action).toBe('token.minted')
		expect(eventId).toBe(audit[0]!.id)
		// Delivery enqueued and carries the audit row id.
		const deliveries = await deps.deliveryStore.listByEndpoint(sub.record.id)
		expect(deliveries).toHaveLength(1)
		expect(deliveries[0]!.event_id).toBe(eventId)
		expect(deliveries[0]!.event_type).toBe('token.minted')
	})

	it('uses webhookPayload when supplied (different shape from details)', async () => {
		const deps = setup()
		const sub = await deps.endpointStore.create({
			workspace_id: W,
			user_id: U,
			url: 'https://a.example/h',
		})
		await auditAndDispatch(deps, {
			workspace_id: W,
			actor_user_id: U,
			action: 'token.minted',
			target_type: 'api_token',
			details: { audit_only: true },
			webhookPayload: { public_field: 'visible' },
		})
		const d = (await deps.deliveryStore.listByEndpoint(sub.record.id))[0]!
		const body = JSON.parse(d.body) as { data: Record<string, unknown> }
		expect(body.data).toEqual({ public_field: 'visible' })
	})

	it('falls back to details when webhookPayload is omitted', async () => {
		const deps = setup()
		const sub = await deps.endpointStore.create({
			workspace_id: W,
			user_id: U,
			url: 'https://a.example/h',
		})
		await auditAndDispatch(deps, {
			workspace_id: W,
			actor_user_id: U,
			action: 'workspace.created',
			target_type: 'workspace',
			details: { name: 'A' },
		})
		const d = (await deps.deliveryStore.listByEndpoint(sub.record.id))[0]!
		const body = JSON.parse(d.body) as { data: Record<string, unknown> }
		expect(body.data).toEqual({ name: 'A' })
	})

	it('is a no-op for deliveries when no subscriber matches', async () => {
		const deps = setup()
		// Subscriber for a different event only.
		const sub = await deps.endpointStore.create({
			workspace_id: W,
			user_id: U,
			url: 'https://a.example/h',
			events: ['agent.created'],
		})
		await auditAndDispatch(deps, {
			workspace_id: W,
			actor_user_id: U,
			action: 'token.minted',
			target_type: 'api_token',
		})
		// Audit still recorded.
		expect(await deps.audit.query({ workspace_id: W })).toHaveLength(1)
		// No delivery enqueued.
		expect(await deps.deliveryStore.listByEndpoint(sub.record.id)).toHaveLength(0)
	})

	it('cross-workspace subscribers do NOT receive the event', async () => {
		const deps = setup()
		const other = await deps.endpointStore.create({
			workspace_id: 'ws_other' as WorkspaceId,
			user_id: U,
			url: 'https://other.example/h',
		})
		await auditAndDispatch(deps, {
			workspace_id: W,
			actor_user_id: U,
			action: 'token.minted',
			target_type: 'api_token',
		})
		expect(await deps.deliveryStore.listByEndpoint(other.record.id)).toHaveLength(0)
	})

	it('audit-store failure does not block the dispatch', async () => {
		const deps = setup()
		const sub = await deps.endpointStore.create({
			workspace_id: W,
			user_id: U,
			url: 'https://a.example/h',
		})
		// Sabotage audit.append.
		deps.audit.append = async () => {
			throw new Error('boom')
		}
		const eventId = await auditAndDispatch(deps, {
			workspace_id: W,
			actor_user_id: U,
			action: 'token.minted',
			target_type: 'api_token',
		})
		expect(eventId).toBeNull()
		// Delivery still enqueued with the synthetic id.
		const d = (await deps.deliveryStore.listByEndpoint(sub.record.id))[0]!
		expect(d.event_id).toMatch(/^evt_local_/)
	})

	it('dispatch failure does not throw out of the helper', async () => {
		const deps = setup()
		// Sabotage dispatch path via the endpoint store.
		deps.endpointStore.matchSubscribers = async () => {
			throw new Error('upstream')
		}
		// Should resolve (the helper swallows dispatch errors).
		await auditAndDispatch(deps, {
			workspace_id: W,
			actor_user_id: U,
			action: 'token.minted',
			target_type: 'api_token',
		})
		// Audit still recorded.
		expect(await deps.audit.query({ workspace_id: W })).toHaveLength(1)
	})
})
