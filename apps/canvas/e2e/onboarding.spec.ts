/**
 * End-to-end tests for the first-run entry flow.
 *
 * A fresh visit with no session lands on the sign-in screen. The canvas
 * chooses its action from GET /api/auth/config; these tests stub that
 * response with Playwright route interception so the entry surface is
 * deterministic and independent of whether an orchestrator is running.
 * They assert the default github action and the legal links, plus the
 * unreachable-backend fallback when the config fetch fails.
 *
 * @author asigdel29
 */

import { expect, test, type Page } from '@playwright/test'

/** Stub GET /api/auth/config so the canvas renders a known auth mode. */
async function stubAuthConfig(page: Page, authMode: 'github' | 'open'): Promise<void> {
	await page.route('**/api/auth/config', (route) =>
		route.fulfill({ json: { auth_mode: authMode } })
	)
}

test.describe('first-run entry (sign-in)', () => {
	test('shows the sign-in screen on first load', async ({ page }) => {
		await stubAuthConfig(page, 'github')
		await page.goto('/')
		await expect(
			page.getByRole('heading', { name: 'Sign in to agent canvas' })
		).toBeVisible()
	})

	test('offers GitHub sign-in in the default auth mode', async ({ page }) => {
		await stubAuthConfig(page, 'github')
		await page.goto('/')
		await expect(page.getByRole('button', { name: /Sign in with GitHub/ })).toBeVisible()
	})

	test('links to the Terms and Privacy pages', async ({ page }) => {
		await stubAuthConfig(page, 'github')
		await page.goto('/')
		await expect(page.getByRole('link', { name: 'Terms' })).toBeVisible()
		await expect(page.getByRole('link', { name: 'Privacy Policy' })).toBeVisible()
	})

	test('surfaces an unreachable-backend state with a retry', async ({ page }) => {
		// The orchestrator is down: the auth-config fetch fails. The screen
		// must say so and offer a retry rather than a dead sign-in button.
		await page.route('**/api/auth/config', (route) => route.abort())
		await page.goto('/')
		await expect(page.getByRole('alert')).toContainText(/reach the orchestrator/i)
		await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
	})
})
