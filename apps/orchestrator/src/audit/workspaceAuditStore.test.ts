import { describe, expect, it, vi } from 'vitest'
import type { UserId } from '@agent-canvas/orchestrator-types'
import {
	InMemoryWorkspaceAuditStore,
	clampLimit,
} from './workspaceAuditStore.js'
import type { WorkspaceId } from '../tenancy/tenancyTypes.js'

const W = 'ws_a' as WorkspaceId
const W_OTHER = 'ws_b' as WorkspaceId
const U_A = 'gh:1' as UserId
const U_B = 'gh:2' as UserId

describe('clampLimit', () => {
	it('defaults undefined to 100', () => {
		expect(clampLimit(undefined)).toBe(100)
	})
	it('rejects non-finite and <= 0', () => {
		expect(clampLimit(NaN)).toBe(100)
		expect(clampLimit(0)).toBe(100)
		expect(clampLimit(-50)).toBe(100)
	})
	it('caps at 500', () => {
		expect(clampLimit(1_000_000)).toBe(500)
	})
	it('passes finite values through', () => {
		expect(clampLimit(42)).toBe(42)
	})
	it('floors fractional values', () => {
		expect(clampLimit(15.9)).toBe(15)
	})
})

describe('InMemoryWorkspaceAuditStore.append', () => {
	it('emits an event with id, ts, and the supplied fields', async () => {
		const s = new InMemoryWorkspaceAuditStore()
		const e = await s.append({
			workspace_id: W,
			actor_user_id: U_A,
			action: 'token.minted',
			target_type: 'api_token',
			target_id: 'tok_1',
			details: { name: 'cli', scope: 'read' },
		})
		expect(e.id.startsWith('wae_')).toBe(true)
		expect(e.workspace_id).toBe(W)
		expect(e.actor_user_id).toBe(U_A)
		expect(e.action).toBe('token.minted')
		expect(e.target_id).toBe('tok_1')
		expect(e.details).toEqual({ name: 'cli', scope: 'read' })
		expect(typeof e.created_at).toBe('string')
	})

	it('defaults target_id and details when omitted', async () => {
		const s = new InMemoryWorkspaceAuditStore()
		const e = await s.append({
			workspace_id: W,
			actor_user_id: U_A,
			action: 'workspace.created',
			target_type: 'workspace',
		})
		expect(e.target_id).toBeNull()
		expect(e.details).toEqual({})
	})
})

describe('InMemoryWorkspaceAuditStore.query', () => {
	async function seed() {
		const s = new InMemoryWorkspaceAuditStore()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
		await s.append({
			workspace_id: W,
			actor_user_id: U_A,
			action: 'token.minted',
			target_type: 'api_token',
			target_id: 'tok_1',
		})
		vi.setSystemTime(new Date('2026-01-02T00:00:00Z'))
		await s.append({
			workspace_id: W,
			actor_user_id: U_B,
			action: 'webhook.created',
			target_type: 'webhook_endpoint',
			target_id: 'whe_1',
		})
		vi.setSystemTime(new Date('2026-01-03T00:00:00Z'))
		await s.append({
			workspace_id: W,
			actor_user_id: U_A,
			action: 'token.revoked',
			target_type: 'api_token',
			target_id: 'tok_1',
		})
		// Cross-workspace bleed test.
		await s.append({
			workspace_id: W_OTHER,
			actor_user_id: U_A,
			action: 'token.minted',
			target_type: 'api_token',
			target_id: 'tok_other',
		})
		vi.useRealTimers()
		return s
	}

	it('returns events for the queried workspace only, newest first', async () => {
		const s = await seed()
		const rows = await s.query({ workspace_id: W })
		expect(rows).toHaveLength(3)
		expect(rows[0]!.action).toBe('token.revoked')
		expect(rows[1]!.action).toBe('webhook.created')
		expect(rows[2]!.action).toBe('token.minted')
	})

	it('filters by actor', async () => {
		const s = await seed()
		const rows = await s.query({ workspace_id: W, actor_user_id: U_B })
		expect(rows).toHaveLength(1)
		expect(rows[0]!.actor_user_id).toBe(U_B)
	})

	it('filters by action', async () => {
		const s = await seed()
		const rows = await s.query({ workspace_id: W, action: 'token.minted' })
		expect(rows).toHaveLength(1)
		expect(rows[0]!.action).toBe('token.minted')
	})

	it('filters by since (inclusive)', async () => {
		const s = await seed()
		const rows = await s.query({
			workspace_id: W,
			since: '2026-01-02T00:00:00Z',
		})
		// 2026-01-02 + 2026-01-03 land in window; 2026-01-01 is excluded.
		expect(rows).toHaveLength(2)
		for (const r of rows) {
			expect(Date.parse(r.created_at)).toBeGreaterThanOrEqual(
				Date.parse('2026-01-02T00:00:00Z')
			)
		}
	})

	it('filters by until (inclusive)', async () => {
		const s = await seed()
		const rows = await s.query({
			workspace_id: W,
			until: '2026-01-02T00:00:00Z',
		})
		expect(rows).toHaveLength(2)
		for (const r of rows) {
			expect(Date.parse(r.created_at)).toBeLessThanOrEqual(
				Date.parse('2026-01-02T00:00:00Z')
			)
		}
	})

	it('honors the limit', async () => {
		const s = await seed()
		const rows = await s.query({ workspace_id: W, limit: 1 })
		expect(rows).toHaveLength(1)
		expect(rows[0]!.action).toBe('token.revoked')
	})

	it('clamps a giant limit to 500', async () => {
		const s = await seed()
		const rows = await s.query({ workspace_id: W, limit: 1_000_000 })
		expect(rows.length).toBeLessThanOrEqual(500)
	})

	it('cross-workspace events do not bleed in', async () => {
		const s = await seed()
		const rows = await s.query({ workspace_id: W_OTHER })
		expect(rows).toHaveLength(1)
		expect(rows[0]!.target_id).toBe('tok_other')
	})

	it('combined filters AND together', async () => {
		const s = await seed()
		const rows = await s.query({
			workspace_id: W,
			actor_user_id: U_A,
			action: 'token.revoked',
		})
		expect(rows).toHaveLength(1)
		expect(rows[0]!.target_id).toBe('tok_1')
	})
})
