import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { upscaleOptions } from '@/test/quick-fixtures'
import { media, mockApi, renderAt, T } from '@/test/media-fixtures'
import type { Generation, UpscaleRow } from '@/lib/types'
import { UpscalePickPage } from './UpscalePickPage'

afterEach(() => vi.unstubAllGlobals())

const clip = media('v1', { kind: 'video', origin: 'upload', title: 'Harbour clip', width: 1280, height: 720, duration_s: 12, media_url: '/media/v1.mp4' })

function setup(path: string) {
  const calls = mockApi((method, p) => {
    if (p === '/media') return { items: [clip] }
    if (p === '/system/upscale-options') return upscaleOptions
    if (method === 'POST' && p === '/generations/g-v1/upscale') return { id: 'j9', type: 'upscale', status: 'queued', progress: 0, message: '', attempts: 0, created_at: clip.created_at }
  })
  renderAt(path, [{ path: '/video/upscale', element: <UpscalePickPage kind="video" /> }])
  return calls
}

describe('standalone video upscale', () => {
  it('opens the upscale dialog for a library pick with the engine from the menu preselected', async () => {
    const calls = setup('/video/upscale?engine=quick')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Harbour clip' }))
    const dialog = await screen.findByRole('dialog', { name: /Upscale “Harbour clip”/ })
    expect(await within(dialog).findByRole('radio', { name: 'Quick preview' })).toBeChecked()
    await user.click(within(dialog).getByRole('button', { name: /^Upscale to/ }))
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/generations/g-v1/upscale', body: { engine: 'quick' } })
  })

  it('falls back to the default when the preselected engine is not installed', async () => {
    setup('/video/upscale?engine=best')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Harbour clip' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('radio', { name: 'Fast' })).toBeChecked()
  })
})

const gen = (id: string, extra: Partial<Generation> = {}): Generation => ({
  id,
  target_type: 'media',
  target_id: 'm1',
  kind: 'image',
  version: 1,
  status: 'ready',
  prompt: '',
  params: {},
  seed: 1,
  media_url: `/api/media/${id}.png`,
  thumb_url: `/api/media/thumb/${id}?w=512`,
  media_type: 'image/png',
  created_at: T,
  ...extra,
})

const row = (id: string, extra: Partial<UpscaleRow> = {}): UpscaleRow => ({
  result: gen(`up-${id}`, { version: 2, parent_id: `src-${id}`, params: { size: [2048, 2048] } }),
  source: gen(`src-${id}`, { kind: 'upload', params: { size: [1024, 1024] } }),
  title: `Pic ${id}`,
  kind: 'image',
  media_id: `m-${id}`,
  engine: 'quick',
  target: '2x',
  label: '2×',
  width: 2048,
  height: 2048,
  status: 'ready',
  ...extra,
})

const renderImagePage = (handler: Parameters<typeof mockApi>[0]) => {
  const calls = mockApi(handler)
  renderAt('/image/upscale', [{ path: '/image/upscale', element: <UpscalePickPage kind="image" /> }])
  return calls
}

describe('upscale results (server)', () => {
  afterEach(() => localStorage.clear())

  it('shows finished, running and failed upscales from /upscales with original and upscaled side by side', async () => {
    const running = row('b', {
      status: 'generating',
      result: gen('up-b', { status: 'generating', media_url: null, thumb_url: null }),
      job: { id: 'jb', type: 'generate', status: 'running', progress: 0.42, message: '', attempts: 1, created_at: T },
    })
    const failed = row('c', { status: 'failed', result: gen('up-c', { status: 'failed', media_url: null }), error: 'ComfyUI ran out of memory' })
    const calls = renderImagePage((_m, p) => {
      if (p === '/upscales') return { items: [running, failed, row('a')] }
      if (p === '/media') return { items: [] }
    })
    const done = await screen.findByRole('article', { name: 'Upscale: Pic a' })
    expect(within(done).getByRole('link', { name: 'Download original image' })).toHaveAttribute('href', '/api/generations/src-a/download')
    expect(within(done).getByRole('link', { name: 'Download upscaled image' })).toHaveAttribute('href', '/api/generations/up-a/download')
    expect(within(done).getByText('1024×1024')).toBeInTheDocument()
    expect(within(done).getByText('2048×2048')).toBeInTheDocument()
    expect(within(done).getByRole('link', { name: /Open in Library/ })).toHaveAttribute('href', '/image/library?open=m-a')
    expect(within(done).getByRole('button', { name: /Upscale again/ })).toBeInTheDocument()

    const run = screen.getByRole('article', { name: 'Upscale: Pic b' })
    expect(within(run).getByText('Upscaling · 42%')).toBeInTheDocument()
    expect(within(run).queryByRole('link', { name: /Download upscaled/ })).not.toBeInTheDocument()
    expect(within(screen.getByRole('article', { name: 'Upscale: Pic c' })).getByRole('alert')).toHaveTextContent('ComfyUI ran out of memory')
    expect(calls.find((c) => c.path === '/upscales')?.query).toMatchObject({ kind: 'image' })

    const user = userEvent.setup()
    await user.click(within(done).getByRole('button', { name: /Compare slider/ }))
    expect(within(done).getByRole('slider')).toBeInTheDocument()
  })

  it('keeps the latest six until "Show all", then pages with "Load more"', async () => {
    const first = Array.from({ length: 8 }, (_, i) => row(`p${i}`))
    const calls = renderImagePage((_m, p, q) => {
      if (p === '/upscales') return q.cursor ? { items: [row('late')] } : { items: first, next_cursor: 'c2' }
      if (p === '/media') return { items: [] }
    })
    await screen.findByRole('article', { name: 'Upscale: Pic p0' })
    expect(screen.getAllByRole('article')).toHaveLength(6)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Show all' }))
    expect(screen.getAllByRole('article')).toHaveLength(8)
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('article', { name: 'Upscale: Pic late' })).toBeInTheDocument()
    expect(calls.some((c) => c.path === '/upscales' && c.query.cursor === 'c2')).toBe(true)
  })

  it('deletes only the upscaled version after confirming', async () => {
    const calls = renderImagePage((method, p) => {
      if (method === 'DELETE') return new Response(null, { status: 204 })
      if (p === '/upscales') return { items: [row('a')] }
      if (p === '/media') return { items: [] }
    })
    const card = await screen.findByRole('article', { name: 'Upscale: Pic a' })
    const user = userEvent.setup()
    await user.click(within(card).getByRole('button', { name: 'Delete upscaled version' }))
    const confirm = screen.getByRole('alertdialog')
    expect(confirm).toHaveTextContent('The original stays')
    await user.click(within(confirm).getByRole('button', { name: 'Delete upscaled version' }))
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/upscales/up-a' })))
  })

  it('shows a just-queued upscale at once and forgets the local copy when the server lists it', async () => {
    const { rememberUpscale, loadUpscales } = await import('@/lib/upscaleHistory')
    rememberUpscale({ jobId: 'j1', sourceId: 'src-a', resultId: 'up-a', kind: 'image', label: 'Pic a', at: 1 })
    rememberUpscale({ jobId: 'j2', sourceId: 'src-z', resultId: 'up-z', kind: 'image', label: 'Fresh one', at: 2 })
    renderImagePage((_m, p) => {
      if (p === '/upscales') return { items: [row('a')] }
      if (p === '/media') return { items: [] }
    })
    expect(await screen.findByRole('article', { name: 'Upscale: Fresh one' })).toHaveTextContent('Queued')
    await screen.findByRole('link', { name: 'Download upscaled image' })
    await waitFor(() => expect(loadUpscales('image').map((e) => e.resultId)).toEqual(['up-z']))
  })
})

describe('pick grid tile menu', () => {
  it('opens its own menu without selecting the tile, and Upscale… opens the page dialog', async () => {
    const pic = { ...clip, title: 'pic122', thumb_url: '/api/media/thumb/g-v1?w=512' }
    mockApi((_m, p) => {
      if (p === '/media') return { items: [pic] }
      if (p === '/upscales') return { items: [] }
      if (p === '/system/upscale-options') return upscaleOptions
    })
    renderAt('/video/upscale', [{ path: '/video/upscale', element: <UpscalePickPage kind="video" /> }])
    const user = userEvent.setup()
    const tile = await screen.findByRole('button', { name: 'pic122' })
    expect(screen.getByRole('img', { name: 'pic122' })).toHaveAttribute('src', '/api/media/thumb/g-v1?w=512')
    await user.click(screen.getByRole('button', { name: 'More for pic122' }))
    expect(await screen.findByRole('menuitem', { name: 'Versions' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Image to Image' })).not.toBeInTheDocument()
    expect(tile).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Upscale…' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })
})
