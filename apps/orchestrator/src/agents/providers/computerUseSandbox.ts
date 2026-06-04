/**
 * ComputerUseSandbox — narrow interface the computer-use provider
 * depends on. Wraps whatever backing implementation supplies a
 * virtual desktop (E2B today, Browserbase or self-hosted Docker
 * tomorrow).
 *
 * The interface is the smallest set of primitives Anthropic's
 * computer_20241022 tool can be expressed in. Every method
 * returns a Promise so async-only backends fit naturally.
 *
 * Coordinate system: pixels from the top-left of the display, the
 * same convention Anthropic's tool sends. Display dimensions are
 * fixed at construction so the model's coordinate suggestions
 * align with what the sandbox renders.
 *
 * Lifecycle:
 *   - create()        spin up the VM; returns the sandbox handle
 *   - screenshot()    PNG bytes of the current viewport
 *   - moveMouse(x,y)  cursor without click
 *   - leftClick(x,y)  primary click
 *   - rightClick(x,y) context menu
 *   - doubleClick(x,y) two left clicks in quick succession
 *   - middleClick(x,y) middle button (rare; some shells use it)
 *   - leftClickDrag(start, end)  mouse-down at start, drag to end, release
 *   - write(text)     type literal text via the keyboard
 *   - press(key)      send a named key ("Return", "Tab", "Escape", ...)
 *   - scroll(direction, amount)  scroll by N "ticks" up/down/left/right
 *   - cursorPosition()  current pointer location
 *   - kill()          shut the VM down; idempotent
 *
 * Implementations MUST be idempotent on kill() because catalog
 * teardown can fire twice on the failure path.
 * @author asigdel29
 */

export interface Point {
	readonly x: number
	readonly y: number
}

export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

export interface ComputerUseSandbox {
	readonly display_width_px: number
	readonly display_height_px: number

	screenshot(): Promise<Uint8Array>
	moveMouse(x: number, y: number): Promise<void>
	leftClick(x: number, y: number): Promise<void>
	rightClick(x: number, y: number): Promise<void>
	doubleClick(x: number, y: number): Promise<void>
	middleClick(x: number, y: number): Promise<void>
	leftClickDrag(start: Point, end: Point): Promise<void>
	write(text: string): Promise<void>
	press(key: string): Promise<void>
	scroll(direction: ScrollDirection, amount: number): Promise<void>
	cursorPosition(): Promise<Point>
	kill(): Promise<void>
}

/* -------------------------------------------------------------- *
 * E2B adapter                                                     *
 * -------------------------------------------------------------- */

/**
 * @e2b/desktop SDK surface we depend on. Pinned to a narrow
 * interface so we are not coupled to the full SDK type surface
 * (which evolves). At construction we cast the real SDK to this
 * shape — if a future SDK version drops a method, the cast still
 * passes but a runtime call throws TypeError, which the provider
 * catches and surfaces as a tool error.
 */
interface E2BDesktopSandbox {
	screenshot(): Promise<Uint8Array>
	moveMouse(x: number, y: number): Promise<void>
	leftClick(x?: number, y?: number): Promise<void>
	rightClick(x?: number, y?: number): Promise<void>
	doubleClick(x?: number, y?: number): Promise<void>
	middleClick(x?: number, y?: number): Promise<void>
	mouseDown(button?: 'left' | 'right' | 'middle'): Promise<void>
	mouseUp(button?: 'left' | 'right' | 'middle'): Promise<void>
	write(text: string): Promise<void>
	press(key: string): Promise<void>
	scroll(direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<void>
	getCursorPosition(): Promise<{ x: number; y: number }>
	kill(): Promise<void>
}

interface E2BSandboxStatic {
	create(opts?: {
		apiKey?: string
		resolution?: [number, number]
		timeoutMs?: number
	}): Promise<E2BDesktopSandbox>
}

const DEFAULT_DISPLAY_WIDTH = 1024
const DEFAULT_DISPLAY_HEIGHT = 768

export interface E2BComputerUseOptions {
	readonly apiKey: string
	readonly displayWidthPx?: number
	readonly displayHeightPx?: number
	/** Override the sandbox loader; used by tests. */
	readonly sandboxLoader?: () => Promise<E2BSandboxStatic>
}

export class E2BComputerUseSandbox implements ComputerUseSandbox {
	readonly display_width_px: number
	readonly display_height_px: number
	private inner: E2BDesktopSandbox | null = null
	private killed = false

	private constructor(inner: E2BDesktopSandbox, width: number, height: number) {
		this.inner = inner
		this.display_width_px = width
		this.display_height_px = height
	}

	static async create(opts: E2BComputerUseOptions): Promise<E2BComputerUseSandbox> {
		const width = opts.displayWidthPx ?? DEFAULT_DISPLAY_WIDTH
		const height = opts.displayHeightPx ?? DEFAULT_DISPLAY_HEIGHT
		const load =
			opts.sandboxLoader ??
			(async (): Promise<E2BSandboxStatic> => {
				const mod = (await import('@e2b/desktop')) as unknown as {
					Sandbox: E2BSandboxStatic
				}
				return mod.Sandbox
			})
		const Sandbox = await load()
		const inner = await Sandbox.create({
			apiKey: opts.apiKey,
			resolution: [width, height],
		})
		return new E2BComputerUseSandbox(inner, width, height)
	}

	private requireInner(): E2BDesktopSandbox {
		if (!this.inner || this.killed) {
			throw new Error('computer-use sandbox is not active')
		}
		return this.inner
	}

	screenshot(): Promise<Uint8Array> {
		return this.requireInner().screenshot()
	}
	moveMouse(x: number, y: number): Promise<void> {
		return this.requireInner().moveMouse(x, y)
	}
	leftClick(x: number, y: number): Promise<void> {
		return this.requireInner().leftClick(x, y)
	}
	rightClick(x: number, y: number): Promise<void> {
		return this.requireInner().rightClick(x, y)
	}
	doubleClick(x: number, y: number): Promise<void> {
		return this.requireInner().doubleClick(x, y)
	}
	middleClick(x: number, y: number): Promise<void> {
		return this.requireInner().middleClick(x, y)
	}
	async leftClickDrag(start: Point, end: Point): Promise<void> {
		const inner = this.requireInner()
		// E2B exposes mouseDown/Up + moveMouse rather than a one-shot
		// drag primitive. Sequencing: move → press → move → release.
		await inner.moveMouse(start.x, start.y)
		await inner.mouseDown('left')
		await inner.moveMouse(end.x, end.y)
		await inner.mouseUp('left')
	}
	write(text: string): Promise<void> {
		return this.requireInner().write(text)
	}
	press(key: string): Promise<void> {
		return this.requireInner().press(key)
	}
	scroll(direction: ScrollDirection, amount: number): Promise<void> {
		return this.requireInner().scroll(direction, amount)
	}
	cursorPosition(): Promise<Point> {
		return this.requireInner().getCursorPosition()
	}
	async kill(): Promise<void> {
		if (this.killed) return
		this.killed = true
		try {
			await this.inner?.kill()
		} catch {
			// best-effort; sandbox might already be torn down
		}
		this.inner = null
	}
}

/**
 * Construct from env. Returns null when E2B_API_KEY is unset so
 * the caller can disable the capability with a clear startup
 * message rather than failing at first tool call.
 */
export function tryCreateE2BLauncher(): {
	create(): Promise<E2BComputerUseSandbox>
} | null {
	const apiKey = process.env['E2B_API_KEY']
	if (!apiKey) return null
	return {
		create: () =>
			E2BComputerUseSandbox.create({
				apiKey,
				displayWidthPx: numberFromEnv('COMPUTER_USE_WIDTH', DEFAULT_DISPLAY_WIDTH),
				displayHeightPx: numberFromEnv('COMPUTER_USE_HEIGHT', DEFAULT_DISPLAY_HEIGHT),
			}),
	}
}

function numberFromEnv(name: string, fallback: number): number {
	const raw = process.env[name]
	if (!raw) return fallback
	const n = Number.parseInt(raw, 10)
	return Number.isFinite(n) && n > 0 ? n : fallback
}
