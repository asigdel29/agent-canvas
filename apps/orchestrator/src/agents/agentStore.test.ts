/**
 * Tests for agentStore.
 *
 * @author asigdel29
 */

import { describe, expect, it } from 'vitest'
import {
	type AgentId,
	AgentNotFoundError,
	AgentValidationError,
	type CreateAgentInput,
	validateCreateInput,
	type WorkspaceId,
} from './agentRecord.js'
import { InMemoryAgentStore } from './agentStore.js'

const WS = 'ws_test' as WorkspaceId
const OWNER = 'gh:123' as never

function fixture(over: Partial<CreateAgentInput> = {}): CreateAgentInput {
	return {
		workspace_id: WS,
		owner_user_id: OWNER,
		name: 'Inbox triage',
		purpose: 'Sort issues',
		model: 'claude-sonnet-4-6',
		system_prompt: 'You sort issues.',
		capabilities: {
			computer_use: { enabled: false, provider: 'none' },
			browser_use: { enabled: false, persist_cookies: false },
			mcp_servers: [],
		},
		...over,
	}
}

describe('InMemoryAgentStore', () => {
	it('create returns the record with an id and timestamps', async () => {
		const store = new InMemoryAgentStore()
		const a = await store.create(fixture())
		expect(a.id).toMatch(/^ag_/)
		expect(a.created_at).toBeTruthy()
		expect(a.updated_at).toBeTruthy()
		expect(a.archived_at).toBeNull()
	})

	it('get returns null when the id is unknown', async () => {
		const store = new InMemoryAgentStore()
		expect(await store.get('ag_missing' as AgentId)).toBeNull()
	})

	it('listByWorkspace returns only the matching workspace, archived excluded', async () => {
		const store = new InMemoryAgentStore()
		const a1 = await store.create(fixture({ name: 'A1' }))
		const a2 = await store.create(fixture({ name: 'A2' }))
		await store.create(fixture({ workspace_id: 'ws_other' as WorkspaceId, name: 'B1' }))
		await store.archive(a1.id)
		const out = await store.listByWorkspace(WS)
		expect(out.map((r) => r.id)).toEqual([a2.id])
	})

	it('listByWorkspace orders newest first', async () => {
		const store = new InMemoryAgentStore()
		const a1 = await store.create(fixture({ name: 'A1' }))
		// Tick the clock by mutating the record's created_at would
		// require fakeTimers; instead create() uses Date.now() which
		// advances monotonically across consecutive calls.
		await new Promise((r) => setTimeout(r, 2))
		const a2 = await store.create(fixture({ name: 'A2' }))
		const out = await store.listByWorkspace(WS)
		expect(out[0]!.id).toBe(a2.id)
		expect(out[1]!.id).toBe(a1.id)
	})

	it('update returns the patched record and bumps updated_at', async () => {
		const store = new InMemoryAgentStore()
		const a = await store.create(fixture())
		const before = a.updated_at
		await new Promise((r) => setTimeout(r, 2))
		const u = await store.update(a.id, { name: 'Renamed' })
		expect(u.name).toBe('Renamed')
		expect(u.updated_at > before).toBe(true)
	})

	it('update throws AgentNotFoundError on a missing id', async () => {
		const store = new InMemoryAgentStore()
		await expect(store.update('ag_missing' as AgentId, { name: 'x' })).rejects.toThrow(
			AgentNotFoundError
		)
	})

	it('archive then get returns null; unarchive brings it back', async () => {
		const store = new InMemoryAgentStore()
		const a = await store.create(fixture())
		await store.archive(a.id)
		expect(await store.get(a.id)).toBeNull()
		await store.unarchive(a.id)
		expect(await store.get(a.id)).not.toBeNull()
	})
})

describe('validateCreateInput', () => {
	it('passes on a normal input', () => {
		expect(() => validateCreateInput(fixture())).not.toThrow()
	})

	it('rejects empty name', () => {
		expect(() => validateCreateInput(fixture({ name: '   ' }))).toThrow(AgentValidationError)
	})

	it('rejects 121-character name', () => {
		expect(() => validateCreateInput(fixture({ name: 'x'.repeat(121) }))).toThrow(
			expect.objectContaining({ field: 'name' })
		)
	})

	it('rejects unknown model', () => {
		expect(() =>
			validateCreateInput(fixture({ model: 'gpt-4' as never }))
		).toThrow(expect.objectContaining({ field: 'model' }))
	})

	it('rejects system_prompt > 32 KiB', () => {
		expect(() =>
			validateCreateInput(fixture({ system_prompt: 'x'.repeat(32 * 1024 + 1) }))
		).toThrow(expect.objectContaining({ field: 'system_prompt' }))
	})

	it('rejects mcp server with empty id', () => {
		expect(() =>
			validateCreateInput(
				fixture({
					capabilities: {
						computer_use: { enabled: false, provider: 'none' },
						browser_use: { enabled: false, persist_cookies: false },
						mcp_servers: [{ id: '', url: 'https://x', trust: 'untrusted' }],
					},
				})
			)
		).toThrow(expect.objectContaining({ field: 'mcp_servers[0].id' }))
	})

	it('rejects mcp server with non-http URL', () => {
		expect(() =>
			validateCreateInput(
				fixture({
					capabilities: {
						computer_use: { enabled: false, provider: 'none' },
						browser_use: { enabled: false, persist_cookies: false },
						mcp_servers: [{ id: 'm1', url: 'javascript:alert(1)', trust: 'untrusted' }],
					},
				})
			)
		).toThrow(expect.objectContaining({ field: 'mcp_servers[0].url' }))
	})

	it('accepts http(s) URLs and known trust levels', () => {
		expect(() =>
			validateCreateInput(
				fixture({
					capabilities: {
						computer_use: { enabled: false, provider: 'none' },
						browser_use: { enabled: false, persist_cookies: false },
						mcp_servers: [
							{ id: 'm1', url: 'https://mcp.example.com/sse', trust: 'untrusted' },
							{ id: 'm2', url: 'http://localhost:9000/sse', trust: 'trusted' },
						],
					},
				})
			)
		).not.toThrow()
	})
})
