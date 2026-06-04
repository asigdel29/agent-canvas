/**
 * End-to-end tests for the first-run entry flow.
 *
 * A fresh visit with no session lands on the sign-in screen. These tests
 * drive a real browser against the built canvas + dev orchestrator and
 * assert the deterministic entry surface (the default github auth mode
 * plus the legal links), which exercises the build, routing, and the
 * auth-config fetch end to end.
 *
 * @author asigdel29
 */

import { expect, test } from '@playwright/test'

test.describe('first-run entry (sign-in)', () => {
	test('shows the sign-in screen on first load', async ({ page }) => {
		await page.goto('/')
		await expect(
			page.getByRole('heading', { name: 'Sign in to agent canvas' })
		).toBeVisible()
	})

	test('offers GitHub sign-in in the default auth mode', async ({ page }) => {
		await page.goto('/')
		await expect(page.getByRole('button', { name: /Sign in with GitHub/ })).toBeVisible()
	})

	test('links to the Terms and Privacy pages', async ({ page }) => {
		await page.goto('/')
		await expect(page.getByRole('link', { name: 'Terms' })).toBeVisible()
		await expect(page.getByRole('link', { name: 'Privacy Policy' })).toBeVisible()
	})
})
