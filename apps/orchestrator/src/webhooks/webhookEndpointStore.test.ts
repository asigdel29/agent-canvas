/**
 * Tests for webhookEndpointStore.
 *
 * @author asigdel29
 */

import { describe, expect, it } from 'vitest'
import type { UserId } from '@agent-canvas/orchestrator-types'
import {
	EVENT_TYPE_WILDCARD,
	InMemoryWebhookEndpointStore,
	mintSigningSecret,
} from './webhookEndpointStore.js'
import type { WorkspaceId } from '../tenancy/tenancyTypes.js'

const U = 'gh:1' as UserId
const U_OTHER = 'gh:999' as UserId
const W = 'ws_test' as WorkspaceId
const W_OTHER = 'ws_other' as WorkspaceId

function mkStore() {
	return new InMemoryWebhookEndpointStore()
}

describe('mintSigningSecret', () => {
	it('produces 64-char hex (32 bytes)', () => {
		const s = mintSigningSecret()
		expect(s).toMatch(/^[0-9a-f]{64}$/)
	})

	it('is unique across calls', () => {
		expect(mintSigningSecret()).not.toBe(mintSigningSecret())
	})
})

describe('InMemoryWebhookEndpointStore', () => {
	it('create returns the record and the signing_secret (visible once)', async () => {
		const s = mkStore()
		const r = await s.create({
			workspace_id: W,
			user_id: U,
			url: 'https://api.example.com/hook',
		})
		expect(r.record.id.startsWith('whe_')).toBe(true)
		expect(r.record.workspace_id).toBe(W)
		expect(r.record.url).toBe('https://api.example.com/hook')
		expect(r.signing_secret).toMatch(/^[0-9a-f]{64}$/)
		// Default subscription is the wildcard.
		expect(r.record.events).toEqual([EVENT_TYPE_WILDCARD])
	})

	it('honors a non-empty events list at create time', async () => {
		const s = mkStore()
		const r = await s.create({
			workspace_id: W,
			user_id: U,
			url: 'https://api.example.com/hook',
			events: ['agent.created', 'run.completed'],
		})
		expect(r.record.events).toEqual(['agent.created', 'run.completed'])
	})

	it('defaults to wildcard when an empty events array is passed', async () => {
		const s = mkStore()
		const r = await s.create({
			workspace_id: W,
			user_id: U,
			url: 'https://api.example.com/hook',
			events: [],
		})
		expect(r.record.events).toEqual([EVENT_TYPE_WILDCARD])
	})

	it('listForWorkspace scopes by workspace and hides revoked rows', async () => {
		const s = mkStore()
		const a = await s.create({ workspace_id: W, user_id: U, url: 'https://a.example/h' })
		await s.create({ workspace_id: W, user_id: U, url: 'https://b.example/h' })
		await s.create({ workspace_id: W_OTHER, user_id: U, url: 'https://c.example/h' })
		await s.revoke(a.record.id, U)
		const list = await s.listForWorkspace(W)
		expect(list).toHaveLength(1)
		expect(list[0]!.url).toBe('https://b.example/h')
	})

	it('listForWorkspace omits the signing_secret', async () => {
		const s = mkStore()
		await s.create({ workspace_id: W, user_id: U, url: 'https://a.example/h' })
		const list = await s.listForWorkspace(W)
		for (const item of list) {
			expect((item as unknown as { signing_secret?: string }).signing_secret).toBeUndefined()
		}
	})

	it('getSigningSecret returns the secret for a live endpoint, null for revoked', async () => {
		const s = mkStore()
		const r = await s.create({ workspace_id: W, user_id: U, url: 'https://a.example/h' })
		expect(await s.getSigningSecret(r.record.id)).toBe(r.signing_secret)
		await s.revoke(r.record.id, U)
		expect(await s.getSigningSecret(r.record.id)).toBeNull()
	})

	it('revoke targeting another user is a silent no-op (no existence oracle)', async () => {
		const s = mkStore()
		const r = await s.create({ workspace_id: W, user_id: U, url: 'https://a.example/h' })
		await s.revoke(r.record.id, U_OTHER)
		// Endpoint still live.
		const list = await s.listForWorkspace(W)
		expect(list).toHaveLength(1)
	})

	it('matchSubscribers returns wildcard + exact-match endpoints, skips others', async () => {
		const s = mkStore()
		const wild = await s.create({
			workspace_id: W,
			user_id: U,
			url: 'https://wild.example/h',
		})
		const exact = await s.create({
			workspace_id: W,
			user_id: U,
			url: 'https://exact.example/h',
			events: ['run.completed'],
		})
		await s.create({
			workspace_id: W,
			user_id: U,
			url: 'https://miss.example/h',
			events: ['approval.requested'],
		})
		const matches = await s.matchSubscribers(W, 'run.completed')
		const urls = matches.map((m) => m.record.url).sort()
		expect(urls).toEqual(['https://exact.example/h', 'https://wild.example/h'])
		// Each match carries the signing secret for the dispatcher.
		const wildMatch = matches.find((m) => m.record.id === wild.record.id)
		const exactMatch = matches.find((m) => m.record.id === exact.record.id)
		expect(wildMatch?.signing_secret).toBe(wild.signing_secret)
		expect(exactMatch?.signing_secret).toBe(exact.signing_secret)
	})

	it('matchSubscribers skips revoked endpoints', async () => {
		const s = mkStore()
		const r = await s.create({ workspace_id: W, user_id: U, url: 'https://a.example/h' })
		await s.revoke(r.record.id, U)
		expect(await s.matchSubscribers(W, 'run.completed')).toHaveLength(0)
	})

	it('matchSubscribers does not leak cross-workspace endpoints', async () => {
		const s = mkStore()
		await s.create({ workspace_id: W_OTHER, user_id: U, url: 'https://x.example/h' })
		expect(await s.matchSubscribers(W, 'run.completed')).toHaveLength(0)
	})
})
