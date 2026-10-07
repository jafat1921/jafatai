import path from 'node:path'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { adminCredentials } from './env'

// Product-owner review shots. Seeds its own project through the real API, then captures each
// breakpoint. Run with `npm run e2e:screens`.
const OUT = path.resolve(import.meta.dirname, '../../docs/design/screenshots/m1')
const stamp = Date.now().toString(36)

interface Gen {
  id: string
  status: string
  version: number
}

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

async function json<T>(res: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const r = await res
  expect(r.ok(), `${r.url()} → ${r.status()}`).toBeTruthy()
  return r.json() as Promise<T>
}

async function untilReady(api: APIRequestContext, characterId: string, version: number) {
  await expect
    .poll(
      async () => {
        const list = await json<Gen[]>(
          api.get(`/api/generations?target_type=character&target_id=${characterId}&kind=portrait&include_rejected=true`),
        )
        return list.find((g) => g.version === version)?.status
      },
      { timeout: 90_000, intervals: [500, 1000] },
    )
    .toMatch(/ready|approved/)
}

async function seed(api: APIRequestContext) {
  const project = await json<{ id: string }>(
    api.post('/api/projects', {
      data: {
        title: `The Bleaching Reef · ${stamp}`,
        authoring_mode: 'scene_by_scene',
        logline: 'A diver returns to the reef she grew up with and finds it turning white.',
        aspect_ratio: '2.39:1',
        target_runtime_s: 600,
      },
    }),
  )
  const scenes = [
    {
      heading: 'EXT. CORAL REEF – DAY',
      logline: 'Mara drifts over pale coral and realises how much has gone.',
      script_text:
        'MARA drifts over the reef. Where there was colour, there is bone-white coral.\n\nShe slows, one hand hovering above a branch that crumbles at her touch.\n\nNARRATOR (V.O.)\nTen years ago, this reef was alive with colour.\n\nA lone parrotfish noses at the dead branch, then darts away.',
      time_of_day: 'day',
      mood: 'melancholic',
      lighting: 'natural',
    },
    { heading: 'INT. BOAT CABIN – NIGHT', logline: 'She logs the readings by lamplight.', time_of_day: 'night', mood: 'tense' },
    { heading: 'EXT. HARBOUR – DAWN', logline: 'The old fisherman remembers the reef as it was.', time_of_day: 'dawn' },
  ]
  let firstSceneId = ''
  for (const { time_of_day, mood, lighting, ...body } of scenes) {
    const s = await json<{ id: string }>(api.post(`/api/projects/${project.id}/scenes`, { data: body }))
    firstSceneId ||= s.id
    await json(api.patch(`/api/scenes/${s.id}`, { data: { time_of_day, mood: mood ?? null, lighting: lighting ?? null } }))
  }

  const mara = await json<{ id: string }>(
    api.post(`/api/projects/${project.id}/characters`, {
      data: { name: 'Mara', description: 'Marine biologist in her 40s, short grey hair, weathered wetsuit' },
    }),
  )
  const fisher = await json<{ id: string }>(
    api.post(`/api/projects/${project.id}/characters`, { data: { name: 'Old Fisherman', description: 'Sun-creased face, wool cap' } }),
  )
  await json(api.post(`/api/projects/${project.id}/characters`, { data: { name: 'Narrator' } }))

  // fisherman: one approved portrait so the cast grid shows a real image
  const f1 = await json<Gen>(
    api.post('/api/generations', {
      data: { target_type: 'character', target_id: fisher.id, kind: 'portrait', prompt: 'Portrait of an old fisherman, wool cap' },
    }),
  )
  await untilReady(api, fisher.id, 1)
  await json(api.post(`/api/generations/${f1.id}/approve`))

  // Mara: v1 → v2 (note) approved → v3 ready, so the review bar and versions show real history
  const m1 = await json<Gen>(
    api.post('/api/generations', {
      data: { target_type: 'character', target_id: mara.id, kind: 'portrait', prompt: 'Portrait of Mara, grey hair, wetsuit' },
    }),
  )
  await untilReady(api, mara.id, 1)
  const m2 = await json<Gen>(api.post(`/api/generations/${m1.id}/regenerate`, { data: { mode: 'note', note: 'colder light, less smiling' } }))
  await untilReady(api, mara.id, 2)
  await json(api.post(`/api/generations/${m2.id}/approve`))
  await json(api.post(`/api/generations/${m2.id}/regenerate`, { data: { mode: 'same' } }))
  await untilReady(api, mara.id, 3)

  return { projectId: project.id, firstSceneId, maraId: mara.id }
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
}

async function expectNoHorizontalScroll(page: Page) {
  const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }))
  expect(sw, `page scrolls horizontally at ${w}px`).toBeLessThanOrEqual(w)
}

async function shot(page: Page, name: string) {
  await settle(page)
  await expectNoHorizontalScroll(page)
  await page.screenshot({ path: path.join(OUT, `${name}.png`) })
}

test('product-owner screenshots', async ({ page }) => {
  test.setTimeout(300_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/login')
  await shot(page, '1440-login')
  await login(page)
  const { projectId } = await seed(page.request)
  const base = `/projects/${projectId}`

  // 1440 — the full four-column workstation
  await page.goto('/projects')
  await shot(page, '1440-projects')

  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Tide Line')
  await dialog.getByRole('textbox', { name: 'Brief' }).fill('A 20-minute documentary following one diver across a year on a dying reef.')
  await shot(page, '1440-new-project')
  await page.keyboard.press('Escape')

  await page.goto(`${base}/script`)
  await expect(page.getByRole('textbox', { name: 'Heading' })).toHaveValue('EXT. CORAL REEF – DAY')
  await shot(page, '1440-script')

  await page.goto(`${base}/cast`)
  await page.getByRole('button', { name: /Mara/ }).last().click()
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await expect(inspector.locator('figure figcaption')).toHaveText('Approved')
  await inspector.getByRole('button', { name: /^Versions/ }).click()
  await inspector.getByRole('region', { name: 'Versions' }).scrollIntoViewIfNeeded()
  await shot(page, '1440-cast')

  await page.getByRole('button', { name: /^Queue:/ }).click()
  await expect(page.getByRole('dialog', { name: 'Queue' })).toBeVisible()
  await shot(page, '1440-queue')
  await page.keyboard.press('Escape')

  await page.goto('/dev/ui')
  await shot(page, '1440-dev-ui')

  // narrower breakpoints: projects + workspace
  for (const [w, h] of [
    [1280, 800],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h })
    await page.goto('/projects')
    await shot(page, `${w}-projects`)
    await page.goto(`${base}/script`)
    await shot(page, `${w}-script`)
    await page.goto(`${base}/cast`)
    if (w >= 768) await page.getByRole('button', { name: /Mara/ }).last().click()
    await shot(page, `${w}-cast`)
  }

  // the narrowest supported width must not scroll sideways either
  await page.setViewportSize({ width: 360, height: 760 })
  for (const url of ['/projects', `${base}/script`, `${base}/cast`]) {
    await page.goto(url)
    await settle(page)
    await expectNoHorizontalScroll(page)
  }
})
