/**
 * Tests for computerUseProvider.
 *
 * @author asigdel29
 */

import { describe, expect, it } from 'vitest'
import { buildComputerUseContribution } from './computerUseProvider.js'
import type {
	ComputerUseSandbox,
	Point,
	ScrollDirection,
} from './computerUseSandbox.js'

/* -------------------------------------------------------------- *
 * Stub sandbox                                                    *
 * -------------------------------------------------------------- */

interface CallLog {
	calls: string[]
	cursor: Point
	killed: boolean
	screenshotPng: Uint8Array
}

function makeFakeSandbox(log: CallLog): ComputerUseSandbox {
	return {
		display_width_px: 1024,
		display_height_px: 768,
		async screenshot() {
			log.calls.push('screenshot')
			return log.screenshotPng
		},
		async moveMouse(x, y) {
			log.calls.push(`moveMouse:${x},${y}`)
			log.cursor = { x, y }
		},
		async leftClick(x, y) {
			log.calls.push(`leftClick:${x},${y}`)
		},
		async rightClick(x, y) {
			log.calls.push(`rightClick:${x},${y}`)
		},
		async doubleClick(x, y) {
			log.calls.push(`doubleClick:${x},${y}`)
		},
		async middleClick(x, y) {
			log.calls.push(`middleClick:${x},${y}`)
		},
		async leftClickDrag(start, end) {
			log.calls.push(`drag:${start.x},${start.y}->${end.x},${end.y}`)
		},
		async write(text) {
			log.calls.push(`write:${text}`)
		},
		async press(key) {
			log.calls.push(`press:${key}`)
		},
		async scroll(direction: ScrollDirection, amount: number) {
			log.calls.push(`scroll:${direction}:${amount}`)
		},
		async cursorPosition() {
			log.calls.push('cursorPosition')
			return log.cursor
		},
		async kill() {
			log.calls.push('kill')
			log.killed = true
		},
	}
}

function freshLog(): CallLog {
	return {
		calls: [],
		cursor: { x: 0, y: 0 },
		killed: false,
		screenshotPng: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
	}
}

async function buildContribution(
	opts: {
		enabled?: boolean
		provider?: 'e2b' | 'browserbase' | 'none'
		onScreenshot?: (d: string) => void
	} = {}
) {
	const log = freshLog()
	const c = await buildComputerUseContribution({
		config: {
			enabled: opts.enabled ?? true,
			provider: opts.provider ?? 'e2b',
		},
		sandboxFactory: async () => makeFakeSandbox(log),
		...(opts.onScreenshot ? { onScreenshot: opts.onScreenshot } : {}),
	})
	return { contribution: c, log }
}

async function callComputer(
	contribution: Awaited<ReturnType<typeof buildContribution>>['contribution'],
	input: Record<string, unknown>
) {
	const tool = contribution.descriptors.find((d) => d.schema.name === 'computer')
	if (!tool) throw new Error('computer tool not contributed')
	return tool.execute(input)
}

/* -------------------------------------------------------------- *
 * Tests                                                           *
 * -------------------------------------------------------------- */

describe('computerUseProvider', () => {
	it('contributes nothing when disabled', async () => {
		const { contribution } = await buildContribution({ enabled: false })
		expect(contribution.descriptors).toHaveLength(0)
		await contribution.teardown()
	})

	it('contributes nothing when provider is "none"', async () => {
		const { contribution } = await buildContribution({ provider: 'none' })
		expect(contribution.descriptors).toHaveLength(0)
	})

	it('contributes exactly one tool named "computer" with the computer_20241022 type', async () => {
		const { contribution } = await buildContribution()
		expect(contribution.descriptors).toHaveLength(1)
		const schema = contribution.descriptors[0]!.schema as unknown as {
			type?: string
			name: string
			display_width_px: number
			display_height_px: number
		}
		expect(schema.type).toBe('computer_20241022')
		expect(schema.name).toBe('computer')
		expect(schema.display_width_px).toBe(1024)
		expect(schema.display_height_px).toBe(768)
		await contribution.teardown()
	})

	it('does NOT launch the sandbox until the first action', async () => {
		const { contribution, log } = await buildContribution()
		expect(log.calls).toHaveLength(0)
		// teardown without ever using the sandbox is a no-op
		await contribution.teardown()
		expect(log.calls).toHaveLength(0)
		expect(log.killed).toBe(false)
	})

	it('screenshot returns a data: image URI and fires onScreenshot', async () => {
		const seen: string[] = []
		const { contribution } = await buildContribution({ onScreenshot: (d) => seen.push(d) })
		const result = await callComputer(contribution, { action: 'screenshot' })
		expect(result.ok).toBe(true)
		const blocks = (result as { ok: true; content: Array<{ text: string }> }).content
		expect(blocks[0]!.text.startsWith('data:image/png;base64,')).toBe(true)
		expect(seen).toHaveLength(1)
		expect(seen[0]!.startsWith('data:image/png;base64,')).toBe(true)
		await contribution.teardown()
	})

	it('dispatches the full action menu correctly', async () => {
		const { contribution, log } = await buildContribution()
		await callComputer(contribution, { action: 'mouse_move', coordinate: [10, 20] })
		await callComputer(contribution, { action: 'left_click', coordinate: [30, 40] })
		await callComputer(contribution, { action: 'right_click', coordinate: [50, 60] })
		await callComputer(contribution, { action: 'double_click', coordinate: [70, 80] })
		await callComputer(contribution, { action: 'middle_click', coordinate: [90, 100] })
		await callComputer(contribution, {
			action: 'left_click_drag',
			start_coordinate: [1, 2],
			coordinate: [3, 4],
		})
		await callComputer(contribution, { action: 'type', text: 'hello world' })
		await callComputer(contribution, { action: 'key', text: 'Return' })
		await callComputer(contribution, {
			action: 'scroll',
			scroll_direction: 'down',
			scroll_amount: 5,
		})
		await callComputer(contribution, { action: 'cursor_position' })
		expect(log.calls).toEqual([
			'moveMouse:10,20',
			'leftClick:30,40',
			'rightClick:50,60',
			'doubleClick:70,80',
			'middleClick:90,100',
			'drag:1,2->3,4',
			'write:hello world',
			'press:Return',
			'scroll:down:5',
			'cursorPosition',
		])
		await contribution.teardown()
	})

	it('rejects unknown actions with a clear ToolResult error', async () => {
		const { contribution } = await buildContribution()
		const result = await callComputer(contribution, { action: 'self_destruct' })
		expect(result.ok).toBe(false)
		expect((result as { ok: false; error: string }).error).toContain('unknown computer action')
	})

	it('rejects mouse actions with malformed coordinates', async () => {
		const { contribution } = await buildContribution()
		const result = await callComputer(contribution, { action: 'left_click' })
		expect(result.ok).toBe(false)
	})

	it('type / key actions require a text field', async () => {
		const { contribution } = await buildContribution()
		const t = await callComputer(contribution, { action: 'type' })
		expect(t.ok).toBe(false)
		const k = await callComputer(contribution, { action: 'key' })
		expect(k.ok).toBe(false)
	})

	it('teardown kills the sandbox once it has been launched', async () => {
		const { contribution, log } = await buildContribution()
		await callComputer(contribution, { action: 'screenshot' })
		await contribution.teardown()
		expect(log.killed).toBe(true)
		expect(log.calls).toContain('kill')
	})

	it('teardown is idempotent — a second teardown does not double-kill', async () => {
		const { contribution, log } = await buildContribution()
		await callComputer(contribution, { action: 'screenshot' })
		await contribution.teardown()
		await contribution.teardown()
		const killCount = log.calls.filter((c) => c === 'kill').length
		expect(killCount).toBe(1)
	})

	it('describeCall produces human-readable summaries for the approval card', async () => {
		const { contribution } = await buildContribution()
		const tool = contribution.descriptors[0]!
		expect(tool.describeCall({ action: 'screenshot' })).toBe('screenshot')
		expect(tool.describeCall({ action: 'left_click', coordinate: [12, 34] })).toBe(
			'left-click at (12, 34)'
		)
		expect(tool.describeCall({ action: 'type', text: 'hello world' })).toContain('type:')
		await contribution.teardown()
	})

	it('classifies every action as safe (operator opts into computer-use at agent creation)', async () => {
		const { contribution } = await buildContribution()
		expect(contribution.descriptors[0]!.safety).toBe('safe')
	})
})
