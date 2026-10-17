import type { QueryClient } from '@tanstack/react-query'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdStudioPage } from '@/features/image/ads/AdStudioPage'
import type { Usage } from '@/lib/types'
import { media, mockApi, renderAt } from '@/test/media-fixtures'
import { seedCatalog } from '@/test/model-fixtures'
import { useUi } from '@/stores/ui'
import { Studio3DPage } from './Studio3DPage'
import { SHOT_ANGLES, type ShotSpec } from './shots'

// jsdom has no WebGL: the viewer hands back one small blob per angle it was asked for
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
  snapshot: vi.fn(),
  shots: vi.fn(async (angles: ShotSpec[]) => angles.map((a) => ({ angle: a.id, blob: new Blob([a.id], { type: 'image/png' }) }))),
  dispose: vi.fn(),
}
vi.mock('./viewer3d', () => ({ createViewer: () => viewer }))
vi.mock('./exporters', () => ({ exportModel: vi.fn() }))

const realCreate = URL.createObjectURL
const realRevoke = URL.revokeObjectURL
beforeEach(() => {
  vi.clearAllMocks()
  let n = 0
  URL.createObjectURL = vi.fn(() => `blob:shot-${++n}`)
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  URL.createObjectURL = realCreate
  URL.revokeObjectURL = realRevoke
  vi.unstubAllGlobals()
})

const glb = media('m1', { kind: 'model', title: 'Teapot · 3D', media_url: '/api/media/workspaces/w1/media/m1.glb', thumb_url: '/api/media/thumb/g-m1?w=512', status: 'ready' })

function api() {
  return mockApi((method, path, query, body) => {
    if (path === '/media' && query.kind === 'model') return { items: [glb] }
    if (path === '/estimate') return { low_s: 120, high_s: 200, basis: 'rough', samples: 0 }
    if (method === 'POST' && path === '/3d/m1/shots') {
      const files = (body as FormData).getAll('file') as File[]
      const items = files.map((f, i) => media(`s${i + 1}`, { title: `Teapot · 3D · ${f.name}`, home: 'ad' }))
      return { items, ids: items.map((m) => m.id) }
    }
    const id = path.match(/^\/media\/(\w+)$/)?.[1]
    if (id) return { ...media(id, { title: `Shot ${id}` }), versions: [] }
  })
}

const routes = [
  { path: '/3d', element: <Studio3DPage /> },
  { path: '/image/ads', element: <AdStudioPage /> },
]
const where = () => screen.getByTestId('location').textContent
const usage = (features: Record<string, boolean>) => (qc: QueryClient) => {
  seedCatalog(qc)
  qc.setQueryData(['account-usage'], { package: { id: 'p', name: 'Basic', kind: 'paid' }, features } as unknown as Usage)
}

describe('3D Studio product shots for Ad Studio', () => {
  it('renders the angles, keeps the ticked ones, saves them and opens the brief with three', async () => {
    const calls = api()
    renderAt('/3d', routes, seedCatalog)
    const user = userEvent.setup()
    await waitFor(() => expect(viewer.load).toHaveBeenCalled())

    await user.click(await screen.findByRole('button', { name: 'Product shots for adverts' }))
    await user.click(screen.getByRole('radio', { name: 'Transparent' }))
    expect(screen.getByRole('switch', { name: 'Soft shadow' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Render angles' }))
    expect(viewer.shots).toHaveBeenCalledWith(SHOT_ANGLES, { background: 'transparent', shadow: false })

    const strip = await screen.findByRole('group', { name: /Angles to keep/ })
    const boxes = within(strip).getAllByRole('checkbox')
    expect(boxes).toHaveLength(6)
    // the back starts unticked
    expect(within(strip).getByRole('checkbox', { name: 'Back' })).not.toBeChecked()
    expect(within(strip).getByRole('checkbox', { name: 'Front' })).toBeChecked()
    await user.click(within(strip).getByRole('checkbox', { name: 'Side' }))
    await user.click(within(strip).getByRole('checkbox', { name: 'Back' }))
    expect(screen.getByRole('group', { name: 'Angles to keep (5 of 6)' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save 5 for Ad Studio' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/3d/m1/shots')).toBe(true))
    const sent = (calls.find((c) => c.path === '/3d/m1/shots')!.body as FormData).getAll('file') as File[]
    expect(sent.map((f) => f.name)).toEqual(['front.png', 'left.png', 'right.png', 'top.png', 'back.png'])

    // five saved, the brief takes three: the first three are picked, the rest wait until one is let go
    const pick = await screen.findByRole('group', { name: /For the brief, up to 3/ })
    expect(within(pick).getByRole('checkbox', { name: 'Use front in the brief' })).toBeChecked()
    expect(within(pick).getByRole('checkbox', { name: 'Use back in the brief' })).toBeDisabled()
    await user.click(within(pick).getByRole('checkbox', { name: 'Use three-quarter left in the brief' }))
    await user.click(within(pick).getByRole('checkbox', { name: 'Use back in the brief' }))
    expect(useUi.getState().announcement.text).toMatch(/5 product shots saved/)

    await user.click(screen.getByRole('button', { name: 'Use in Ad Studio' }))
    expect(where()).toBe('/image/ads?products=s1,s3,s5')
    // the brief opens with them in the product slots
    expect(await screen.findByText('Product 3')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add product photo/ })).not.toBeInTheDocument()
  })

  it('goes straight to the brief when three or fewer are saved, and the menu opens the panel', async () => {
    api()
    renderAt('/3d', routes, seedCatalog)
    const user = userEvent.setup()
    await waitFor(() => expect(viewer.load).toHaveBeenCalled())
    const menus = await screen.findAllByRole('button', { name: 'More for Teapot · 3D' })
    await user.click(menus[0])
    await user.click(await screen.findByRole('menuitem', { name: 'Product shots for adverts' }))
    await user.click(await screen.findByRole('button', { name: 'Render angles' }))
    expect(viewer.shots).toHaveBeenCalledWith(SHOT_ANGLES, { background: 'white', shadow: true })
    const strip = await screen.findByRole('group', { name: /Angles to keep/ })
    for (const name of ['Three-quarter right', 'Side', 'From above']) await user.click(within(strip).getByRole('checkbox', { name }))
    await user.click(screen.getByRole('button', { name: 'Save 2 for Ad Studio' }))
    await user.click(await screen.findByRole('button', { name: 'Use in Ad Studio' }))
    expect(screen.queryByRole('group', { name: /For the brief/ })).not.toBeInTheDocument()
    expect(where()).toBe('/image/ads?products=s1,s2')
  })

  it('is hidden unless the package has both the 3D Studio and Ad Studio', async () => {
    api()
    renderAt('/3d', routes, usage({ ads: false }))
    const user = userEvent.setup()
    await waitFor(() => expect(viewer.load).toHaveBeenCalled())
    expect(await screen.findByRole('button', { name: 'Make turntable' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Product shots for adverts' })).not.toBeInTheDocument()
    await user.click((await screen.findAllByRole('button', { name: 'More for Teapot · 3D' }))[0])
    expect(await screen.findByRole('menuitem', { name: 'Make turntable' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Product shots for adverts' })).not.toBeInTheDocument()
  })
})

describe('Ad Studio brief from the 3D viewer', () => {
  it('preselects ?products= up to three, and its picker offers Ad Studio parts', async () => {
    const calls = mockApi((_m, path) => {
      const id = path.match(/^\/media\/(\w+)$/)?.[1]
      if (id) return { ...media(id, { title: `Shot ${id}` }), versions: [] }
      if (path === '/media') return { items: [] }
      return []
    })
    renderAt('/image/ads?products=a1,a2,a2,a3,a4', routes)
    expect(await screen.findByText('Product 3')).toBeInTheDocument()
    expect(screen.queryByText('Product 4')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add product photo/ })).not.toBeInTheDocument()
    await waitFor(() => expect(calls.filter((c) => /^\/media\/a\d$/.test(c.path)).map((c) => c.path).sort()).toEqual(['/media/a1', '/media/a2', '/media/a3']))

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Remove shot a3/i }))
    await user.click(await screen.findByRole('button', { name: 'Add product photo' }))
    await user.click(await screen.findByRole('button', { name: 'Pick from Library' }))
    await waitFor(() => expect(calls.some((c) => c.path === '/media' && c.query.include_home === 'character,ad')).toBe(true))
  })
})
