import { describe, expect, it } from 'vitest'
import type { UserId } from '@agent-canvas/orchestrator-types'
import { InMemoryApiTokenStore, mintRawToken } from './apiTokenStore.js'
import type { WorkspaceId } from '../tenancy/tenancyTypes.js'

const U = 'gh:1' as UserId
const W = 'ws_test' as WorkspaceId

describe('mintRawToken', () => {
	it('produces a 47+ char token with the ack_ prefix', () => {
		const { raw, hash, prefix } = mintRawToken()
		expect(raw.startsWith('ack_')).toBe(true)
		expect(raw.length).toBeGreaterThanOrEqual(47) // ack_ + 43 base64url
		expect(hash).toMatch(/^[0-9a-f]{64}$/) // sha256 hex
		expect(prefix.startsWith('ack_')).toBe(true)
		expect(prefix.endsWith('…')).toBe(true)
	})

	it('produces a different token every call', () => {
		const a = mintRawToken()
		const b = mintRawToken()
		expect(a.raw).not.toBe(b.raw)
		expect(a.hash).not.toBe(b.hash)
	})
})

describe('InMemoryApiTokenStore', () => {
	it('issue returns the record + raw_token; raw_token visible only here', async () => {
		const s = new InMemoryApiTokenStore()
		const r = await s.issue({
			user_id: U,
			workspace_id: W,
			name: 'cli',
			scope: 'read',
		})
		expect(r.raw_token.startsWith('ack_')).toBe(true)
		expect(r.record.token_prefix).not.toBe(r.raw_token)
		expect(r.record.token_prefix.endsWith('…')).toBe(true)
	})

	it('listForUser returns issued tokens, hides raw secret', async () => {
		const s = new InMemoryApiTokenStore()
		await s.issue({ user_id: U, workspace_id: W, name: 'a', scope: 'read' })
		await s.issue({ user_id: U, workspace_id: W, name: 'b', scope: 'write' })
		const list = await s.listForUser(U)
		expect(list).toHaveLength(2)
		// No raw_token field on the listed records.
		for (const item of list) {
			expect((item as unknown as { raw_token?: string }).raw_token).toBeUndefined()
		}
	})

	it('listForUser scopes by user id; other users see nothing', async () => {
		const s = new InMemoryApiTokenStore()
		await s.issue({ user_id: U, workspace_id: W, name: 'a', scope: 'read' })
		await s.issue({ user_id: 'gh:99' as UserId, workspace_id: W, name: 'b', scope: 'read' })
		const list = await s.listForUser(U)
		expect(list).toHaveLength(1)
		expect(list[0]!.name).toBe('a')
	})

	it('verify returns the record for a valid token; null for unknown', async () => {
		const s = new InMemoryApiTokenStore()
		const r = await s.issue({ user_id: U, workspace_id: W, name: 'a', scope: 'read' })
		const ok = await s.verify(r.raw_token)
		expect(ok?.id).toBe(r.record.id)
		const bad = await s.verify('ack_not_a_real_token_at_all_definitely_no')
		expect(bad).toBeNull()
	})

	it('verify bumps last_used_at on success', async () => {
		const s = new InMemoryApiTokenStore()
		const r = await s.issue({ user_id: U, workspace_id: W, name: 'a', scope: 'read' })
		expect(r.record.last_used_at).toBeNull()
		await new Promise((res) => setTimeout(res, 5))
		const verified = await s.verify(r.raw_token)
		expect(verified?.last_used_at).not.toBeNull()
	})

	it('verify rejects revoked tokens', async () => {
		const s = new InMemoryApiTokenStore()
		const r = await s.issue({ user_id: U, workspace_id: W, name: 'a', scope: 'read' })
		await s.revoke(r.record.id, U)
		expect(await s.verify(r.raw_token)).toBeNull()
	})

	it('verify rejects expired tokens', async () => {
		const s = new InMemoryApiTokenStore()
		const past = new Date(Date.now() - 1_000).toISOString()
		const r = await s.issue({
			user_id: U,
			workspace_id: W,
			name: 'a',
			scope: 'read',
			expires_at: past,
		})
		expect(await s.verify(r.raw_token)).toBeNull()
	})

	it('verify rejects tokens without the ack_ prefix', async () => {
		const s = new InMemoryApiTokenStore()
		expect(await s.verify('definitely-not-our-shape')).toBeNull()
		expect(await s.verify('sk-ant-impostor')).toBeNull()
	})

	it('revoke targeting a token the user does not own is a silent no-op', async () => {
		const s = new InMemoryApiTokenStore()
		const r = await s.issue({ user_id: U, workspace_id: W, name: 'a', scope: 'read' })
		await s.revoke(r.record.id, 'gh:999' as UserId) // wrong user
		// Token still works.
		const verified = await s.verify(r.raw_token)
		expect(verified?.id).toBe(r.record.id)
	})

	it('the store never persists the raw token; it is hash-only', async () => {
		const s = new InMemoryApiTokenStore()
		const r = await s.issue({ user_id: U, workspace_id: W, name: 'a', scope: 'read' })
		// Internal map is keyed by id; the record there should not
		// carry the raw secret.
		const internal = (s as unknown as { rows: Map<string, { rec: unknown }> }).rows
		const entry = internal.get(r.record.id)!
		const serialized = JSON.stringify(entry.rec)
		expect(serialized).not.toContain(r.raw_token)
	})
})
