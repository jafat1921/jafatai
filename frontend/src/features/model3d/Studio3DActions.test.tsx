import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { otherEngine, remakePayload, sourcePictureOf } from '@/lib/model3d'
import { job, media, mockApi, renderAt } from '@/test/media-fixtures'
import { seedCatalog } from '@/test/model-fixtures'
import { Studio3DPage } from './Studio3DPage'

const viewer = {
  load: vi.fn(async () => {}),
  setLighting: vi.fn(),
  setWireframe: vi.fn(),
  wireframe: vi.fn(() => false),
  setFacing: vi.fn(),
  rotate: vi.fn(),
  zoom: vi.fn(),
  reset: vi.fn(),
  model: vi.fn(() => ({})),
  turntable: vi.fn(),
  snapshot: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  dispose: vi.fn(),
}
vi.mock('./viewer3d', () => ({ createViewer: () => viewer }))
const exportFromUrl = vi.fn(async () => new Blob(['x']))
vi.mock('./exporters', () => ({ exportModel: vi.fn(), exportFromUrl: (...a: unknown[]) => exportFromUrl(...(a as [])) }))

beforeEach(() => {
  vi.clearAllMocks()
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => vi.unstubAllGlobals())

const rec = { engine: 'pixal3d', quality: 'draft', remove_background: true, source_id: 'g-s1', source_media_id: 's1' }
const glb = (id: string, extra = {}) =>
  media(id, {
    kind: 'model',
    title: 'Teapot · 3D',
    media_url: `/api/media/workspaces/w1/media/${id}.glb`,
    thumb_url: `/api/media/thumb/g-${id}?w=512`,
    status: 'ready',
    params: { model3d: rec, turntables: ['v1', 'v2'] },
    ...extra,
  })

function api() {
  return mockApi((method, path, _q, body) => {
    if (path === '/media') return { items: [glb('m1'), glb('m2', { title: 'Lamp · 3D', params: { model3d: { ...rec, engine: 'trellis2' } } })] }
    if (path === '/estimate') return { low_s: 120, high_s: 200, basis: 'rough', samples: 0 }
    if (method === 'DELETE') return new Response(null, { status: 204 })
    if (method === 'PATCH' && path === '/media/m2') return glb('m2', { title: (body as { title: string }).title })
    if (method === 'POST' && path === '/3d/make') return { item: glb('m9', { status: 'queued', media_url: null }), job: job('j9', { type: 'generate' }), model_resolved: 'trellis2' }
  })
}

const route = [{ path: '/3d', element: <Studio3DPage /> }]

describe('3D model actions', () => {
  it('makes again from the same record, or with the other engine', () => {
    const m = glb('m1')
    expect(remakePayload(m)).toEqual({ source_id: 's1', engine: 'pixal3d', quality: 'draft', remove_background: true, title: 'Teapot · 3D' })
    expect(remakePayload(m, 'trellis2')?.engine).toBe('trellis2')
    expect(otherEngine(m)).toBe('trellis2')
    expect(sourcePictureOf(m)).toBe('s1')
    const views = glb('m3', { params: { model3d: { ...rec, views: { front: 'g1', back: 'g2' }, view_media: { front: 'a', back: 'b' } } } })
    expect(otherEngine(views)).toBeNull()
    expect(remakePayload(views, 'trellis2')).toMatchObject({ views: { front: 'a', back: 'b' }, engine: 'pixal3d' })
    expect(remakePayload(glb('m4', { params: { model3d: { ...rec, start: 'character', character_id: 'c1' } } }))).toMatchObject({ character_id: 'c1' })
  })

  it('deletes a model after a confirm, keeping its turntables unless asked', async () => {
    const calls = api()
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()
    const tiles = await screen.findAllByRole('button', { name: 'More for Teapot · 3D' })
    await user.click(tiles[tiles.length - 1])
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete “Teapot · 3D”?' })
    expect(within(dialog).getByRole('checkbox', { name: /Also delete its 2 turntable videos/ })).not.toBeChecked()
    // nothing goes before the confirm
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/media/m1']))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'More for Teapot · 3D' })).not.toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'Your models' })).toHaveFocus()
  })

  it('takes the turntables too when ticked', async () => {
    const calls = api()
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()
    const tiles = await screen.findAllByRole('button', { name: 'More for Teapot · 3D' })
    await user.click(tiles[tiles.length - 1])
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    await user.click(await screen.findByRole('checkbox', { name: /turntable videos/ }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/media/m1', '/media/v1', '/media/v2']))
  })

  it('cancelling the confirm deletes nothing', async () => {
    const calls = api()
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()
    const tiles = await screen.findAllByRole('button', { name: 'More for Teapot · 3D' })
    await user.click(tiles[0])
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('renames a model from its tile', async () => {
    const calls = api()
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'More for Lamp · 3D' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const name = await screen.findByRole('textbox', { name: 'Name' })
    await user.clear(name)
    await user.type(name, 'Brass lamp')
    await user.click(screen.getByRole('button', { name: 'Save name' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/media/m2', body: { title: 'Brass lamp' } }))
    expect(await screen.findByRole('button', { name: 'Brass lamp' })).toBeInTheDocument()
  })

  it('tries the other engine, links the source and the Library, and downloads from a tile', async () => {
    const calls = api()
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'More for Lamp · 3D' }))
    expect(screen.getByRole('menuitem', { name: 'Show the source picture' })).toHaveAttribute('href', '/image/library?open=s1')
    expect(screen.getByRole('menuitem', { name: 'Open in Library' })).toHaveAttribute('href', '/3d/library?open=m2')
    await user.click(screen.getByRole('menuitem', { name: 'Try Pixal3D' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/3d/make')?.body).toMatchObject({ source_id: 's1', engine: 'pixal3d', quality: 'draft' }))

    await user.click(screen.getByRole('button', { name: 'More for Lamp · 3D' }))
    await user.click(screen.getByRole('menuitem', { name: 'STL' }))
    await waitFor(() => expect(exportFromUrl).toHaveBeenCalledWith('/api/media/workspaces/w1/media/m2.glb', 'stl'))
  })

  it('a tile’s thumbnail action opens that model and snaps it in the viewer', async () => {
    const calls = mockApi((method, path) => {
      if (path === '/media') return { items: [glb('m1'), glb('m2', { title: 'Lamp · 3D' })] }
      if (method === 'POST' && path === '/3d/m2/thumbnail') return glb('m2', { title: 'Lamp · 3D' })
    })
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'More for Lamp · 3D' }))
    await user.click(screen.getByRole('menuitem', { name: 'Use the front view as thumbnail' }))
    await waitFor(() => expect(viewer.load).toHaveBeenLastCalledWith('/api/media/workspaces/w1/media/m2.glb'))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/3d/m2/thumbnail')).toBe(true))
  })
})
