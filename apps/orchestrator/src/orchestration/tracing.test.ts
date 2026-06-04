/**
 * Tests for tracing.
 *
 * @author asigdel29
 */

import { describe, expect, it } from 'vitest'
import {
	childTraceparent,
	ensureTraceparent,
	newTraceparent,
	parseTraceparent,
} from './tracing.js'

describe('traceparent', () => {
	it('newTraceparent emits the W3C wire format', () => {
		const t = newTraceparent()
		expect(t).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
	})

	it('parseTraceparent round-trips its own output', () => {
		const t = newTraceparent()
		const parsed = parseTraceparent(t)
		expect(parsed).not.toBeNull()
		expect(parsed!.trace_id).toHaveLength(32)
		expect(parsed!.span_id).toHaveLength(16)
		expect(parsed!.flags).toHaveLength(2)
	})

	it('parseTraceparent returns null on malformed input', () => {
		expect(parseTraceparent('not-a-trace')).toBeNull()
		expect(parseTraceparent('')).toBeNull()
		expect(parseTraceparent(undefined)).toBeNull()
		expect(parseTraceparent('00-xyz-abc-01')).toBeNull()
	})

	it('childTraceparent keeps the trace_id and rotates the span_id', () => {
		const root = parseTraceparent(newTraceparent())!
		const child = parseTraceparent(childTraceparent(root))!
		expect(child.trace_id).toBe(root.trace_id)
		expect(child.span_id).not.toBe(root.span_id)
		expect(child.flags).toBe(root.flags)
	})

	it('ensureTraceparent recovers from missing or malformed input', () => {
		const fresh = ensureTraceparent(undefined)
		expect(parseTraceparent(fresh)).not.toBeNull()
		const fresh2 = ensureTraceparent('garbage')
		expect(parseTraceparent(fresh2)).not.toBeNull()
	})

	it('ensureTraceparent extends an existing trace as a child span', () => {
		const root = newTraceparent()
		const childWire = ensureTraceparent(root)
		const rootParsed = parseTraceparent(root)!
		const childParsed = parseTraceparent(childWire)!
		expect(childParsed.trace_id).toBe(rootParsed.trace_id)
		expect(childParsed.span_id).not.toBe(rootParsed.span_id)
	})
})
