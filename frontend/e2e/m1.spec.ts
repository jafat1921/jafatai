import { expect, test, type Page } from '@playwright/test'
import { adminCredentials } from './env'

// Full M1 journey against the live backend + mock worker. Creates its own uniquely named data.
const stamp = Date.now().toString(36)
const projectTitle = `E2E Reef ${stamp}`
let projectUrl = ''

async function login(page: Page) {
  const { email, password } = adminCredentials()
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/projects')
}

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const figurePill = (page: Page) => inspector(page).locator('figure figcaption')

async function waitReady(page: Page) {
  // the generations list has no polling — reaching "Ready" proves the SSE stream delivered it
  await expect(figurePill(page)).toHaveText('Ready for review', { timeout: 90_000 })
}

test.describe.serial('Milestone 1 journey', () => {
  test('script authoring: create project, scenes, autosave, reorder, chips', async ({ page }) => {
    await login(page)
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()

    await page.getByRole('button', { name: 'New project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByRole('radio', { name: 'Scene by scene' }).click()
    await dialog.getByRole('textbox', { name: 'Title' }).fill(projectTitle)
    await dialog.getByRole('textbox', { name: /Logline/ }).fill('A diver finds the reef turning white.')
    await dialog.getByRole('radio', { name: /2\.39:1 Cinema/ }).click()
    // Ctrl+Enter submits, same as Generate
    await dialog.getByRole('textbox', { name: 'Title' }).press('Control+Enter')
    await page.waitForURL(/\/projects\/[0-9a-f-]+\/script$/)
    projectUrl = page.url()

    await page.getByRole('button', { name: 'Add the first scene' }).click()
    await page.getByRole('button', { name: 'Write it' }).click()
    await page.getByRole('textbox', { name: 'Heading' }).fill('EXT. CORAL REEF – DAY')
    await page.getByRole('textbox', { name: 'Logline' }).fill('The diver sees the bleaching for the first time.')
    await page.getByRole('textbox', { name: 'Script' }).fill('The DIVER drifts over pale coral.\n\nNARRATOR (V.O.)\nTen years ago, this reef was alive.')
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 })

    await page.reload()
    await expect(page.getByRole('textbox', { name: 'Heading' })).toHaveValue('EXT. CORAL REEF – DAY')
    await expect(page.getByRole('textbox', { name: 'Script' })).toHaveValue(/Ten years ago/)
    const main = page.getByRole('main')
    await expect(main.getByText('Locked', { exact: true })).toBeVisible()
    await expect(main.locator('header').getByText('user', { exact: true })).toBeVisible()

    // second scene + reorder
    const scenes = page.getByRole('navigation', { name: 'Scenes' })
    await scenes.getByRole('button', { name: 'Add scene' }).first().click()
    await page.getByRole('button', { name: 'Write it' }).click()
    await page.getByRole('textbox', { name: 'Heading' }).fill('INT. BOAT CABIN – NIGHT')
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 })

    const order = scenes.getByRole('list', { name: 'Scenes in order' }).getByRole('listitem')
    await expect(order).toHaveCount(2)
    await scenes.getByRole('button', { name: 'Move scene 2 up' }).click()
    await expect(order.first()).toContainText('INT. BOAT CABIN')

    // chips on the selected scene (the boat scene, now first)
    await scenes.getByRole('group', { name: 'Time of day' }).getByRole('button', { name: 'Night' }).click()
    await scenes.getByRole('group', { name: 'Mood' }).getByRole('button', { name: 'Tense' }).click()
    await expect(scenes.getByRole('button', { name: 'Tense', exact: true })).toHaveAttribute('aria-pressed', 'true')

    await page.reload()
    await expect(order.first()).toContainText('INT. BOAT CABIN')
    await expect(order.first()).toContainText('Night · Tense')
  })

  test('cast & review loop: portrait, regenerate, approve, reject, queue, logout', async ({ page }) => {
    test.skip(!projectUrl, 'needs the project from the previous step')
    await login(page)
    await page.goto(projectUrl)
    await page.getByRole('tab', { name: 'Cast & World' }).click()
    await page.waitForURL(/\/cast$/)

    await page.getByRole('button', { name: 'Add character' }).first().click()
    const add = page.getByRole('dialog', { name: 'Add character' })
    await add.getByRole('textbox', { name: 'Name' }).fill('Mara')
    await add.getByRole('textbox', { name: 'Description' }).fill('marine biologist, short grey hair, weathered wetsuit')
    await add.getByRole('button', { name: 'Add character' }).click()
    await expect(inspector(page).getByRole('heading', { name: 'Mara' })).toBeVisible()

    // v1 — watch queued/generating → ready over SSE
    await inspector(page).getByRole('button', { name: /Generate portrait/ }).click()
    const pending = inspector(page).getByRole('group', { name: 'Review' }).getByText(/Waiting in queue|Generating/)
    await expect(pending.or(figurePill(page))).toBeVisible()
    await waitReady(page)

    // v2 — regenerate with note
    await inspector(page).getByRole('button', { name: 'More regenerate options' }).click()
    await page.getByRole('menuitem', { name: /With note/ }).click()
    const note = page.getByRole('dialog', { name: 'Regenerate with a note' })
    await note.getByRole('textbox', { name: 'Note' }).fill('less smiling, colder light')
    await note.getByRole('button', { name: /Regenerate/ }).click()
    await expect(inspector(page).getByRole('button', { name: /showing version 2 of 2/ })).toBeVisible({ timeout: 90_000 })
    await waitReady(page)

    await inspector(page).getByRole('button', { name: /showing version 2/ }).click()
    const versions = inspector(page).getByRole('region', { name: 'Versions' })
    await expect(versions.getByRole('listitem')).toHaveCount(2)

    // approve v2
    await inspector(page).getByRole('group', { name: 'Review' }).getByRole('button', { name: /^Approve/ }).click()
    await expect(figurePill(page)).toHaveText('Approved')
    await expect(inspector(page).getByRole('button', { name: 'Unapprove' })).toBeVisible()

    // regenerating an approved item asks first
    await inspector(page).getByRole('button', { name: 'Regenerate', exact: true }).click()
    const confirm = page.getByRole('alertdialog', { name: 'Regenerate an approved item?' })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Regenerate anyway' }).click()
    await expect(inspector(page).getByRole('button', { name: /showing version 3 of 3/ })).toBeVisible({ timeout: 90_000 })
    await waitReady(page)

    // reject v3 → falls back to the approved v2; rejected only visible behind the toggle
    await inspector(page).getByRole('group', { name: 'Review' }).getByRole('button', { name: /^Reject/ }).click()
    await expect(figurePill(page)).toHaveText('Approved')
    await expect(versions.getByRole('listitem')).toHaveCount(2)
    await versions.getByRole('switch', { name: 'Show rejected versions' }).click()
    await expect(versions.getByRole('listitem')).toHaveCount(3)
    await expect(versions.getByText('Rejected', { exact: true })).toBeVisible()

    // queue drawer lists the finished jobs
    await page.getByRole('button', { name: /^Queue:/ }).click()
    const queue = page.getByRole('dialog', { name: 'Queue' })
    await expect(queue.getByRole('region', { name: 'Recent jobs' }).getByText('Done').first()).toBeVisible()
    expect(await queue.getByText('Done', { exact: true }).count()).toBeGreaterThanOrEqual(3)
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: /Account menu/ }).click()
    await page.getByRole('menuitem', { name: 'Log out' }).click()
    await page.waitForURL('**/login')
    await page.goto('/projects')
    await page.waitForURL('**/login')
  })
})
