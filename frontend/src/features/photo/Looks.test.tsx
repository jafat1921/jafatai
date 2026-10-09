import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { job, media, mockApi, renderAt } from '@/test/media-fixtures'
import { history, jpeg, look, schema, stubBrowser } from '@/test/photo-fixtures'
import { useMyJobs } from '@/stores/toasts'
import { PhotoStudioPage } from './PhotoStudioPage'

beforeEach(stubBrowser)
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const clip = media('v1', { kind: 'video', origin: 'upload', title: 'Harbour clip', width: 1920, height: 1080, duration_s: 60, media_url: '/media/v1.mp4' })
const LOOKS = [look('l1'), look('l2', { name: 'Film stock', has_cube: true, params: {}, source: 'imported', editable: true }), look('l3', { name: 'Mine', source: 'user', editable: true })]

function setup(extra: (method: string, path: string, body: unknown) => unknown = () => undefined) {
  const calls = mockApi((method, p, _q, body) => {
    const hit = extra(method, p, body)
    if (hit !== undefined) return hit
    if (p === '/photo/schema') return schema
    if (p.endsWith('/history')) return history()
    if (p.endsWith('/preview')) return jpeg()
    if (p.endsWith('/histogram')) return { r: [], g: [], b: [], luma: [], clipped: { shadows: 0, highlights: 0 } }
    if (p === '/looks' && method === 'GET') return LOOKS
    if (p === '/media' ) return { items: [clip] }
    if (method === 'POST' && p.endsWith('/render')) return job('j1', { type: 'photo_render' })
    return undefined
  })
  renderAt('/image/studio/g2?tab=looks', [{ path: '/image/studio/:generationId', element: <PhotoStudioPage /> }])
  return calls
}

const save = () => fireEvent.keyDown(document.body, { key: 's', ctrlKey: true })
const lastRender = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.path === '/photo/g1/render').at(-1)?.body

describe('Looks tab', { timeout: 15_000 }, () => {
  it('lists looks with live previews of this photo and applies one over the current settings, with intensity', async () => {
    const calls = setup()
    const user = userEvent.setup()
    const grid = await screen.findByRole('list', { name: 'Looks' })
    // no WebGL here: the server draws the tile on this picture
    expect(within(grid).getByRole('button', { name: 'Apply look Look l1' }).querySelector('img')).toHaveAttribute('src', '/api/looks/l1/thumb?generation_id=g1')

    await user.click(within(grid).getByRole('button', { name: 'Apply look Look l1' }))
    expect(within(grid).getByRole('button', { name: 'Apply look Look l1' })).toHaveAttribute('aria-pressed', 'true')
    save()
    await waitFor(() => expect(lastRender(calls)).toEqual({ params: { version: 2, exposure: 0.3, contrast: 40, saturation: -20 }, format: 'jpeg' }))

    fireEvent.change(screen.getByRole('slider', { name: 'Amount' }), { target: { value: '50' } })
    save()
    await waitFor(() => expect(lastRender(calls)).toEqual({ params: { version: 2, exposure: 0.3, contrast: 20, saturation: -10 }, format: 'jpeg' }))

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    save()
    // back to where it was before the look: nothing new to save
    expect(screen.getByRole('button', { name: 'Save as new version' })).toBeDisabled()
  })

  it('a LUT look sets params.lut with the intensity as its amount', async () => {
    const calls = setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Apply look Film stock' }))
    fireEvent.change(screen.getByRole('slider', { name: 'Amount' }), { target: { value: '70' } })
    save()
    await waitFor(() => expect(lastRender(calls)).toMatchObject({ params: { lut: { look_id: 'l2', amount: 70 } } }))
  })

  it('saves the current settings as a look made from this photo', async () => {
    let saved: ReturnType<typeof look> | null = null
    const calls = setup((method, p, body) => {
      if (method === 'POST' && p === '/looks') return (saved = look('l9', { ...(body as object), source: 'user', editable: true }))
      if (method === 'GET' && p === '/looks' && saved) return [...LOOKS, saved]
      return undefined
    })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Save current as look' }))
    const dialog = await screen.findByRole('dialog', { name: 'Save as a look' })
    await user.type(within(dialog).getByLabelText('Name'), 'Warm dusk')
    await user.click(within(dialog).getByRole('button', { name: 'Save look' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/looks')?.body).toEqual({ name: 'Warm dusk', params: { version: 2, exposure: 0.3, contrast: 10 }, generation_id: 'g1' }))
    expect(await screen.findByRole('button', { name: 'Apply look Warm dusk' })).toBeInTheDocument()
  })

  it('imports presets and reports what did not carry over', async () => {
    const calls = setup((method, p) =>
      method === 'POST' && p === '/looks/import'
        ? {
            looks: [look('l7', { name: 'Moody', source: 'imported' })],
            reports: [{ file: 'Moody.xmp', ok: true, kind: 'xmp', look_id: 'l7', name: 'Moody', mapped: ['Exposure2012', 'Contrast2012'], unmapped: ['SplitToningShadowHue', 'Texture'], notes: [] }],
          }
        : undefined,
    )
    const user = userEvent.setup({ applyAccept: false })
    await screen.findByRole('list', { name: 'Looks' })
    const files = [new File(['<x:xmpmeta/>'], 'Moody.xmp', { type: 'application/xml' }), new File(['hi'], 'notes.txt', { type: 'text/plain' })]
    await user.upload(screen.getByTestId('look-import-input'), files)
    const report = await screen.findByRole('region', { name: 'Import report' })
    expect(report).toHaveTextContent('Imported “Moody”')
    expect(report).toHaveTextContent('2 settings carried over.')
    expect(report).toHaveTextContent('Not carried (2): SplitToningShadowHue, Texture')
    expect(report).toHaveTextContent('notes.txt: not imported')
    const sent = calls.find((c) => c.path === '/looks/import')?.body as FormData
    expect(sent).toBeInstanceOf(FormData)
    expect((sent.getAll('files') as File[]).map((f) => f.name)).toEqual(['Moody.xmp'])
  })

  it('exports a look as .cube, and renames and deletes your own', async () => {
    const calls = setup((method, p, body) => {
      if (method === 'PATCH' && p === '/looks/l3') return look('l3', { ...(body as object), source: 'user', editable: true })
      if (method === 'DELETE' && p === '/looks/l3') return new Response(null, { status: 204 })
      return undefined
    })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'More for Look l1' }))
    expect(await screen.findByRole('menuitem', { name: 'Export .cube' })).toHaveAttribute('href', '/api/looks/l1/cube?size=33')
    // built-ins can't be renamed or deleted
    expect(screen.queryByRole('menuitem', { name: /Rename/ })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: 'More for Mine' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Rename…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rename look' })
    await user.clear(within(dialog).getByLabelText('Name'))
    await user.type(within(dialog).getByLabelText('Name'), 'Golden hour')
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }))
    expect(await screen.findByRole('button', { name: 'Apply look Golden hour' })).toBeInTheDocument()
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Golden hour' })

    await user.click(screen.getByRole('button', { name: 'More for Golden hour' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    await user.click(await screen.findByRole('button', { name: 'Delete look' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Apply look Golden hour' })).not.toBeInTheDocument())
  })

  it('grades a video with a look: picks the clip, sends the intensity, tracks the job', async () => {
    const calls = setup((method, p) => (method === 'POST' && p === '/looks/l1/apply-video' ? job('j5', { type: 'look_video', lane: 'general' }) : undefined))
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Apply look to video…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Apply a look to a video' })
    expect(within(dialog).getByRole('button', { name: 'Grade video' })).toBeDisabled()
    await user.click(await within(dialog).findByRole('button', { name: 'Harbour clip' }))
    expect(within(dialog).getByText(/Takes ~.* on the CPU/)).toBeInTheDocument()
    fireEvent.change(within(dialog).getByRole('slider', { name: 'Intensity' }), { target: { value: '60' } })
    await user.click(within(dialog).getByRole('button', { name: 'Grade video' }))
    await waitFor(() => expect(calls.find((c) => c.path === '/looks/l1/apply-video')?.body).toEqual({ generation_id: 'g-v1', intensity: 0.6 }))
    expect(useMyJobs.getState().jobs.j5).toMatchObject({ to: '/video/library' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Apply a look to a video' })).not.toBeInTheDocument())
  })
})
