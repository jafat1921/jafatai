import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { blocked3d, DEFAULT_FORM_3D, engineLock, make3dPayload, NO_VIEWS, sheetViews } from '@/lib/model3d'
import type { CharacterSheet } from '@/lib/types'
import { job, media, mockApi, renderAt } from '@/test/media-fixtures'
import { seedCatalog } from '@/test/model-fixtures'
import { Studio3DPage } from './Studio3DPage'

vi.mock('./viewer3d', () => ({ createViewer: vi.fn() }))
vi.mock('./exporters', () => ({ exportModel: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

const sheet = (ready: string[]) =>
  ({
    panels: ['hero', 'turn_front', 'turn_three_quarter', 'turn_side', 'turn_back'].map((key) => ({ key, status: ready.includes(key) ? 'ready' : 'missing', current: ready.includes(key) ? { id: `g-${key}` } : null })),
    board: { status: 'none' },
  }) as unknown as CharacterSheet

const model = (extra = {}) => ({
  item: media('m9', { kind: 'model', title: 'Lamp · 3D', status: 'queued', media_url: null }),
  job: job('j-model', { type: 'generate' }),
  model_resolved: 'pixal3d',
  background_note: null,
  ...extra,
})

function api(sheets: Record<string, CharacterSheet> = {}, answer: object = model()) {
  return mockApi((method, path) => {
    if (path === '/media') return { items: [] }
    if (path === '/estimate') return { low_s: 120, high_s: 200, basis: 'rough', samples: 0 }
    if (path === '/characters') return [{ id: 'c1', name: 'Maya', portrait: null }, { id: 'c2', name: 'Idris', portrait: null }]
    const sid = path.match(/^\/characters\/(\w+)\/sheet$/)?.[1]
    if (sid) return sheets[sid] ?? sheet([])
    if (method === 'POST' && path === '/3d/make') return answer
  })
}

const route = [{ path: '/3d', element: <Studio3DPage /> }]
const posted = (calls: ReturnType<typeof api>) => calls.find((c) => c.method === 'POST' && c.path === '/3d/make')?.body

describe('3D Studio starts, the rules', () => {
  it('builds one request per start', () => {
    const f = DEFAULT_FORM_3D
    expect(make3dPayload({ ...f, from: 'text', prompt: '  a lamp ' }, { prompt: 'a lamp', magic_prompt: 'auto' })).toEqual({
      prompt: 'a lamp',
      magic_prompt: 'auto',
      engine: 'pixal3d',
      quality: 'final',
      remove_background: true,
    })
    expect(make3dPayload({ ...f, from: 'text', prompt: ' ' })).toBeNull()
    expect(make3dPayload({ ...f, from: 'character', characterId: 'c1', engine: 'trellis2' }, undefined, true)).toEqual({
      character_id: 'c1',
      engine: 'pixal3d',
      quality: 'final',
      remove_background: true,
    })
    expect(make3dPayload({ ...f, from: 'character', characterId: 'c1', engine: 'trellis2' })?.engine).toBe('trellis2')
    const views = { ...NO_VIEWS, front: 'a', right: 'd' }
    expect(make3dPayload({ ...f, from: 'views', views, engine: 'trellis2', removeBackground: false })).toEqual({
      views: { front: 'a', right: 'd' },
      engine: 'pixal3d',
      quality: 'final',
      remove_background: false,
    })
    expect(make3dPayload({ ...f, from: 'views', views: { ...NO_VIEWS, front: 'a' } })).toBeNull()
    expect(make3dPayload({ ...f, from: 'views', views: { ...NO_VIEWS, left: 'b', back: 'c' } })).toBeNull()
  })

  it('says what is missing', () => {
    const f = DEFAULT_FORM_3D
    expect(blocked3d({ ...f, from: 'text' }, undefined)).toBe('Describe the object first.')
    expect(blocked3d({ ...f, from: 'character' }, undefined)).toBe('Pick a character first.')
    expect(blocked3d({ ...f, from: 'views' }, undefined)).toBe('Add the front view first.')
    expect(blocked3d({ ...f, from: 'views', views: { ...NO_VIEWS, front: 'a' } }, undefined)).toBe('Add at least one more view: left, back or right.')
    expect(blocked3d({ ...f, from: 'views', views: { ...NO_VIEWS, front: 'a', back: 'b' } }, undefined, 'not installed')).toMatch(/not installed/)
    expect(blocked3d({ ...f, from: 'views', views: { ...NO_VIEWS, front: 'a', back: 'b' } }, undefined)).toBeNull()
  })

  it('reads the turnaround the way the server does', () => {
    expect(sheetViews(sheet(['turn_front', 'turn_side', 'turn_back']))).toEqual(['front', 'left', 'back'])
    expect(sheetViews(sheet(['turn_front', 'turn_back', 'turn_three_quarter']))).toEqual(['front', 'back'])
    // a front alone, or no front, isn't a turnaround
    expect(sheetViews(sheet(['turn_front', 'hero']))).toEqual([])
    expect(sheetViews(sheet(['turn_side', 'turn_back']))).toEqual([])
    expect(sheetViews(undefined)).toEqual([])
    expect(engineLock({ ...DEFAULT_FORM_3D, from: 'views' }, [])).toMatch(/Pixal3D only/)
    expect(engineLock({ ...DEFAULT_FORM_3D, from: 'character' }, ['front', 'back'])).toMatch(/Pixal3D only/)
    expect(engineLock({ ...DEFAULT_FORM_3D, from: 'character' }, [])).toBeNull()
  })
})

describe('3D Studio starts, the dock', () => {
  it('Text: describes one object, sends the magic prompt mode, then shows both steps', async () => {
    const calls = api({}, model({ start: 'text', picture: media('p1', { home: '3d' }), picture_job: job('j-pic', { type: 'generate', status: 'running', progress: 0.4 }) }))
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('radio', { name: 'Text' }))
    expect(screen.queryByRole('switch', { name: /Remove background/ })).not.toBeInTheDocument()
    expect(screen.getByText('Describe the object first.')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Describe one object' }), 'A brass oil lamp')
    expect(screen.getByText(/A picture is made first, then the model/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Make 3D/ }))

    await waitFor(() =>
      expect(posted(calls)).toEqual({ prompt: 'A brass oil lamp', magic_prompt: 'auto', engine: 'pixal3d', quality: 'final', remove_background: true }),
    )
    const steps = await screen.findByRole('list', { name: 'Progress' })
    expect(within(steps).getByText('Picture').parentElement).toHaveTextContent('Making… 40%')
    expect(within(steps).getByText('3D model').parentElement).toHaveTextContent('After the picture')
  })

  it('Character: a sheet with a turnaround fixes the engine to Pixal3D and says why', async () => {
    const calls = api({ c1: sheet(['turn_front', 'turn_side', 'turn_back']) }, model({ start: 'character', views_used: ['front', 'left', 'back'] }))
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('radio', { name: 'TRELLIS.2, general' }))
    await user.click(screen.getByRole('radio', { name: 'Character' }))
    expect(screen.getByText('Pick a character first.')).toBeInTheDocument()
    await user.click(await screen.findByRole('radio', { name: 'Maya' }))
    expect(await screen.findByText('Uses the turnaround views: front, left side, back.')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'TRELLIS.2, general' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: /Pixal3D/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('The turnaround views work with Pixal3D only.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Make 3D/ }))
    await waitFor(() => expect(posted(calls)).toEqual({ character_id: 'c1', engine: 'pixal3d', quality: 'final', remove_background: true }))
  })

  it('Character: without a turnaround the chosen engine goes as it is', async () => {
    const calls = api({ c2: sheet(['turn_front']) })
    renderAt('/3d?character=c2', route, seedCatalog)
    const user = userEvent.setup()

    expect(await screen.findByRole('radio', { name: 'Character' })).toHaveAttribute('aria-checked', 'true')
    expect(await screen.findByText(/No turnaround on the sheet yet/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Idris' })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: 'TRELLIS.2, general' }))
    await user.click(screen.getByRole('button', { name: /^Make 3D/ }))
    await waitFor(() => expect(posted(calls)).toEqual({ character_id: 'c2', engine: 'trellis2', quality: 'final', remove_background: true }))
  })

  it('Four views: four labelled slots, the front first, Pixal3D only', async () => {
    api()
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('radio', { name: 'Four views' }))
    for (const name of ['Front', 'Left (optional)', 'Back (optional)', 'Right (optional)']) expect(screen.getByRole('group', { name })).toBeInTheDocument()
    expect(screen.getByText('Add the front view first.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Make 3D/ })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'TRELLIS.2, general' })).toBeDisabled()
    expect(screen.getByText('Four views work with Pixal3D only.')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /Remove background/ })).toBeInTheDocument()
  })
})
