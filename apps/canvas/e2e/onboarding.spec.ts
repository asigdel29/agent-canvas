import { expect, test } from '@playwright/test'

test.describe('first-run onboarding (E1 empty state)', () => {
	test('shows the four-tile starter menu and connects on click', async ({ page }) => {
		await page.goto('/')

		// E1 empty state: centered title + four tiles.
		await expect(page.getByRole('heading', { name: 'Connect a tool to start' })).toBeVisible()

		const tiles = ['GitHub', 'Linear', 'Slack', 'Vercel']
		for (const label of tiles) {
			await expect(page.getByRole('button', { name: label })).toBeVisible()
		}
		await expect(page.getByText('You can add more after.')).toBeVisible()

		// Click GitHub. The empty state collapses; the canvas + chrome
		// appear with a green-dot GitHub tile in the strip and a
		// pending approval card in the inbox.
		await page.getByRole('button', { name: 'GitHub' }).click()

		await expect(page.getByRole('navigation', { name: 'Configured connectors' })).toBeVisible()
		await expect(page.getByRole('region', { name: 'Pending approvals' })).toBeVisible()
		await expect(page.getByRole('region', { name: 'Spend' })).toBeVisible()
	})

	test('approving the demo card removes it from the inbox', async ({ page }) => {
		await page.goto('/')
		await page.getByRole('button', { name: 'GitHub' }).click()

		const inbox = page.getByRole('region', { name: 'Pending approvals' })
		await expect(inbox.getByRole('article')).toHaveCount(1)

		await inbox.getByRole('button', { name: 'Approve' }).click()
		await expect(inbox.getByRole('article')).toHaveCount(0)
	})

	test('rejecting the demo card also removes it', async ({ page }) => {
		await page.goto('/')
		await page.getByRole('button', { name: 'Linear' }).click()

		const inbox = page.getByRole('region', { name: 'Pending approvals' })
		await expect(inbox.getByRole('article')).toHaveCount(1)

		await inbox.getByRole('button', { name: 'Reject' }).click()
		await expect(inbox.getByRole('article')).toHaveCount(0)
	})
})
