import { describe, expect, it } from 'vitest'
import { channelForRoom } from './notify.js'

describe('channelForRoom', () => {
	it('produces a postgres-identifier-safe channel name', () => {
		const name = channelForRoom('room-with-dashes_and_underscores')
		expect(name).toMatch(/^room_[0-9a-z]+$/)
		expect(name).not.toContain('-')
		expect(name.length).toBeLessThan(64) // Postgres identifier cap
	})

	it('is stable for the same room id', () => {
		const a = channelForRoom('room_alpha')
		const b = channelForRoom('room_alpha')
		expect(a).toBe(b)
	})

	it('differentiates different rooms', () => {
		const a = channelForRoom('room_alpha')
		const b = channelForRoom('room_beta')
		expect(a).not.toBe(b)
	})

	it('handles empty input deterministically', () => {
		expect(channelForRoom('')).toBe('room_0')
	})
})
