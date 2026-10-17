import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { blocked3d, DEFAULT_FORM_3D, fileStem, make3dPayload } from '@/lib/model3d'
import { media, mockApi, renderAt } from '@/test/media-fixtures'
import { seedCatalog } from '@/test/model-fixtures'
import { Studio3DPage } from './Studio3DPage'

// jsdom has no WebGL: the three.js half is replaced by a recorder
const fakeModel = { name: 'scene' }
let wireOn = false
const viewer = {
  load: vi.fn(async () => {}),
  setLighting: vi.fn(),
  setWireframe: vi.fn((on: boolean) => void (wireOn = on)),
  wireframe: vi.fn(() => wireOn),
  setFacing: vi.fn(),
  rotate: vi.fn(),
  zoom: vi.fn(),
  reset: vi.fn(),
  model: vi.fn(() => fakeModel),
  dispose: vi.fn(),
}
const createViewer = vi.fn(() => viewer)
vi.mock('./viewer3d', () => ({ createViewer: (...a: unknown[]) => createViewer(...(a as [])) }))
const exportModel = vi.fn(async () => new Blob(['x']))
vi.mock('./exporters', () => ({ exportModel: (...a: unknown[]) => exportModel(...(a as [])) }))

beforeEach(() => {
  vi.clearAllMocks()
  wireOn = false
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => vi.unstubAllGlobals())

const glb = (id: string, extra = {}) =>
  media(id, { kind: 'model', title: 'Teapot · 3D', media_url: `/api/media/workspaces/w1/media/${id}.glb`, thumb_url: `/api/media/thumb/g-${id}?w=512`, status: 'ready', ...extra })

function api(models: ReturnType<typeof media>[] = []) {
  return mockApi((method, path, query) => {
    if (path === '/media' && query.kind === 'model') return { items: models }
    const id = path.match(/^\/media\/(\w+)$/)?.[1]
    if (id) return { ...media(id, { title: 'Teapot' }), versions: [] }
    if (path === '/estimate') return { low_s: 120, high_s: 200, basis: 'rough', samples: 0 }
    if (method === 'POST' && path === '/3d/make') return { item: glb('m9', { status: 'queued', media_url: null, thumb_url: null }), job: { id: 'j9', type: 'generate', status: 'queued', progress: 0, message: '', attempts: 0, created_at: '2026-10-07T10:00:00Z' }, model_resolved: 'trellis2', background_note: null }
  })
}

const route = [{ path: '/3d', element: <Studio3DPage /> }]

describe('3D Studio rules', () => {
  it('needs a picture, and sends exactly what the dock shows', () => {
    expect(blocked3d(DEFAULT_FORM_3D, undefined)).toBe('Add a picture first.')
    expect(make3dPayload(DEFAULT_FORM_3D)).toBeNull()
    expect(make3dPayload({ ...DEFAULT_FORM_3D, sourceId: 's1' })).toEqual({ source_id: 's1', engine: 'pixal3d', quality: 'final', remove_background: true })
    expect(fileStem('Teapot · 3D')).toBe('teapot-3d')
    expect(fileStem('···')).toBe('model')
  })
})

describe('3D Studio page', () => {
  it('makes a draft TRELLIS.2 model from the picture in the link, background kept', async () => {
    const calls = api()
    renderAt('/3d?image=s1', route, seedCatalog)
    const user = userEvent.setup()

    expect(await screen.findByRole('img', { name: 'Teapot' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: '3D Studio' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Pixal3D, true to the picture/ })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('radio', { name: /TRELLIS.2, general/ }))
    await user.click(screen.getByRole('radio', { name: 'Draft' }))
    expect(screen.getByText(/About half the time/)).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: /Remove background/ }))

    await waitFor(() => expect(calls.some((c) => c.path === '/estimate' && c.query.model === 'trellis2' && c.query.speed === 'draft')).toBe(true))
    expect(calls.find((c) => c.path === '/estimate')?.query.kind).toBe('model3d')
    await user.click(screen.getByRole('button', { name: /^Make 3D · Draft model/ }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ source_id: 's1', engine: 'trellis2', quality: 'draft', remove_background: false }))
    expect(calls.find((c) => c.path === '/media' && c.query.kind === 'model')).toBeTruthy()
  })

  it("won't start without a picture and says why", async () => {
    api()
    renderAt('/3d', route, seedCatalog)
    const button = await screen.findByRole('button', { name: /^Make 3D/ })
    expect(button).toBeDisabled()
    expect(screen.getByText('Add a picture first.')).toBeInTheDocument()
    expect(await screen.findByText('No 3D models yet')).toBeInTheDocument()
    expect(createViewer).not.toHaveBeenCalled()
  })

  it('opens the newest model in the viewer: keys turn it, lighting and wireframe apply, downloads export', async () => {
    api([glb('m1'), glb('m2', { title: 'Lamp · 3D' }), glb('m3', { status: 'generating', media_url: null, thumb_url: null, title: 'Chair · 3D' })])
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()

    const stage = await screen.findByRole('application', { name: /Teapot · 3D\. Drag to turn it/ })
    await waitFor(() => expect(viewer.load).toHaveBeenCalledWith('/api/media/workspaces/w1/media/m1.glb'))
    expect(createViewer).toHaveBeenCalledWith(stage, { reducedMotion: false })
    stage.focus()
    await user.keyboard('{ArrowRight}{ArrowUp}+0')
    expect(viewer.rotate).toHaveBeenNthCalledWith(1, Math.PI / 12, 0)
    expect(viewer.rotate).toHaveBeenNthCalledWith(2, 0, -Math.PI / 12)
    expect(viewer.zoom).toHaveBeenCalledWith(0.85)
    expect(viewer.reset).toHaveBeenCalled()

    await user.click(screen.getByRole('radio', { name: 'Sunset' }))
    await waitFor(() => expect(viewer.setLighting).toHaveBeenLastCalledWith('sunset'))
    await user.click(screen.getByRole('switch', { name: 'Wireframe' }))
    await waitFor(() => expect(viewer.setWireframe).toHaveBeenLastCalledWith(true))
    await user.click(screen.getByRole('radio', { name: 'Checker' }))
    expect(stage).toHaveClass('checker')

    expect(screen.getByRole('link', { name: 'GLB' })).toHaveAttribute('download', 'teapot-3d.glb')
    await user.click(screen.getByRole('button', { name: /Download OBJ/ }))
    await waitFor(() => expect(exportModel).toHaveBeenCalledWith(fakeModel, 'obj'))
    await user.click(screen.getByRole('button', { name: /Download USDZ/ }))
    await waitFor(() => expect(exportModel).toHaveBeenCalledWith(fakeModel, 'usdz'))
    await user.click(screen.getByRole('button', { name: /Download STL/ }))
    await waitFor(() => expect(exportModel).toHaveBeenCalledWith(fakeModel, 'stl'))
    expect(URL.createObjectURL).toHaveBeenCalledTimes(3)

    // a model still being made can't be opened; another finished one can
    expect(screen.getByRole('button', { name: 'Chair · 3D, making…' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Lamp · 3D' }))
    await waitFor(() => expect(viewer.load).toHaveBeenLastCalledWith('/api/media/workspaces/w1/media/m2.glb'))
    expect(viewer.dispose).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Lamp · 3D' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('the wireframe switch shows what is drawn, from load and across models', async () => {
    api([glb('m1'), glb('m2', { title: 'Lamp · 3D' })])
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()
    const wire = await screen.findByRole('switch', { name: 'Wireframe' })
    // Off by default, and the viewer is told so once the model is drawn
    await waitFor(() => expect(viewer.setWireframe).toHaveBeenCalledWith(false))
    expect(wire).toHaveAttribute('aria-checked', 'false')
    expect(viewer.wireframe()).toBe(false)

    await user.click(wire)
    expect(wire).toHaveAttribute('aria-checked', 'true')
    expect(viewer.wireframe()).toBe(true)

    // the next model opens in a fresh viewer: it's drawn as wire too, and the switch still says so
    viewer.setWireframe.mockClear()
    wireOn = false
    await user.click(screen.getByRole('button', { name: 'Lamp · 3D' }))
    await waitFor(() => expect(viewer.load).toHaveBeenLastCalledWith('/api/media/workspaces/w1/media/m2.glb'))
    await waitFor(() => expect(viewer.setWireframe).toHaveBeenLastCalledWith(true))
    expect(screen.getByRole('switch', { name: 'Wireframe' })).toHaveAttribute('aria-checked', 'true')
  })

  it('turns a model round with Front / Back, per model', async () => {
    api([glb('m1'), glb('m2', { title: 'Lamp · 3D' })])
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()
    await waitFor(() => expect(viewer.setFacing).toHaveBeenCalledWith('front'))
    await user.click(screen.getByRole('radio', { name: 'Back' }))
    await waitFor(() => expect(viewer.setFacing).toHaveBeenLastCalledWith('back'))
    expect(screen.getByRole('radio', { name: 'Back' })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('button', { name: 'Lamp · 3D' }))
    await waitFor(() => expect(viewer.load).toHaveBeenLastCalledWith('/api/media/workspaces/w1/media/m2.glb'))
    await waitFor(() => expect(viewer.setFacing).toHaveBeenLastCalledWith('front'))
    expect(screen.getByRole('radio', { name: 'Front' })).toHaveAttribute('aria-checked', 'true')
  })

  it('four views use compact slots, and the options column can’t be squeezed off the side', async () => {
    api()
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: 'Four views' }))
    expect(screen.getByText('Front picture')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pick front picture from Library' })).toBeInTheDocument()
    expect(screen.queryByText(/Drop an image here/)).not.toBeInTheDocument()
    // jsdom has no layout; the classes are what keep it in place (checked by eye at 1920 to 375 px)
    const engine = screen.getByRole('group', { name: 'Engine' }).closest('fieldset')!.parentElement!
    expect(engine).toHaveClass('min-[1100px]:w-72')
    expect(engine.parentElement).toHaveClass('min-w-0', 'min-[1100px]:grid-cols-[minmax(0,1fr)_18rem]')
  })

  it('says so when the model can’t be drawn', async () => {
    viewer.load.mockRejectedValueOnce(new Error('no WebGL'))
    api([glb('m1')])
    renderAt('/3d', route, seedCatalog)
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't be shown here/)
    expect(screen.getByRole('button', { name: /Download OBJ/ })).toBeDisabled()
    expect(screen.getByRole('link', { name: 'GLB' })).toBeInTheDocument()
  })
})
