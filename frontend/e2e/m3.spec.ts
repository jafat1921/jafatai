import { expect, test, type Page } from '@playwright/test'
import { adminCredentials } from './env'

// Milestone 3 structure against the live backend. Queues no GPU work: shots and seams only.
const stamp = Date.now().toString(36)

async function login(page: Page) {
  const { email, password } = adminCredentials()
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // login lands on Home; the projects grid lives under Video now (/projects still works)
  await page.waitForURL((u) => u.pathname === '/')
  await page.goto('/video/projects')
}

test('locations, shots, seams and render gating', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('radio', { name: 'Scene by scene' }).click()
  await dialog.getByRole('textbox', { name: 'Title' }).fill(`E2E Storyboard ${stamp}`)
  await dialog.getByRole('textbox', { name: 'Title' }).press('Control+Enter')
  await page.waitForURL(/\/projects\/[0-9a-f-]+\/script$/)
  const base = page.url().replace(/\/script$/, '')

  await page.getByRole('button', { name: 'Add the first scene' }).click()
  await page.getByRole('button', { name: 'Write it' }).click()
  await page.getByRole('textbox', { name: 'Heading' }).fill('EXT. HARBOUR – DAWN')
  await page.getByRole('textbox', { name: 'Script' }).fill('The DIVER loads tanks onto the boat.')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 })

  // a location, then link the scene to it from the scene chips
  await page.goto(`${base}/cast`)
  await page.getByRole('button', { name: 'Add location' }).first().click()
  const locDialog = page.getByRole('dialog', { name: 'Add location' })
  await locDialog.getByRole('textbox', { name: 'Name' }).fill('Harbour')
  await locDialog.getByRole('button', { name: 'Add location' }).click()
  await expect(page.getByRole('heading', { name: 'Harbour' })).toBeVisible()
  const scenes = page.getByRole('navigation', { name: 'Scenes' })
  await scenes.getByRole('combobox', { name: 'Location' }).selectOption({ label: 'Harbour (no frame yet)' })

  await page.goto(`${base}/storyboard`)
  await expect(page.getByRole('heading', { name: 'Storyboard your film from the script' })).toBeVisible()
  await page.getByRole('button', { name: 'Break a scene into shots' }).click()
  await page.getByRole('button', { name: 'Add shot' }).first().click()
  await expect(page.getByRole('article', { name: 'Shot 1.1' })).toBeVisible()
  await page.getByRole('toolbar', { name: 'Scene shot actions' }).getByRole('button', { name: 'Add shot' }).click()
  const second = page.getByRole('article', { name: 'Shot 1.2' })
  await expect(second).toBeVisible()

  await page.getByRole('group', { name: 'Seam from 1.1 to 1.2' }).getByRole('radio', { name: /Continue/ }).click()
  await expect(second.getByRole('button', { name: /START frame, linked to 1\.1 END/ })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('article', { name: 'Shot 1.2' }).getByRole('button', { name: /START frame, linked/ })).toBeVisible()

  // L flips it back to Cut once the row is selected
  await page.getByRole('article', { name: 'Shot 1.2' }).getByRole('button', { name: /^END frame/ }).click()
  await page.keyboard.press('l')
  await expect(page.getByRole('article', { name: 'Shot 1.2' }).getByRole('button', { name: /^START frame, empty/ })).toBeVisible()

  await page.goto(`${base}/render`)
  await expect(page.getByRole('link', { name: 'Approve frames in Storyboard' })).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Render scene' })).toBeDisabled()

  // with the mock driver, frames and takes come back in seconds and arrive over SSE
  test.skip((await page.request.get('/api/system/status').then((r) => r.json())).driver !== 'mock', 'real GPU: skip generation')
  await page.goto(`${base}/storyboard`)
  await page.getByRole('button', { name: /Generate all frames/ }).click()
  const first = page.getByRole('article', { name: 'Shot 1.1' })
  await expect(first.getByText('Ready for review')).toHaveCount(2, { timeout: 90_000 })
  await expect(page.getByRole('article', { name: 'Shot 1.2' }).getByText('Ready for review')).toHaveCount(2, { timeout: 90_000 })
  await page.getByRole('button', { name: /Approve all ready/ }).click()
  await expect(first.getByText('Approved')).toHaveCount(2)

  await page.goto(`${base}/render`)
  const row = page.getByRole('article', { name: 'Shot 1.1' })
  await row.getByRole('spinbutton', { name: 'Takes' }).fill('1')
  await row.getByRole('button', { name: 'Render takes' }).click()
  const takeThumb = row.getByRole('button', { name: /^Take 1 of shot 1\.1/ })
  await expect(takeThumb).toBeVisible({ timeout: 10_000 })
  await expect(row.getByText('Ready for review')).toBeVisible({ timeout: 120_000 })
  await page.keyboard.press('k')
  await page.keyboard.press('1')
  await expect(takeThumb).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('complementary', { name: 'Inspector' }).getByRole('button', { name: /Approve/ }).click()
  await expect(takeThumb).toContainText('Chosen')
})
