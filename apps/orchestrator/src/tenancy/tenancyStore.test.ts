import { describe, expect, it } from 'vitest'
import type { UserId } from '@agent-canvas/orchestrator-types'
import { InMemoryTenancyStore } from './tenancyStore.js'
import {
	type WorkspaceId,
	roleAtLeast,
	TenancyForbiddenError,
	TenancyNotFoundError,
} from './tenancyTypes.js'

const GH = (id: string) => ({
	github_id: id,
	github_login: `user-${id}`,
	email: `u${id}@example.com`,
	name: `User ${id}`,
})

describe('roleAtLeast', () => {
	it('orders correctly across all four roles', () => {
		expect(roleAtLeast('owner', 'viewer')).toBe(true)
		expect(roleAtLeast('admin', 'member')).toBe(true)
		expect(roleAtLeast('member', 'admin')).toBe(false)
		expect(roleAtLeast('viewer', 'member')).toBe(false)
		expect(roleAtLeast('owner', 'owner')).toBe(true)
	})
})

describe('InMemoryTenancyStore', () => {
	it('upsertGithubUser creates a new row on first call', async () => {
		const s = new InMemoryTenancyStore()
		const u = await s.upsertGithubUser(GH('42'))
		expect(u.id).toBe('gh:42')
		expect(u.github_login).toBe('user-42')
		expect(u.email).toBe('u42@example.com')
	})

	it('upsertGithubUser updates email + login on second call, keeps id', async () => {
		const s = new InMemoryTenancyStore()
		const first = await s.upsertGithubUser(GH('42'))
		const second = await s.upsertGithubUser({
			github_id: '42',
			github_login: 'user-42-renamed',
			email: 'new@example.com',
			name: 'Renamed',
		})
		expect(second.id).toBe(first.id)
		expect(second.github_login).toBe('user-42-renamed')
		expect(second.email).toBe('new@example.com')
	})

	it('createWorkspace makes the creator the owner', async () => {
		const s = new InMemoryTenancyStore()
		const u = await s.upsertGithubUser(GH('1'))
		const ws = await s.createWorkspace('My workspace', u.id)
		expect(ws.owner_user_id).toBe(u.id)
		const m = await s.getMembership(u.id, ws.id)
		expect(m?.role).toBe('owner')
	})

	it('createWorkspace throws when the user does not exist', async () => {
		const s = new InMemoryTenancyStore()
		await expect(s.createWorkspace('x', 'gh:ghost' as UserId)).rejects.toThrow(
			TenancyNotFoundError
		)
	})

	it('ensureSoloWorkspace creates one when missing, reuses when present', async () => {
		const s = new InMemoryTenancyStore()
		const u = await s.upsertGithubUser(GH('1'))
		const first = await s.ensureSoloWorkspace(u.id, "u1's workspace")
		const second = await s.ensureSoloWorkspace(u.id, "should be ignored")
		expect(first.id).toBe(second.id)
		expect(first.name).toBe("u1's workspace")
	})

	it('listWorkspacesForUser returns all workspaces the user is a member of', async () => {
		const s = new InMemoryTenancyStore()
		const u1 = await s.upsertGithubUser(GH('1'))
		const u2 = await s.upsertGithubUser(GH('2'))
		const ws1 = await s.createWorkspace('A', u1.id)
		const ws2 = await s.createWorkspace('B', u2.id)
		await s.addMember(ws2.id, u1.id, 'member')
		const list = await s.listWorkspacesForUser(u1.id)
		const ids = list.map((e) => e.workspace.id).sort()
		expect(ids).toEqual([ws1.id, ws2.id].sort())
	})

	it('requireMembership succeeds at exact role', async () => {
		const s = new InMemoryTenancyStore()
		const u = await s.upsertGithubUser(GH('1'))
		const ws = await s.createWorkspace('A', u.id)
		const m = await s.requireMembership(u.id, ws.id, 'owner')
		expect(m.role).toBe('owner')
	})

	it('requireMembership succeeds at higher role', async () => {
		const s = new InMemoryTenancyStore()
		const u = await s.upsertGithubUser(GH('1'))
		const ws = await s.createWorkspace('A', u.id)
		// owner satisfies viewer requirement
		const m = await s.requireMembership(u.id, ws.id, 'viewer')
		expect(m.role).toBe('owner')
	})

	it('requireMembership throws when user has no membership', async () => {
		const s = new InMemoryTenancyStore()
		const owner = await s.upsertGithubUser(GH('1'))
		const stranger = await s.upsertGithubUser(GH('999'))
		const ws = await s.createWorkspace('A', owner.id)
		await expect(s.requireMembership(stranger.id, ws.id, 'viewer')).rejects.toThrow(
			TenancyForbiddenError
		)
	})

	it('requireMembership throws when role is insufficient', async () => {
		const s = new InMemoryTenancyStore()
		const owner = await s.upsertGithubUser(GH('1'))
		const lurker = await s.upsertGithubUser(GH('2'))
		const ws = await s.createWorkspace('A', owner.id)
		await s.addMember(ws.id, lurker.id, 'viewer')
		// viewer cannot satisfy member+
		await expect(s.requireMembership(lurker.id, ws.id, 'member')).rejects.toThrow(
			TenancyForbiddenError
		)
	})

	it('addMember updates role on conflict (upsert semantics)', async () => {
		const s = new InMemoryTenancyStore()
		const owner = await s.upsertGithubUser(GH('1'))
		const other = await s.upsertGithubUser(GH('2'))
		const ws = await s.createWorkspace('A', owner.id)
		await s.addMember(ws.id, other.id, 'viewer')
		await s.addMember(ws.id, other.id, 'admin')
		const m = await s.getMembership(other.id, ws.id)
		expect(m?.role).toBe('admin')
	})

	it('archived workspaces vanish from list and getWorkspace', async () => {
		const s = new InMemoryTenancyStore()
		const u = await s.upsertGithubUser(GH('1'))
		const ws = await s.createWorkspace('A', u.id)
		// emulate archive by setting archived_at (no public method yet; this
		// reaches into the internal map for the test only)
		;((s as unknown) as {
			workspaces: Map<WorkspaceId, { archived_at: string | null }>
		}).workspaces.set(ws.id, {
			...ws,
			archived_at: new Date().toISOString(),
		} as never)
		expect(await s.getWorkspace(ws.id)).toBeNull()
		expect(await s.listWorkspacesForUser(u.id)).toHaveLength(0)
	})

	it('listMembers returns the joined user + membership, owner-first', async () => {
		const s = new InMemoryTenancyStore()
		const owner = await s.upsertGithubUser(GH('1'))
		const admin = await s.upsertGithubUser(GH('2'))
		const member = await s.upsertGithubUser(GH('3'))
		const ws = await s.createWorkspace('A', owner.id)
		await s.addMember(ws.id, admin.id, 'admin')
		await s.addMember(ws.id, member.id, 'member')
		const list = await s.listMembers(ws.id)
		expect(list).toHaveLength(3)
		expect(list[0]!.membership.role).toBe('owner')
		expect(list[1]!.membership.role).toBe('admin')
		expect(list[2]!.membership.role).toBe('member')
		expect(list[0]!.user.id).toBe(owner.id)
	})

	it('setMemberRole updates the role and returns the new record', async () => {
		const s = new InMemoryTenancyStore()
		const owner = await s.upsertGithubUser(GH('1'))
		const u2 = await s.upsertGithubUser(GH('2'))
		const ws = await s.createWorkspace('A', owner.id)
		await s.addMember(ws.id, u2.id, 'viewer')
		const r = await s.setMemberRole(ws.id, u2.id, 'admin')
		expect(r?.role).toBe('admin')
	})

	it('setMemberRole returns null for an unknown member', async () => {
		const s = new InMemoryTenancyStore()
		const owner = await s.upsertGithubUser(GH('1'))
		const ws = await s.createWorkspace('A', owner.id)
		const r = await s.setMemberRole(ws.id, 'gh:999' as UserId, 'admin')
		expect(r).toBeNull()
	})

	it('setMemberRole refuses to demote the last owner', async () => {
		const s = new InMemoryTenancyStore()
		const owner = await s.upsertGithubUser(GH('1'))
		const ws = await s.createWorkspace('A', owner.id)
		await expect(s.setMemberRole(ws.id, owner.id, 'admin')).rejects.toBeInstanceOf(
			TenancyForbiddenError
		)
	})

	it('setMemberRole allows demoting an owner when a second owner exists', async () => {
		const s = new InMemoryTenancyStore()
		const a = await s.upsertGithubUser(GH('1'))
		const b = await s.upsertGithubUser(GH('2'))
		const ws = await s.createWorkspace('A', a.id)
		await s.addMember(ws.id, b.id, 'owner')
		const r = await s.setMemberRole(ws.id, a.id, 'admin')
		expect(r?.role).toBe('admin')
	})

	it('removeMember deletes and returns the prior membership', async () => {
		const s = new InMemoryTenancyStore()
		const owner = await s.upsertGithubUser(GH('1'))
		const u2 = await s.upsertGithubUser(GH('2'))
		const ws = await s.createWorkspace('A', owner.id)
		await s.addMember(ws.id, u2.id, 'member')
		const prior = await s.removeMember(ws.id, u2.id)
		expect(prior?.user_id).toBe(u2.id)
		expect(await s.getMembership(u2.id, ws.id)).toBeNull()
	})

	it('removeMember refuses to remove the last owner', async () => {
		const s = new InMemoryTenancyStore()
		const owner = await s.upsertGithubUser(GH('1'))
		const ws = await s.createWorkspace('A', owner.id)
		await expect(s.removeMember(ws.id, owner.id)).rejects.toBeInstanceOf(
			TenancyForbiddenError
		)
	})

	it('findUserByGithubLogin is case-insensitive and exact-match', async () => {
		const s = new InMemoryTenancyStore()
		const u = await s.upsertGithubUser({
			...GH('1'),
			github_login: 'AliceCodes',
		})
		expect((await s.findUserByGithubLogin('alicecodes'))?.id).toBe(u.id)
		expect((await s.findUserByGithubLogin('ALICECODES'))?.id).toBe(u.id)
		expect(await s.findUserByGithubLogin('bob')).toBeNull()
	})

	it('findUserByGithubLogin trims whitespace', async () => {
		const s = new InMemoryTenancyStore()
		const u = await s.upsertGithubUser({
			...GH('1'),
			github_login: 'alice',
		})
		expect((await s.findUserByGithubLogin('  alice  '))?.id).toBe(u.id)
	})
})

// Silence unused-import lint for the few helpers we still reference indirectly.
void TenancyNotFoundError
