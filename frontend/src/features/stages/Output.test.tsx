import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Render } from '@/lib/types'
import { renderStage, type Call, PID } from '@/test/storyboard-fixtures'
import { OutputCanvas } from './OutputCanvas'

const T = '2026-10-04T10:00:00Z'
const render = (id: string, version: number, extra: Partial<Render>, params: Record<string, unknown>): Render => ({
  id,
  target_type: 'project',
  target_id: PID,
  kind: 'render',
  version,
  status: 'ready',
  prompt: '',
  params,
  seed: 1,
  media_url: `/api/media/${id}.mp4`,
  created_at: T,
  ...extra,
})

const list = [
  render('r3', 3, {}, { title: 'Act 2', title_auto: false, full: false, scene_range: 'Scenes 2–4', duration_s: 75 }),
  render('r2', 2, { status: 'approved' }, { title: 'Full film', full: true, scene_range: 'Scenes 1–5', duration_s: 192 }),
  render('r1', 1, { status: 'rejected' }, { title: 'Scene 1', full: false, scene_range: 'Scene 1', duration_s: 20 }),
]

function mockOutputApi(renders: Render[]) {
  const calls: Call[] = []
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input).replace(/^\/api/, '').split('?')[0]
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, path, body })
      if (path === `/projects/${PID}/renders`) return json(renders)
      const m = path.match(/^\/generations\/([^/]+)(?:\/(\w+))?$/)
      if (m) {
        const r = renders.find((x) => x.id === m[1])!
        if (method === 'PATCH') return json({ ...r, title: body.title, params: { ...r.params, title: body.title, title_auto: false } })
        if (m[2] === 'approve') return json({ ...r, status: 'approved' })
        if (m[2] === 'reject') return json({ ...r, status: 'rejected' })
      }
      return json([])
    }),
  )
  return calls
}

afterEach(() => vi.unstubAllGlobals())

const titles = () => screen.getAllByRole('article').map((a) => within(a).getByRole('heading').textContent)

describe('Output gallery', () => {
  it('lists stitched videos newest first with range, length and the final-film badge', async () => {
    mockOutputApi(list)
    renderStage(<OutputCanvas />, { scenes: [], shots: [], stage: 'output' })
    const act2 = await screen.findByRole('article', { name: 'Act 2' })
    expect(within(act2).getByText(/Scenes 2–4 · 01:15 · .* · v3/)).toBeInTheDocument()
    expect(titles()).toEqual(['Act 2', 'Full film'])
    const full = screen.getByRole('article', { name: 'Full film' })
    expect(within(full).getByText('Final film')).toBeInTheDocument()
    expect(screen.getByText(/Final film: “Full film” v2/)).toBeInTheDocument()
  })

  it('filters full / partial and shows rejected on request', async () => {
    mockOutputApi(list)
    renderStage(<OutputCanvas />, { scenes: [], shots: [], stage: 'output' })
    const user = userEvent.setup()
    await screen.findByRole('article', { name: 'Act 2' })
    await user.click(screen.getByRole('button', { name: 'Full film' }))
    expect(titles()).toEqual(['Full film'])
    await user.click(screen.getByRole('button', { name: 'Partial' }))
    expect(titles()).toEqual(['Act 2'])
    await user.click(screen.getByRole('switch', { name: 'Show rejected' }))
    expect(titles()).toEqual(['Act 2', 'Scene 1'])
    expect(within(screen.getByRole('article', { name: 'Scene 1' })).getByRole('button', { name: 'Restore' })).toBeInTheDocument()
  })

  it('downloads through the download endpoint and renames inline', async () => {
    const calls = mockOutputApi(list)
    renderStage(<OutputCanvas />, { scenes: [], shots: [], stage: 'output' })
    const user = userEvent.setup()
    const card = await screen.findByRole('article', { name: 'Act 2' })
    expect(within(card).getByRole('link', { name: 'Download Act 2' })).toHaveAttribute('href', '/api/generations/r3/download')

    await user.click(within(card).getByRole('button', { name: 'Rename Act 2' }))
    const field = within(card).getByRole('textbox', { name: 'Name' })
    await user.clear(field)
    await user.type(field, 'The Reef{Enter}')
    expect(calls).toContainEqual({ method: 'PATCH', path: '/generations/r3', body: { title: 'The Reef' } })
    expect(await screen.findByRole('article', { name: 'The Reef' })).toBeInTheDocument()

    // Escape drops an edit without saving
    await user.click(screen.getByRole('button', { name: 'Rename The Reef' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), ' cut{Escape}')
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)
  })

  it('approves as final and plays in a large player', async () => {
    const calls = mockOutputApi(list)
    renderStage(<OutputCanvas />, { scenes: [], shots: [], stage: 'output' })
    const user = userEvent.setup()
    const card = await screen.findByRole('article', { name: 'Act 2' })
    await user.click(within(card).getByRole('button', { name: 'Approve as final' }))
    expect(calls).toContainEqual({ method: 'POST', path: '/generations/r3/approve', body: {} })

    await user.click(within(screen.getByRole('article', { name: 'Full film' })).getAllByRole('button', { name: 'Play Full film' })[0])
    const dialog = screen.getByRole('dialog', { name: 'Full film' })
    expect(within(dialog).getByLabelText('Full film, Original · v2')).toHaveAttribute('src', '/api/media/r2.mp4')
  })

  it('guides to the Reel when nothing has been stitched', async () => {
    mockOutputApi([])
    renderStage(<OutputCanvas />, { scenes: [], shots: [], stage: 'output' })
    expect(await screen.findByText('Nothing stitched yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to Reel' })).toHaveAttribute('href', `/projects/${PID}/reel`)
  })

  it('links an upscaled copy to its source, with a resolution badge and segment progress', async () => {
    const segments = Array.from({ length: 4 }, (_, i) => ({ idx: i, t_start: i * 4, t_end: i * 4 + 4.5, status: i < 1 ? 'done' : i === 1 ? 'generating' : 'queued' }))
    const up = render('r4', 4, { status: 'generating', parent_id: 'r2' }, {
      title: 'Full film · 1080p',
      full: true,
      upscale: { engine: 'fast', target: '1080p', width: 1920, height: 1080, source_id: 'r2' },
      segments,
    })
    mockOutputApi([up, ...list])
    renderStage(<OutputCanvas />, { scenes: [], shots: [], stage: 'output' })
    const card = await screen.findByRole('article', { name: 'Full film · 1080p' })
    expect(within(card).getByText(/Upscaled from v2 · 1080p · fast/)).toBeInTheDocument()
    expect(within(card).getByText('1080p')).toBeInTheDocument()
    expect(within(card).getByText('Segment 2 of 4')).toBeInTheDocument()
    expect(within(card).getByRole('img', { name: '1 of 4 segments done' })).toBeInTheDocument()
    // the source offers Upscale
    expect(within(screen.getByRole('article', { name: 'Full film' })).getByRole('button', { name: 'Upscale Full film' })).toBeInTheDocument()
  })
})
