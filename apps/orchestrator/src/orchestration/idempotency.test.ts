import { describe, expect, it } from 'vitest'
import {
	IdempotencyConflictError,
	InMemoryIdempotencyStore,
} from './idempotency.js'

describe('InMemoryIdempotencyStore', () => {
	it('returns true on first claim, false on second', async () => {
		const store = new InMemoryIdempotencyStore()
		expect(await store.claim('key_a', 'run_1')).toBe(true)
		expect(await store.claim('key_a', 'run_1')).toBe(false)
	})

	it('throws IdempotencyConflictError when a different run claims the same key', async () => {
		const store = new InMemoryIdempotencyStore()
		await store.claim('key_a', 'run_1')
		await expect(store.claim('key_a', 'run_2')).rejects.toThrow(IdempotencyConflictError)
	})

	it('has() reports membership', async () => {
		const store = new InMemoryIdempotencyStore()
		expect(await store.has('key_a')).toBe(false)
		await store.claim('key_a', 'run_1')
		expect(await store.has('key_a')).toBe(true)
	})

	it('distinct keys are independent', async () => {
		const store = new InMemoryIdempotencyStore()
		await store.claim('key_a', 'run_1')
		await store.claim('key_b', 'run_2')
		expect(await store.has('key_a')).toBe(true)
		expect(await store.has('key_b')).toBe(true)
	})
})
