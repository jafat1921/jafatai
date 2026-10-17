import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { media, mockApi, renderAt } from '@/test/media-fixtures'
import { seedCatalog } from '@/test/model-fixtures'
import { useUi } from '@/stores/ui'
import { Studio3DPage } from './Studio3DPage'

// jsdom has no WebGL or MediaRecorder: the viewer is a recorder, and canRecord is switched per test
let progress: ((share: number) => void) | undefined
let release: (() => void) | undefined
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
  model: vi.fn(() => ({})),
  turntable: vi.fn(
    (_backdrop: string, opts?: { signal?: AbortSignal; onProgress?: (s: number) => void }) =>
      new Promise<Blob>((resolve, reject) => {
        progress = opts?.onProgress
        release = () => resolve(new Blob(['webm'], { type: 'video/webm' }))
        opts?.signal?.addEventListener('abort', () => reject(new DOMException('Recording cancelled', 'AbortError')))
      }),
  ),
  snapshot: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  dispose: vi.fn(),
}
vi.mock('./viewer3d', () => ({ createViewer: () => viewer }))
vi.mock('./exporters', () => ({ exportModel: vi.fn() }))
const recordable = vi.hoisted(() => ({ on: true }))
vi.mock('./turntable', async (orig) => ({ ...(await orig<typeof import('./turntable')>()), canRecord: () => recordable.on }))

beforeEach(() => {
  vi.clearAllMocks()
  wireOn = false
  recordable.on = true
})
afterEach(() => vi.unstubAllGlobals())

const glb = (id: string, extra = {}) =>
  media(id, { kind: 'model', title: 'Teapot · 3D', media_url: `/api/media/workspaces/w1/media/${id}.glb`, thumb_url: `/api/media/thumb/g-${id}?w=512`, status: 'ready', ...extra })

function api() {
  return mockApi((method, path, query) => {
    if (path === '/media' && query.kind === 'model') return { items: [glb('m1')] }
    if (path === '/estimate') return { low_s: 120, high_s: 200, basis: 'rough', samples: 0 }
    if (method === 'POST' && path === '/3d/m1/turntable')
      return { item: media('v1', { kind: 'video', title: 'Teapot · 3D · turntable', media_url: '/api/media/workspaces/w1/media/v1.mp4' }), model: glb('m1', { thumb_url: '/api/media/thumb/g-m1?w=512&v=abc' }), transcoded: true }
    if (method === 'POST' && path === '/3d/m1/thumbnail') return glb('m1', { thumb_url: '/api/media/thumb/g-m1?w=512&v=def' })
    const id = path.match(/^\/media\/(\w+)$/)?.[1]
    if (id) return { ...media(id, { title: 'Teapot' }), versions: [] }
  })
}

const route = [{ path: '/3d', element: <Studio3DPage /> }]
const said = () => useUi.getState().announcement.text

describe('3D Studio turntable and thumbnail', () => {
  it('records a turn with progress, uploads it and shows the saved video', async () => {
    const calls = api()
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()
    await waitFor(() => expect(viewer.load).toHaveBeenCalled())

    await user.click(screen.getByRole('radio', { name: 'Checker' }))
    await user.click(await screen.findByRole('button', { name: 'Make turntable' }))
    expect(viewer.turntable).toHaveBeenCalledWith('checker', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(said()).toMatch(/Recording the turntable/)
    progress?.(0.47)
    const bar = await screen.findByRole('progressbar', { name: /Recording the turntable… 45%/ })
    expect(bar).toHaveAttribute('aria-valuenow', '45')
    expect(screen.getByRole('button', { name: 'Make turntable' })).toBeDisabled()

    release?.()
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/3d/m1/turntable')).toBe(true))
    const sent = calls.find((c) => c.path === '/3d/m1/turntable')!.body as FormData
    expect((sent.get('file') as File).name).toBe('turntable.webm')
    expect(await screen.findByText(/Saved to the Library/)).toBeInTheDocument()
    expect(screen.getByLabelText('Teapot · 3D, turntable')).toHaveAttribute('src', '/api/media/workspaces/w1/media/v1.mp4')
    expect(screen.getByRole('link', { name: 'Open the video library' })).toHaveAttribute('href', '/video/library')
    expect(said()).toBe('Turntable saved to the Library.')
    // the new thumb reaches the grid
    await waitFor(() => expect(screen.getByRole('button', { name: 'Teapot · 3D' }).querySelector('img')).toHaveAttribute('src', '/api/media/thumb/g-m1?w=512&v=abc'))
  })

  it('can be cancelled, and nothing is uploaded', async () => {
    const calls = api()
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Make turntable' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument())
    expect(said()).toBe('Turntable cancelled.')
    expect(calls.some((c) => c.path.endsWith('/turntable'))).toBe(false)
    expect(screen.getByRole('button', { name: 'Make turntable' })).toBeEnabled()
  })

  it('says calmly when the browser can’t record', async () => {
    recordable.on = false
    api()
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Make turntable' }))
    expect(screen.getByText(/can’t record video/)).toHaveAttribute('role', 'status')
    expect(viewer.turntable).not.toHaveBeenCalled()
  })

  it('uses the current view as the thumbnail', async () => {
    const calls = api()
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Use this view as thumbnail' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/3d/m1/thumbnail')).toBe(true))
    expect(viewer.snapshot).toHaveBeenCalled()
    expect(((calls.find((c) => c.path === '/3d/m1/thumbnail')!.body as FormData).get('file') as File).name).toBe('thumbnail.png')
    await waitFor(() => expect(said()).toMatch(/Thumbnail set/))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Teapot · 3D' }).querySelector('img')).toHaveAttribute('src', '/api/media/thumb/g-m1?w=512&v=def'))
  })

  it('opens with the picture from a Make 3D link', async () => {
    api()
    renderAt('/3d?from=picture&source=s1', route, seedCatalog)
    expect(await screen.findByRole('img', { name: 'Teapot' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Picture' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText('Add a picture first.')).not.toBeInTheDocument()
  })
})
