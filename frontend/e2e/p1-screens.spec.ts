import path from 'node:path'
import { test, type Page, type Route } from '@playwright/test'

// UI polish P1 before/after shots. Every /api call is answered here, so no backend or GPU is needed.
//   P1_PHASE=before npx playwright test --project=screens p1-screens
const PHASE = process.env.P1_PHASE === 'after' ? 'after' : 'before'
const OUT = path.resolve(import.meta.dirname, `../../docs/design/screenshots/p1-${PHASE}`)
const T = new Date(Date.now() - 4 * 60_000).toISOString()

const PALETTE = ['#3b2a1a', '#24384a', '#4a2f2f', '#2f4a36', '#40364f', '#4f4430']

function svg(seed: string, w = 1024, h = 1024) {
  const n = [...seed].reduce((a, c) => a + c.charCodeAt(0), 0)
  const a = PALETTE[n % PALETTE.length]
  const b = PALETTE[(n + 2) % PALETTE.length]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.62}" cy="${h * 0.38}" r="${Math.min(w, h) * 0.16}" fill="#e9c98a" opacity=".75"/>
<path d="M0 ${h * 0.78} Q ${w * 0.3} ${h * 0.6} ${w * 0.55} ${h * 0.74} T ${w} ${h * 0.7} V ${h} H 0 Z" fill="#120c07" opacity=".55"/></svg>`
}

const SIZES: Record<string, [number, number]> = { '1:1': [1024, 1024], '16:9': [1344, 768], '9:16': [768, 1344], '3:4': [896, 1152] }

const img = (id: string, prompt: string, aspect = '1:1', extra: Record<string, unknown> = {}) => {
  const [width, height] = SIZES[aspect]
  return {
    id,
    workspace_id: 'w1',
    kind: 'image',
    origin: 'generated',
    title: prompt.slice(0, 40),
    tags: [],
    generation_id: `g-${id}`,
    width,
    height,
    media_url: `/media/${id}.png?a=${aspect}`,
    thumb_url: `/media/${id}.png?a=${aspect}`,
    created_at: T,
    updated_at: T,
    versions_count: 1,
    prompt,
    seed: 1234567,
    params: { model: 'zimage_turbo' },
    ...extra,
  }
}

const vid = (id: string, prompt: string) => ({
  ...img(id, prompt, '16:9'),
  kind: 'video',
  media_url: `/media/${id}.mp4`,
  thumb_url: `/media/${id}.png?a=16:9`,
  duration_s: 5,
  params: { model: 'ltx23_distilled' },
})

const IMAGES = [
  img('pend1', 'A lighthouse keeper in a wool coat, golden hour, 85mm portrait', '3:4', { media_url: null, thumb_url: null, status: 'generating' }),
  img('pend2', 'A lighthouse keeper in a wool coat, golden hour, 85mm portrait', '3:4', { media_url: null, thumb_url: null, status: 'queued' }),
  img('a1', 'Fishing boats in a misty harbour at dawn, cinematic', '16:9'),
  img('a2', 'Fishing boats in a misty harbour at dawn, cinematic', '16:9'),
  img('b1', 'Poster that says "Eid Mubarak", gold calligraphy on deep green', '9:16', { params: { model: 'qwen_image_2512' } }),
  img('c1', 'Ceramic coffee cup on a linen tablecloth, soft window light', '1:1'),
  img('c2', 'Ceramic coffee cup on a linen tablecloth, soft window light', '1:1'),
  img('c3', 'Ceramic coffee cup on a linen tablecloth, soft window light', '1:1'),
  img('c4', 'Ceramic coffee cup on a linen tablecloth, soft window light', '1:1'),
]
const VIDEOS = [vid('v1', 'Slow dolly in on a fisherman mending nets at dawn'), vid('v2', 'Steam rises from the cup, slow push in')]

const JOBS = [
  { id: 'j1', type: 'image_generate', status: 'running', progress: 0.42, message: 'Sampling', attempts: 1, created_at: T, generation_id: 'g-pend1' },
  { id: 'j2', type: 'image_generate', status: 'queued', progress: 0, message: '', attempts: 0, created_at: T, generation_id: 'g-pend2' },
]

const m = (x: Record<string, unknown>) => ({ badge: null, description: '', capabilities: [], available: true, default: false, ...x })
const CATALOG: Record<string, unknown[]> = {
  image: [
    m({ id: 'zimage_turbo', type: 'image', label: 'Z-Image Turbo', badge: 'FAST', description: 'Photoreal text to image', capabilities: ['t2i', 'i2i'], est_seconds: 7, estimate_source: 'measured', default: true }),
    m({ id: 'qwen_image_2512', type: 'image', label: 'Qwen-Image 2512', badge: 'TEXT', description: 'Text inside images, incl. Urdu', capabilities: ['t2i', 'text_render', 'i2i'], est_seconds: 28, speeds: [{ id: 'full', label: 'Full', steps: 30 }, { id: 'lightning4', label: 'Lightning 4-step', steps: 4 }], default_speed: 'full' }),
    m({ id: 'flux2_klein', type: 'image', label: 'FLUX.2 klein 4B', badge: 'FAST', description: 'Very fast general images', capabilities: ['t2i', 'i2i'], est_seconds: 4 }),
  ],
  edit: [
    m({ id: 'qwen_image_edit_2511', type: 'edit', label: 'Qwen-Image-Edit 2511', badge: 'BEST', description: 'Edit and combine up to 3 references', capabilities: ['edit', 'refs'], max_refs: 3, est_seconds: 25, default: true }),
    m({ id: 'flux2_klein_edit', type: 'edit', label: 'FLUX.2 klein 4B (base)', description: 'Reference-guided edits', capabilities: ['edit', 'refs'], max_refs: 3, est_seconds: 9 }),
  ],
  video: [
    m({ id: 'ltx23_distilled', type: 'video', label: 'LTX-2.3', description: 'Text and image to video, with sound', capabilities: ['t2v', 'i2v', 'flf', 'audio', 'longtake'], max_duration_s: 300, est_seconds: 70, default: true, smooth_motion: { available: true } }),
    m({ id: 'ltx23_hq', type: 'video', label: 'LTX-2.3 High quality', badge: 'HQ', description: 'Slower, higher resolution', capabilities: ['t2v', 'i2v', 'flf', 'audio'], max_duration_s: 10.67, est_seconds: 240 }),
    m({ id: 'wan22_t2v', type: 'video', label: 'Wan 2.2 14B', badge: 'NEW', description: 'No sound, text only', capabilities: ['t2v'], max_duration_s: 5, est_seconds: 90 }),
  ],
  upscale: [m({ id: 'seedvr2', type: 'upscale', label: 'SeedVR2', badge: 'BEST', default: true })],
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

async function mockApi(page: Page) {
  await page.route((u) => u.pathname.startsWith('/media/'), (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('.mp4')) return route.fulfill({ status: 404, body: '' })
    const [w, h] = SIZES[url.searchParams.get('a') ?? '1:1'] ?? SIZES['1:1']
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg(url.pathname, w, h) })
  })
  await page.route((u) => u.pathname.startsWith('/api/'), (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname.replace(/^\/api/, '')
    const q = url.searchParams
    if (p === '/events') return route.abort()
    if (p === '/auth/me') return json(route, { id: 'u1', email: 'owner@studio.test', display_name: 'Owner', workspace_id: 'w1', role: 'owner' })
    if (p === '/system/status')
      return json(route, { comfy: { ok: true, url: 'http://gpu:8188', version: '0.3' }, llm: { ok: true, url: 'http://gpu:11434', models: ['a'] }, driver: 'comfy', worker: { alive: true } })
    if (p === '/jobs') return json(route, JOBS)
    if (p === '/models') return json(route, CATALOG[q.get('type') ?? 'image'] ?? [])
    if (p === '/media') return json(route, { items: q.get('kind') === 'video' ? VIDEOS : IMAGES })
    const one = p.match(/^\/media\/(\w+)$/)?.[1]
    if (one) {
      const item = [...IMAGES, ...VIDEOS].find((i) => i.id === one) ?? IMAGES[2]
      return json(route, { ...item, versions: [{ id: item.generation_id, target_type: 'media', target_id: item.id, kind: item.kind, version: 1, status: 'ready', prompt: item.prompt, params: item.params, seed: item.seed, media_url: item.media_url, created_at: T }] })
    }
    if (p === '/brand-kits') return json(route, [{ id: 'k1', name: 'Acme', is_default: true }])
    if (p === '/system/upscale-options')
      return json(route, { engines: [{ id: 'fast', label: 'FlashVSR', available: true, est_gpu_s_per_output_s: 4 }], default_engine: 'fast', targets: ['1080p'] })
    if (p === '/estimate') return json(route, { low_s: 20, high_s: 35, basis: 'measured', samples: 14 })
    if (p === '/dashboard') return json(route, { recent_projects: [], recent_videos: VIDEOS, recent_images: IMAGES, running_jobs: JOBS, quick_recent: [] })
    return json(route, [])
  })
}

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(700)
  await page.screenshot({ path: path.join(OUT, `${name}.png`) })
}

const PAGES: [string, string][] = [
  ['image-create', '/image/generate'],
  ['image-edit', '/image/edit?sources=c1'],
  ['image-to-image', '/image/img2img?source=a1'],
  ['video-create', '/video/create'],
  ['image-to-video', '/video/img2vid?image=a1'],
  ['quick-create', '/video/quick'],
  ['image-library', '/image/library'],
]

test('P1 generation pages', async ({ page }) => {
  test.setTimeout(120_000)
  await mockApi(page)
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h })
    for (const [name, url] of PAGES) {
      await page.goto(url)
      await shot(page, `${w}-${name}`)
    }
  }

  // the new overlays (P1 after only)
  if (PHASE !== 'after') return
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/image/generate')
  await page.getByRole('button', { name: /^Model:/ }).click()
  await shot(page, '1440-extra-model-chip')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^View Fishing boats/ }).first().dispatchEvent('click')
  await shot(page, '1440-extra-lightbox')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^Queue,/ }).click()
  await shot(page, '1440-extra-jobs-tray')
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/image/generate')
  await page.getByRole('button', { name: 'Options' }).click()
  await shot(page, '390-extra-dock-sheet-open')
})
