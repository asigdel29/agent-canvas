import { describe, expect, it } from 'vitest'
import { createLogger } from './logger.js'

function captureSink(): { lines: string[]; sink: (line: string) => void } {
	const lines: string[] = []
	return { lines, sink: (l) => lines.push(l) }
}

describe('logger', () => {
	it('writes one JSON object per log line', () => {
		const cap = captureSink()
		const log = createLogger('debug')
		log.addSink(cap.sink)
		log.info('hello', { a: 1 })
		expect(cap.lines).toHaveLength(1)
		const parsed = JSON.parse(cap.lines[0]!) as Record<string, unknown>
		expect(parsed['level']).toBe('info')
		expect(parsed['msg']).toBe('hello')
		expect(parsed['a']).toBe(1)
		expect(typeof parsed['ts']).toBe('string')
	})

	it('drops messages below the configured threshold', () => {
		const cap = captureSink()
		const log = createLogger('warn')
		log.addSink(cap.sink)
		log.debug('not_logged')
		log.info('not_logged')
		log.warn('logged')
		log.error('logged')
		// the default stdout sink will also be present; cap only captures
		// what was pushed to our sink (which received the same calls).
		expect(cap.lines).toHaveLength(2)
		expect(JSON.parse(cap.lines[0]!)['level']).toBe('warn')
		expect(JSON.parse(cap.lines[1]!)['level']).toBe('error')
	})

	it('serializes Error instances with name/message/stack', () => {
		const cap = captureSink()
		const log = createLogger('error')
		log.addSink(cap.sink)
		const e = new Error('something broke')
		log.error('something_broke', { err: e })
		const parsed = JSON.parse(cap.lines[0]!) as { err: { name: string; message: string; stack: string } }
		expect(parsed.err.name).toBe('Error')
		expect(parsed.err.message).toBe('something broke')
		expect(parsed.err.stack).toContain('Error: something broke')
	})

	it('fires the registered error hook on .error() calls', () => {
		const cap = captureSink()
		const log = createLogger('error')
		log.addSink(cap.sink)
		const seen: Array<{ msg: string; err: unknown }> = []
		log.addErrorHook((msg, err) => seen.push({ msg, err }))
		const e = new Error('boom')
		log.error('it_blew_up', { err: e, route: 'foo' })
		expect(seen).toHaveLength(1)
		expect(seen[0]!.msg).toBe('it_blew_up')
		expect(seen[0]!.err).toBe(e)
	})

	it('does not fire the error hook on non-error levels', () => {
		const cap = captureSink()
		const log = createLogger('debug')
		log.addSink(cap.sink)
		const seen: unknown[] = []
		log.addErrorHook(() => seen.push(1))
		log.warn('warning', { err: new Error('not propagated') })
		// warn includes err in JSON but doesn't propagate to the error hook
		expect(seen).toHaveLength(0)
	})

	it('preserves non-err attrs even when an err is also present', () => {
		const cap = captureSink()
		const log = createLogger('error')
		log.addSink(cap.sink)
		log.error('with_attrs', { route: '/api/x', latency_ms: 123, err: new Error('boom') })
		const parsed = JSON.parse(cap.lines[0]!) as Record<string, unknown>
		expect(parsed['route']).toBe('/api/x')
		expect(parsed['latency_ms']).toBe(123)
		expect((parsed['err'] as { message: string }).message).toBe('boom')
	})

	it('truncates very long stack traces to ~2KB', () => {
		const cap = captureSink()
		const log = createLogger('error')
		log.addSink(cap.sink)
		const e = new Error('long')
		e.stack = 'x'.repeat(10_000)
		log.error('truncate', { err: e })
		const parsed = JSON.parse(cap.lines[0]!) as { err: { stack: string } }
		expect(parsed.err.stack.length).toBeLessThan(2_100)
		expect(parsed.err.stack.endsWith('…')).toBe(true)
	})

	it('hooks that throw do not crash the caller', () => {
		const log = createLogger('error')
		log.addSink(() => undefined)
		log.addErrorHook(() => {
			throw new Error('hook bug')
		})
		// must not throw
		expect(() => log.error('safe', { err: new Error('inner') })).not.toThrow()
	})

	it('setLevel changes the threshold at runtime', () => {
		const cap = captureSink()
		const log = createLogger('error')
		log.addSink(cap.sink)
		log.info('not_logged')
		expect(cap.lines).toHaveLength(0)
		log.setLevel('info')
		log.info('logged_now')
		expect(cap.lines).toHaveLength(1)
	})
})
