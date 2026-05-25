/**
 * Computer-use provider — exposes Anthropic's built-in
 * `computer_20241022` tool, dispatching every model-requested
 * action against a ComputerUseSandbox.
 *
 * The model sends a single tool named "computer" with an `input`
 * shape that discriminates on `action`. We translate each action
 * to the sandbox interface and return either text confirmation or
 * (for screenshot/cursor_position) a structured content block
 * the model can read.
 *
 * Why one tool with action dispatch rather than ten standard
 * tools: this is Anthropic's defined contract. The model is
 * already trained on the shape. We just route.
 *
 * Screenshot streaming:
 *   Every successful screenshot publishes the data URI through the
 *   optional `onScreenshot` callback. The run-start route hooks
 *   this to the room event bus so the canvas's AgentShape can
 *   render the latest screenshot as a thumbnail in near-real time.
 *
 * Safety:
 *   All actions are 'safe'. Approval-on-every-click is unworkable
 *   for full computer use; the operator enabled the capability
 *   deliberately and accepts the risk. Sensitive operations should
 *   be wrapped in custom MCP tools with 'destructive' safety.
 *
 * Lifecycle:
 *   - Sandbox creation is LAZY: we do not spin up the VM at
 *     contribution build time. The first model-requested action
 *     creates it. Many runs with computer_use enabled may not
 *     actually call the computer tool every turn.
 *   - Teardown kills the VM via sandbox.kill(). Idempotent.
 *   - The sandboxFactory is async so a kill on a sandbox that
 *     never launched is a no-op.
 */

import type {
	ComputerToolSchema,
	StandardToolSchema,
} from '../anthropicClient.js'
import type {
	ProviderContribution,
	ToolDescriptor,
	ToolResult,
} from '../toolRegistry.js'
import type { ComputerUseConfig } from '../agentRecord.js'
import type { ComputerUseSandbox, ScrollDirection } from './computerUseSandbox.js'

const DEFAULT_DISPLAY_WIDTH = 1024
const DEFAULT_DISPLAY_HEIGHT = 768

export interface ComputerUseProviderOptions {
	readonly config: ComputerUseConfig
	/** Constructs the sandbox on first use. Returns null to refuse. */
	readonly sandboxFactory: () => Promise<ComputerUseSandbox>
	readonly displayWidthPx?: number
	readonly displayHeightPx?: number
	/**
	 * Called after every successful screenshot. The provider passes
	 * the data: URI; consumers typically forward it to a room SSE
	 * bus so the canvas can update the AgentShape thumbnail.
	 */
	readonly onScreenshot?: (dataUri: string) => void
}

/**
 * Build the ProviderContribution. When the capability is disabled
 * (or the provider is 'none'), the contribution is empty so the
 * computer tool is not even exposed to the model.
 */
export async function buildComputerUseContribution(
	opts: ComputerUseProviderOptions
): Promise<ProviderContribution> {
	if (!opts.config.enabled || opts.config.provider === 'none') {
		return {
			descriptors: [],
			async teardown() {
				/* nothing to close */
			},
		}
	}

	const session = new ComputerUseSession(opts)
	return {
		descriptors: [makeComputerDescriptor(session, opts)],
		async teardown() {
			await session.close()
		},
	}
}

/**
 * Wraps lazy sandbox creation. Sandbox starts on the first
 * action; subsequent actions reuse it.
 */
export class ComputerUseSession {
	private sandbox: ComputerUseSandbox | null = null
	constructor(private readonly opts: ComputerUseProviderOptions) {}

	async ensureSandbox(): Promise<ComputerUseSandbox> {
		if (this.sandbox) return this.sandbox
		this.sandbox = await this.opts.sandboxFactory()
		return this.sandbox
	}

	async close(): Promise<void> {
		const sb = this.sandbox
		this.sandbox = null
		if (sb) {
			try {
				await sb.kill()
			} catch {
				/* best-effort */
			}
		}
	}
}

/* -------------------------------------------------------------- *
 * Action dispatch                                                 *
 * -------------------------------------------------------------- */

interface ActionInput {
	action: string
	coordinate?: readonly [number, number] | number[]
	start_coordinate?: readonly [number, number] | number[]
	text?: string
	scroll_direction?: ScrollDirection
	scroll_amount?: number
	[key: string]: unknown
}

function makeComputerDescriptor(
	session: ComputerUseSession,
	opts: ComputerUseProviderOptions
): ToolDescriptor {
	const width = opts.displayWidthPx ?? DEFAULT_DISPLAY_WIDTH
	const height = opts.displayHeightPx ?? DEFAULT_DISPLAY_HEIGHT

	const computerSchema: ComputerToolSchema = {
		type: 'computer_20241022',
		name: 'computer',
		display_width_px: width,
		display_height_px: height,
	}

	// ToolDescriptor.schema is the union of standard and computer
	// schemas. The run loop ships the schema through to Anthropic
	// verbatim; both shapes JSON-serialize identically to what
	// Anthropic expects.
	return {
		schema: computerSchema as unknown as StandardToolSchema,
		safety: 'safe',
		describeCall: (input) => describeAction(input as ActionInput),
		async execute(input): Promise<ToolResult> {
			const action = (input as ActionInput).action
			if (typeof action !== 'string') {
				return { ok: false, error: 'computer tool: missing action field' }
			}
			try {
				const sandbox = await session.ensureSandbox()
				return await dispatchAction(sandbox, input as ActionInput, opts.onScreenshot)
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				return { ok: false, error: `computer action ${action} failed: ${msg}` }
			}
		},
	}
}

function describeAction(input: ActionInput): string {
	switch (input.action) {
		case 'screenshot':
			return 'screenshot'
		case 'cursor_position':
			return 'read cursor position'
		case 'mouse_move':
			return `move mouse to ${asCoord(input.coordinate)}`
		case 'left_click':
			return `left-click at ${asCoord(input.coordinate)}`
		case 'right_click':
			return `right-click at ${asCoord(input.coordinate)}`
		case 'double_click':
			return `double-click at ${asCoord(input.coordinate)}`
		case 'middle_click':
			return `middle-click at ${asCoord(input.coordinate)}`
		case 'left_click_drag':
			return `drag from ${asCoord(input.start_coordinate)} to ${asCoord(input.coordinate)}`
		case 'type':
			return `type: ${(input.text ?? '').slice(0, 60)}`
		case 'key':
			return `press key: ${input.text ?? ''}`
		case 'scroll':
			return `scroll ${input.scroll_direction ?? '?'} by ${input.scroll_amount ?? 0}`
		default:
			return `unknown action ${input.action}`
	}
}

async function dispatchAction(
	sandbox: ComputerUseSandbox,
	input: ActionInput,
	onScreenshot?: (dataUri: string) => void
): Promise<ToolResult> {
	switch (input.action) {
		case 'screenshot': {
			const png = await sandbox.screenshot()
			const dataUri = `data:image/png;base64,${Buffer.from(png).toString('base64')}`
			onScreenshot?.(dataUri)
			// Return the image as a content block so the model sees
			// the pixels, not just a text confirmation.
			return {
				ok: true,
				content: [
					{
						type: 'text',
						text: dataUri,
					},
				],
			}
		}
		case 'cursor_position': {
			const p = await sandbox.cursorPosition()
			return { ok: true, content: `cursor at (${p.x}, ${p.y})` }
		}
		case 'mouse_move': {
			const [x, y] = mustCoord(input.coordinate)
			await sandbox.moveMouse(x, y)
			return { ok: true, content: `moved to (${x}, ${y})` }
		}
		case 'left_click': {
			const [x, y] = mustCoord(input.coordinate)
			await sandbox.leftClick(x, y)
			return { ok: true, content: `left-clicked (${x}, ${y})` }
		}
		case 'right_click': {
			const [x, y] = mustCoord(input.coordinate)
			await sandbox.rightClick(x, y)
			return { ok: true, content: `right-clicked (${x}, ${y})` }
		}
		case 'double_click': {
			const [x, y] = mustCoord(input.coordinate)
			await sandbox.doubleClick(x, y)
			return { ok: true, content: `double-clicked (${x}, ${y})` }
		}
		case 'middle_click': {
			const [x, y] = mustCoord(input.coordinate)
			await sandbox.middleClick(x, y)
			return { ok: true, content: `middle-clicked (${x}, ${y})` }
		}
		case 'left_click_drag': {
			const [sx, sy] = mustCoord(input.start_coordinate)
			const [ex, ey] = mustCoord(input.coordinate)
			await sandbox.leftClickDrag({ x: sx, y: sy }, { x: ex, y: ey })
			return { ok: true, content: `dragged (${sx},${sy}) → (${ex},${ey})` }
		}
		case 'type': {
			const text = input.text ?? ''
			if (!text) return { ok: false, error: 'type action requires text' }
			await sandbox.write(text)
			return { ok: true, content: `typed ${text.length} chars` }
		}
		case 'key': {
			const key = input.text ?? ''
			if (!key) return { ok: false, error: 'key action requires text' }
			await sandbox.press(key)
			return { ok: true, content: `pressed ${key}` }
		}
		case 'scroll': {
			const dir: ScrollDirection = input.scroll_direction ?? 'down'
			const amount = input.scroll_amount ?? 3
			await sandbox.scroll(dir, amount)
			return { ok: true, content: `scrolled ${dir} by ${amount}` }
		}
		default:
			return {
				ok: false,
				error: `unknown computer action: ${input.action}`,
			}
	}
}

function asCoord(c: ActionInput['coordinate']): string {
	const t = tryCoord(c)
	return t ? `(${t[0]}, ${t[1]})` : '?'
}
function tryCoord(c: ActionInput['coordinate']): [number, number] | null {
	if (!Array.isArray(c) || c.length < 2) return null
	const [x, y] = c
	if (typeof x !== 'number' || typeof y !== 'number') return null
	return [x, y]
}
function mustCoord(c: ActionInput['coordinate']): [number, number] {
	const t = tryCoord(c)
	if (!t) throw new Error('coordinate must be [x, y]')
	return t
}
