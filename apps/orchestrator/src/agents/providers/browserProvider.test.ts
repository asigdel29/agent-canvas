import { describe, expect, it } from 'vitest'
import type { AgentId } from '../agentRecord.js'
import { buildBrowserContribution } from './browserProvider.js'

/* -------------------------------------------------------------- *
 * Stubs: minimal fake Playwright surface                          *
 * -------------------------------------------------------------- */

interface PageState {
	currentUrl: string
	innerText: string
	links: { text: string; href: string }[]
	gotoStatus: number
	clickedSelectors: string[]
	typedInto: { selector: string; text: string }[]
	pressedKeys: string[]
	screenshotPng: Uint8Array
}

function makeStubChromium(state: PageState) {
	const page = {
		url: () => state.currentUrl,
		async goto(url: string) {
			state.currentUrl = url
			return { status: () => state.gotoStatus }
		},
		async textContent(_selector: string) {
			return state.innerText
		},
		async $$eval(_selector: string, _fn: unknown) {
			return state.links
		},
		async click(selector: string) {
			state.clickedSelectors.push(selector)
		},
		async fill(selector: string, text: string) {
			state.typedInto.push({ selector, text })
		},
		keyboard: {
			async press(key: string) {
				state.pressedKeys.push(key)
			},
		},
		async goBack() {
			return { status: () => 200 }
		},
		async screenshot() {
			return state.screenshotPng
		},
		async waitForSelector() {
			/* always succeed */
		},
	}
	const context = {
		setDefaultTimeout(_ms: number) {},
		async newPage() {
			return page
		},
		async storageState() {
			return { cookies: [], origins: [] }
		},
		async close() {},
	}
	const browser = {
		async newContext() {
			return context
		},
		async close() {},
	}
	return {
		chromium: {
			async launch() {
				return browser
			},
		},
		page,
	}
}

function freshState(): PageState {
	return {
		currentUrl: 'about:blank',
		innerText: '',
		links: [],
		gotoStatus: 200,
		clickedSelectors: [],
		typedInto: [],
		pressedKeys: [],
		screenshotPng: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), // "‰PNG"
	}
}

async function buildWithStub(state: PageState) {
	const stub = makeStubChromium(state)
	const contribution = await buildBrowserContribution({
		config: { enabled: true, persist_cookies: false },
		agent_id: 'ag_test' as AgentId,
		launcher: async () => ({ chromium: stub.chromium }) as never,
	})
	return { contribution, stub }
}

function findTool(
	contribution: Awaited<ReturnType<typeof buildWithStub>>['contribution'],
	name: string
) {
	const t = contribution.descriptors.find((d) => d.schema.name === name)
	if (!t) throw new Error(`tool ${name} not found`)
	return t
}

/* -------------------------------------------------------------- *
 * Tests                                                           *
 * -------------------------------------------------------------- */

describe('browserProvider', () => {
	it('returns an empty contribution when browser_use is disabled', async () => {
		const c = await buildBrowserContribution({
			config: { enabled: false, persist_cookies: false },
			agent_id: 'ag_x' as AgentId,
		})
		expect(c.descriptors).toHaveLength(0)
		await c.teardown() // must not throw
	})

	it('contributes the full ten-tool surface when enabled', async () => {
		const { contribution } = await buildWithStub(freshState())
		const names = contribution.descriptors.map((d) => d.schema.name).sort()
		expect(names).toEqual(
			[
				'browser__back',
				'browser__click',
				'browser__current_url',
				'browser__get_links',
				'browser__get_text',
				'browser__navigate',
				'browser__press_key',
				'browser__screenshot',
				'browser__type',
				'browser__wait_for',
			].sort()
		)
		// All browser tools are 'safe' — see provider doc comment for why.
		for (const d of contribution.descriptors) {
			expect(d.safety).toBe('safe')
		}
		await contribution.teardown()
	})

	it('rejects non-http(s) URLs without launching the browser', async () => {
		const state = freshState()
		const { contribution } = await buildWithStub(state)
		const navigate = findTool(contribution, 'browser__navigate')
		const result = await navigate.execute({ url: 'javascript:alert(1)' })
		expect(result.ok).toBe(false)
		// Browser never opened — currentUrl stayed at about:blank.
		expect(state.currentUrl).toBe('about:blank')
		await contribution.teardown()
	})

	it('navigate sets the page URL and surfaces the status', async () => {
		const state = freshState()
		state.gotoStatus = 200
		const { contribution } = await buildWithStub(state)
		const result = await findTool(contribution, 'browser__navigate').execute({
			url: 'https://example.com',
		})
		expect(result).toEqual({
			ok: true,
			content: 'navigated to https://example.com (status 200)',
		})
		await contribution.teardown()
	})

	it('get_text returns truncated visible text with a marker', async () => {
		const state = freshState()
		state.innerText = 'a'.repeat(20_000)
		const { contribution } = await buildWithStub(state)
		await findTool(contribution, 'browser__navigate').execute({
			url: 'https://example.com',
		})
		const result = await findTool(contribution, 'browser__get_text').execute({
			max_chars: 100,
		})
		expect(result.ok).toBe(true)
		const content = (result as { ok: true; content: string }).content
		expect(content).toContain('[truncated; 20000 total chars]')
		expect(content.length).toBeLessThan(200)
		await contribution.teardown()
	})

	it('get_links renders text/href pairs and caps at max', async () => {
		const state = freshState()
		state.links = [
			{ text: 'Home', href: 'https://example.com/' },
			{ text: 'Docs', href: 'https://example.com/docs' },
			{ text: 'Pricing', href: 'https://example.com/pricing' },
		]
		const { contribution } = await buildWithStub(state)
		await findTool(contribution, 'browser__navigate').execute({
			url: 'https://example.com',
		})
		const result = await findTool(contribution, 'browser__get_links').execute({
			max: 2,
		})
		expect(result.ok).toBe(true)
		const content = (result as { ok: true; content: string }).content
		expect(content.split('\n')).toHaveLength(2)
		expect(content).toContain('Home\thttps://example.com/')
		await contribution.teardown()
	})

	it('click accepts a CSS selector AND a text fallback', async () => {
		const state = freshState()
		const { contribution } = await buildWithStub(state)
		await findTool(contribution, 'browser__navigate').execute({
			url: 'https://example.com',
		})
		await findTool(contribution, 'browser__click').execute({ selector: 'button.submit' })
		await findTool(contribution, 'browser__click').execute({ text: 'Sign in' })
		expect(state.clickedSelectors).toEqual(['button.submit', 'text=Sign in'])
		await contribution.teardown()
	})

	it('click without selector OR text returns a validation error', async () => {
		const { contribution } = await buildWithStub(freshState())
		const result = await findTool(contribution, 'browser__click').execute({})
		expect(result.ok).toBe(false)
	})

	it('type fills the input matched by selector', async () => {
		const state = freshState()
		const { contribution } = await buildWithStub(state)
		await findTool(contribution, 'browser__navigate').execute({
			url: 'https://example.com',
		})
		await findTool(contribution, 'browser__type').execute({
			selector: '#email',
			text: 'hi@example.com',
		})
		expect(state.typedInto).toEqual([{ selector: '#email', text: 'hi@example.com' }])
		await contribution.teardown()
	})

	it('press_key forwards to keyboard.press', async () => {
		const state = freshState()
		const { contribution } = await buildWithStub(state)
		await findTool(contribution, 'browser__navigate').execute({
			url: 'https://example.com',
		})
		await findTool(contribution, 'browser__press_key').execute({ key: 'Enter' })
		expect(state.pressedKeys).toEqual(['Enter'])
		await contribution.teardown()
	})

	it('screenshot returns a data: PNG URI', async () => {
		const state = freshState()
		const { contribution } = await buildWithStub(state)
		await findTool(contribution, 'browser__navigate').execute({
			url: 'https://example.com',
		})
		const result = await findTool(contribution, 'browser__screenshot').execute({})
		expect(result.ok).toBe(true)
		const content = (result as { ok: true; content: string }).content
		expect(content.startsWith('data:image/png;base64,')).toBe(true)
		// PNG signature 0x89,0x50,0x4e,0x47 -> "iVBORw==" in base64
		// (the stub returns exactly the 4-byte signature).
		expect(content.slice(22)).toBe('iVBORw==')
		await contribution.teardown()
	})

	it('teardown is idempotent and survives if the browser never launched', async () => {
		const { contribution } = await buildWithStub(freshState())
		await contribution.teardown()
		await contribution.teardown() // second call is a no-op
	})
})
