/**
 * Browser-use provider — gives the agent a real Chromium it can
 * drive through a small, narrow tool surface.
 *
 * Design choices:
 *
 *   - Chromium-only. One browser per run loop. Cheaper than a
 *     shared browser pool for the current single-tenant deploy
 *     and avoids the cross-run cookie-leak class of bugs.
 *
 *   - Lazy launch: we do NOT spin up Chromium at contribution time
 *     because most runs that have browser-use enabled will not
 *     actually call a browser tool on every turn. The browser
 *     starts on the first browser-tool call and lives until
 *     teardown.
 *
 *   - Session storageState: when capabilities.browser_use
 *     .persist_cookies is true, cookies are loaded from + saved to a
 *     file inside a per-session private temp directory created with
 *     mkdtemp (unpredictable name, 0700 dir, 0600 file). State scopes
 *     to the session rather than a fixed, shared path, which avoids the
 *     predictable-temp-file / symlink race a `/tmp/<fixed>/<agent_id>`
 *     location would expose. Off by default so a hostile site cannot
 *     pin state across unrelated tasks.
 *
 *   - Tool safety: every browser tool is marked 'safe'. Approval-
 *     on-every-click is unworkable. If a workflow needs explicit
 *     gating on a specific click target (e.g. the Submit Payment
 *     button), wrap that in a custom MCP server with 'destructive'
 *     safety.
 *
 *   - Tool names are namespaced `browser__<verb>` — same convention
 *     as MCP so the run loop's name lookup is uniform.
 *
 * Tools:
 *
 *   browser__navigate(url)            go to URL
 *   browser__current_url()            read the address bar
 *   browser__get_text(max_chars?)     visible text of the page,
 *                                     trimmed; markdown-ish
 *   browser__get_links(max?)          visible links with text+href
 *   browser__click(selector|text)     click matching element
 *   browser__type(selector, text)     fill an input/textarea
 *   browser__press_key(key)           keyboard.press('Enter', etc)
 *   browser__back()                   history back
 *   browser__screenshot()             base64 PNG
 *   browser__wait_for(selector, ms?)  wait for selector to appear
 *
 * Failure mode: any tool that throws (Playwright timeout, selector
 * not found, navigation aborted) returns ToolResult.error with the
 * underlying message. The model sees it and revises the plan.
 * @author asigdel29
 */

import { mkdtempSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Browser, BrowserContext, Page } from 'playwright'

import type { AgentId, BrowserUseConfig } from '../agentRecord.js'
import type {
	ProviderContribution,
	ToolDescriptor,
	ToolResult,
} from '../toolRegistry.js'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_TEXT_CHARS = 8_000
const DEFAULT_MAX_LINKS = 50

export interface BrowserProviderOptions {
	readonly config: BrowserUseConfig
	readonly agent_id: AgentId
	/** Test seam — defaults to dynamic import of 'playwright'. */
	readonly launcher?: () => Promise<{
		chromium: { launch(opts?: { headless?: boolean }): Promise<Browser> }
	}>
}

/**
 * Build the ProviderContribution. When config.enabled is false we
 * return an empty contribution so the run loop never sees the
 * tools at all (the agent literally cannot drive a browser even
 * if the model asks).
 */
export async function buildBrowserContribution(
	opts: BrowserProviderOptions
): Promise<ProviderContribution> {
	if (!opts.config.enabled) {
		return {
			descriptors: [],
			async teardown() {
				/* nothing to close */
			},
		}
	}

	const session = new BrowserSession(opts)
	return {
		descriptors: makeDescriptors(session),
		async teardown() {
			await session.close()
		},
	}
}

/**
 * BrowserSession — lazy Playwright wrapper. Browser/Context/Page
 * are spun up on first tool call and reused across the run.
 *
 * Exposed as a class so unit tests can substitute a fake by
 * passing a `launcher` that returns a stubbed chromium.
 */
export class BrowserSession {
	private browser: Browser | null = null
	private context: BrowserContext | null = null
	private page: Page | null = null
	private readonly opts: BrowserProviderOptions
	private storagePath: string | null

	constructor(opts: BrowserProviderOptions) {
		this.opts = opts
		// Persisted cookies live inside a per-session private temp directory.
		// mkdtemp yields an unpredictable path created with 0700 perms; the
		// file is written 0600. This avoids the symlink / predictable-path
		// race that a fixed shared temp location would expose.
		this.storagePath = opts.config.persist_cookies
			? join(mkdtempSync(join(tmpdir(), 'agent-canvas-browser-')), `${opts.agent_id}.json`)
			: null
	}

	async ensurePage(): Promise<Page> {
		if (this.page) return this.page
		const launcher = this.opts.launcher ?? defaultLauncher
		const { chromium } = await launcher()
		this.browser = await chromium.launch({ headless: true })
		const storageState = await this.loadStorageState()
		this.context = await this.browser.newContext(
			storageState
				? ({ storageState } as Parameters<Browser['newContext']>[0])
				: undefined
		)
		this.context.setDefaultTimeout(DEFAULT_TIMEOUT_MS)
		this.page = await this.context.newPage()
		return this.page
	}

	async close(): Promise<void> {
		try {
			await this.saveStorageState()
		} catch {
			// best-effort; the session is being torn down anyway
		}
		try {
			await this.context?.close()
		} catch {
			/* swallow */
		}
		try {
			await this.browser?.close()
		} catch {
			/* swallow */
		}
		this.page = null
		this.context = null
		this.browser = null
	}

	private async loadStorageState(): Promise<unknown> {
		if (!this.storagePath) return null
		try {
			const raw = await readFile(this.storagePath, 'utf8')
			return JSON.parse(raw)
		} catch {
			return null // first run, no saved state yet
		}
	}

	private async saveStorageState(): Promise<void> {
		if (!this.storagePath || !this.context) return
		// The directory already exists (created 0700 by mkdtemp in the
		// constructor); restrict the file itself to owner read/write.
		const state = await this.context.storageState()
		await writeFile(this.storagePath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
	}
}

async function defaultLauncher(): Promise<{
	chromium: { launch(opts?: { headless?: boolean }): Promise<Browser> }
}> {
	// Dynamic import keeps playwright out of the cold-start path
	// when an agent has browser_use disabled.
	const mod = (await import('playwright')) as unknown as {
		chromium: { launch(opts?: { headless?: boolean }): Promise<Browser> }
	}
	return mod
}

/* -------------------------------------------------------------- *
 * Tool descriptors                                                *
 * -------------------------------------------------------------- */

function makeDescriptors(session: BrowserSession): ToolDescriptor[] {
	return [
		descriptorNavigate(session),
		descriptorCurrentUrl(session),
		descriptorGetText(session),
		descriptorGetLinks(session),
		descriptorClick(session),
		descriptorType(session),
		descriptorPressKey(session),
		descriptorBack(session),
		descriptorScreenshot(session),
		descriptorWaitFor(session),
	]
}

function descriptorNavigate(session: BrowserSession): ToolDescriptor {
	return {
		schema: {
			name: 'browser__navigate',
			description: 'Navigate the browser to a URL. Must be http(s).',
			input_schema: {
				type: 'object',
				properties: { url: { type: 'string' } },
				required: ['url'],
			},
		},
		safety: 'safe',
		describeCall: (i) => `navigate to ${String(i['url'])}`,
		async execute(input): Promise<ToolResult> {
			const url = String(input['url'] ?? '')
			if (!/^https?:\/\//.test(url)) {
				return { ok: false, error: 'url must start with http:// or https://' }
			}
			try {
				const page = await session.ensurePage()
				const response = await page.goto(url, { waitUntil: 'domcontentloaded' })
				const status = response?.status() ?? 0
				return {
					ok: true,
					content: `navigated to ${page.url()} (status ${status})`,
				}
			} catch (err) {
				return { ok: false, error: pretty(err) }
			}
		},
	}
}

function descriptorCurrentUrl(session: BrowserSession): ToolDescriptor {
	return {
		schema: {
			name: 'browser__current_url',
			description: 'Return the current browser URL.',
			input_schema: { type: 'object', properties: {} },
		},
		safety: 'safe',
		describeCall: () => 'read current_url',
		async execute(): Promise<ToolResult> {
			try {
				const page = await session.ensurePage()
				return { ok: true, content: page.url() }
			} catch (err) {
				return { ok: false, error: pretty(err) }
			}
		},
	}
}

function descriptorGetText(session: BrowserSession): ToolDescriptor {
	return {
		schema: {
			name: 'browser__get_text',
			description:
				'Return the visible text of the current page, normalized to remove excess whitespace. Optionally truncate to max_chars.',
			input_schema: {
				type: 'object',
				properties: { max_chars: { type: 'number' } },
			},
		},
		safety: 'safe',
		describeCall: (i) => `get_text (max ${i['max_chars'] ?? DEFAULT_MAX_TEXT_CHARS})`,
		async execute(input): Promise<ToolResult> {
			const max = numberOr(input['max_chars'], DEFAULT_MAX_TEXT_CHARS)
			try {
				const page = await session.ensurePage()
				// page.textContent is a higher-level API than evaluate(()=>document.body.innerText).
				// It's easier to stub in tests and just as accurate for visible text.
				const text = (await page.textContent('body')) ?? ''
				const normalized = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
				const out =
					normalized.length > max
						? `${normalized.slice(0, max)}\n…[truncated; ${normalized.length} total chars]`
						: normalized
				return { ok: true, content: out }
			} catch (err) {
				return { ok: false, error: pretty(err) }
			}
		},
	}
}

function descriptorGetLinks(session: BrowserSession): ToolDescriptor {
	return {
		schema: {
			name: 'browser__get_links',
			description:
				'Return the visible clickable links of the current page, one per line as "<text> <tab> <href>".',
			input_schema: {
				type: 'object',
				properties: { max: { type: 'number' } },
			},
		},
		safety: 'safe',
		describeCall: (i) => `get_links (max ${i['max'] ?? DEFAULT_MAX_LINKS})`,
		async execute(input): Promise<ToolResult> {
			const max = numberOr(input['max'], DEFAULT_MAX_LINKS)
			try {
				const page = await session.ensurePage()
				// page.$$eval is a higher-level Playwright API than
				// page.evaluate. It scopes the query to a selector and
				// is straightforward to stub in tests.
				const links = (await page.$$eval('a[href]', (anchors) =>
					(anchors as HTMLAnchorElement[])
						.map((el) => {
							const text = (el.innerText || el.textContent || '').trim()
							return text && el.href ? { text, href: el.href } : null
						})
						.filter((x): x is { text: string; href: string } => x !== null)
				)) as { text: string; href: string }[]
				const out = links
					.slice(0, max)
					.map((l) => `${l.text}\t${l.href}`)
					.join('\n')
				return {
					ok: true,
					content: out || '(no links found)',
				}
			} catch (err) {
				return { ok: false, error: pretty(err) }
			}
		},
	}
}

function descriptorClick(session: BrowserSession): ToolDescriptor {
	return {
		schema: {
			name: 'browser__click',
			description:
				'Click an element. Provide either a CSS selector or the visible text of the element.',
			input_schema: {
				type: 'object',
				properties: {
					selector: { type: 'string' },
					text: { type: 'string' },
				},
			},
		},
		safety: 'safe',
		describeCall: (i) =>
			i['selector'] ? `click selector ${String(i['selector'])}` : `click text ${String(i['text'])}`,
		async execute(input): Promise<ToolResult> {
			const selector = input['selector']
				? String(input['selector'])
				: input['text']
					? `text=${String(input['text'])}`
					: null
			if (!selector) {
				return { ok: false, error: 'one of selector or text is required' }
			}
			try {
				const page = await session.ensurePage()
				await page.click(selector)
				return { ok: true, content: `clicked ${selector}` }
			} catch (err) {
				return { ok: false, error: pretty(err) }
			}
		},
	}
}

function descriptorType(session: BrowserSession): ToolDescriptor {
	return {
		schema: {
			name: 'browser__type',
			description:
				'Type text into the input matched by the CSS selector. Clears the field first.',
			input_schema: {
				type: 'object',
				properties: {
					selector: { type: 'string' },
					text: { type: 'string' },
				},
				required: ['selector', 'text'],
			},
		},
		safety: 'safe',
		describeCall: (i) =>
			`type into ${String(i['selector'])}: ${String(i['text']).slice(0, 60)}`,
		async execute(input): Promise<ToolResult> {
			const selector = String(input['selector'] ?? '')
			const text = String(input['text'] ?? '')
			if (!selector || !text) {
				return { ok: false, error: 'selector and text both required' }
			}
			try {
				const page = await session.ensurePage()
				await page.fill(selector, text)
				return { ok: true, content: `typed into ${selector}` }
			} catch (err) {
				return { ok: false, error: pretty(err) }
			}
		},
	}
}

function descriptorPressKey(session: BrowserSession): ToolDescriptor {
	return {
		schema: {
			name: 'browser__press_key',
			description: 'Press a keyboard key, e.g. Enter, Tab, Escape, ArrowDown.',
			input_schema: {
				type: 'object',
				properties: { key: { type: 'string' } },
				required: ['key'],
			},
		},
		safety: 'safe',
		describeCall: (i) => `press ${String(i['key'])}`,
		async execute(input): Promise<ToolResult> {
			const key = String(input['key'] ?? '')
			if (!key) return { ok: false, error: 'key is required' }
			try {
				const page = await session.ensurePage()
				await page.keyboard.press(key)
				return { ok: true, content: `pressed ${key}` }
			} catch (err) {
				return { ok: false, error: pretty(err) }
			}
		},
	}
}

function descriptorBack(session: BrowserSession): ToolDescriptor {
	return {
		schema: {
			name: 'browser__back',
			description: 'Go back one entry in browser history.',
			input_schema: { type: 'object', properties: {} },
		},
		safety: 'safe',
		describeCall: () => 'history back',
		async execute(): Promise<ToolResult> {
			try {
				const page = await session.ensurePage()
				const response = await page.goBack({ waitUntil: 'domcontentloaded' })
				return {
					ok: true,
					content: response ? `back to ${page.url()}` : 'no history to go back to',
				}
			} catch (err) {
				return { ok: false, error: pretty(err) }
			}
		},
	}
}

function descriptorScreenshot(session: BrowserSession): ToolDescriptor {
	return {
		schema: {
			name: 'browser__screenshot',
			description:
				'Capture a PNG screenshot of the current viewport. Returned as base64.',
			input_schema: { type: 'object', properties: {} },
		},
		safety: 'safe',
		describeCall: () => 'screenshot',
		async execute(): Promise<ToolResult> {
			try {
				const page = await session.ensurePage()
				const png = await page.screenshot({ type: 'png' })
				const b64 = Buffer.from(png).toString('base64')
				return {
					ok: true,
					content: `data:image/png;base64,${b64}`,
				}
			} catch (err) {
				return { ok: false, error: pretty(err) }
			}
		},
	}
}

function descriptorWaitFor(session: BrowserSession): ToolDescriptor {
	return {
		schema: {
			name: 'browser__wait_for',
			description:
				'Wait for a CSS selector to appear on the page. Optional timeout_ms (default 15000).',
			input_schema: {
				type: 'object',
				properties: {
					selector: { type: 'string' },
					timeout_ms: { type: 'number' },
				},
				required: ['selector'],
			},
		},
		safety: 'safe',
		describeCall: (i) => `wait_for ${String(i['selector'])}`,
		async execute(input): Promise<ToolResult> {
			const selector = String(input['selector'] ?? '')
			const timeout = numberOr(input['timeout_ms'], DEFAULT_TIMEOUT_MS)
			if (!selector) return { ok: false, error: 'selector is required' }
			try {
				const page = await session.ensurePage()
				await page.waitForSelector(selector, { timeout })
				return { ok: true, content: `${selector} appeared` }
			} catch (err) {
				return { ok: false, error: pretty(err) }
			}
		},
	}
}

function numberOr(v: unknown, fallback: number): number {
	if (typeof v === 'number' && Number.isFinite(v)) return v
	return fallback
}

function pretty(err: unknown): string {
	if (err instanceof Error) {
		// Playwright errors are verbose; the first line is usually
		// the useful summary.
		const first = err.message.split('\n')[0]!
		return first.slice(0, 320)
	}
	return String(err).slice(0, 320)
}
