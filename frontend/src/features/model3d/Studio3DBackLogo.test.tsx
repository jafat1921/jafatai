import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { blocked3d, DEFAULT_FORM_3D, make3dPayload, otherEngine, remakePayload, startFromQuery } from '@/lib/model3d'
import { job, media, mockApi, renderAt } from '@/test/media-fixtures'
import { seedCatalog } from '@/test/model-fixtures'
import { Studio3DPage } from './Studio3DPage'

vi.mock('./viewer3d', () => ({ createViewer: vi.fn() }))
vi.mock('./exporters', () => ({ exportModel: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

const answer = (extra = {}) => ({
  item: media('m9', { kind: 'model', title: 'Badge · 3D', status: 'queued', media_url: null }),
  job: job('j-model', { type: 'generate' }),
  model_resolved: 'pixal3d',
  background_note: null,
  ...extra,
})

function api(made: object = answer()) {
  return mockApi((method, path) => {
    if (path === '/media') return { items: [] }
    const id = path.match(/^\/media\/(\w+)$/)?.[1]
    if (id) return { ...media(id, { title: 'Badge' }), versions: [] }
    if (path === '/estimate') return { low_s: 5, high_s: 12, basis: 'rough', samples: 0 }
    if (method === 'POST' && path === '/3d/make') return made
  })
}

const route = [{ path: '/3d', element: <Studio3DPage /> }]
const posted = (calls: ReturnType<typeof api>) => calls.find((c) => c.method === 'POST' && c.path === '/3d/make')?.body
const glb = (model3d: object) => media('m1', { kind: 'model', title: 'Badge · 3D', status: 'ready', params: { model3d } })

describe('3D Studio better back and logo, the rules', () => {
  it('builds a logo request with its options, and no engine or quality', () => {
    const f = { ...DEFAULT_FORM_3D, from: 'logo' as const }
    expect(blocked3d(f, undefined)).toBe('Add the logo first.')
    expect(make3dPayload(f)).toBeNull()
    expect(make3dPayload({ ...f, logoId: 'l1', removeBackground: false, logo: { depth: 'thick', bevel: 'round', finish: 'chrome', back: 'plain' } })).toEqual({
      logo_id: 'l1',
      logo: { depth: 'thick', bevel: 'round', finish: 'chrome', back: 'plain' },
      remove_background: false,
    })
    expect(startFromQuery(new URLSearchParams('from=logo&source=l9'))).toMatchObject({ from: 'logo', logoId: 'l9' })
  })

  it('makes better back and logos again the way they were made', () => {
    const back = glb({ engine: 'pixal3d', quality: 'final', remove_background: true, source_id: 'g-s1', source_media_id: 's1', better_back: { status: 'done' }, views: { front: 'g-s1', left: 'g-l' } })
    expect(remakePayload(back)).toEqual({ source_id: 's1', engine: 'pixal3d', quality: 'final', remove_background: true, title: 'Badge · 3D', better_back: true })
    expect(otherEngine(back)).toBeNull()

    const logo = glb({ start: 'logo', source_id: 'g-l1', source_media_id: 'l1', alpha: 'key', logo: { depth: 'thin', bevel: 'none', finish: 'steel', back: 'mirror' } })
    expect(remakePayload(logo)).toEqual({ logo_id: 'l1', logo: { depth: 'thin', bevel: 'none', finish: 'steel', back: 'mirror' }, remove_background: false, title: 'Badge · 3D' })
    expect(otherEngine(logo)).toBeNull()

    const character = glb({ start: 'character', character_id: 'c1', engine: 'trellis2', quality: 'final', remove_background: true, source_id: 'g-p' })
    expect(remakePayload(character)).toMatchObject({ character_id: 'c1', better_back: false })
  })
})

describe('3D Studio better back and logo, the dock', () => {
  it('Picture: Better back is off with a hint, and on it fixes Pixal3D and shows the views first', async () => {
    const calls = api(
      answer({
        better_back: true,
        back_views: [media('v1', { home: '3d' }), media('v2', { home: '3d' })],
        back_jobs: [job('j-side', { type: 'generate', status: 'running', progress: 0.5 }), job('j-back', { type: 'generate' })],
        engine_note: 'Better back works with Pixal3D only, so Pixal3D made this one.',
      }),
    )
    renderAt('/3d?image=s1', route, seedCatalog)
    const user = userEvent.setup()

    const back = await screen.findByRole('switch', { name: /Better back/ })
    expect(back).not.toBeChecked()
    expect(screen.getByText(/Turn on for people and figures/)).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'TRELLIS.2, general' }))
    await user.click(back)
    expect(screen.getByRole('radio', { name: 'TRELLIS.2, general' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: /Pixal3D/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(/The side and back views are made first, then the model/)).toBeInTheDocument()
    await waitFor(() => expect(calls.some((c) => c.path === '/estimate' && c.query.better_back === 'true' && c.query.model === 'pixal3d')).toBe(true))

    await user.click(screen.getByRole('button', { name: /^Make 3D/ }))
    await waitFor(() => expect(posted(calls)).toEqual({ source_id: 's1', engine: 'pixal3d', quality: 'final', remove_background: true, better_back: true }))
    const steps = await screen.findByRole('list', { name: 'Progress' })
    expect(within(steps).getByText('Side view').parentElement).toHaveTextContent('Making… 50%')
    expect(within(steps).getByText('Back view').parentElement).toHaveTextContent('Waiting')
    expect(within(steps).getByText('3D model').parentElement).toHaveTextContent('After the views')
    expect(screen.getByText('Better back works with Pixal3D only, so Pixal3D made this one.')).toBeInTheDocument()
  })

  it('Logo: its own fields, no engine or quality, seconds on the button and the cut-out first', async () => {
    const calls = api(answer({ start: 'logo', model_resolved: 'logo', cutout: media('c1', { home: '3d' }), cutout_job: job('j-cut', { type: 'generate' }) }))
    renderAt('/3d', route, seedCatalog)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('radio', { name: 'Logo' }))
    expect(screen.getByText(/Crisp letters and edges — best for logos, signs, icons, stickers/)).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Engine' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Quality' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /Better back/ })).not.toBeInTheDocument()
    expect(screen.getByText('Add the logo first.')).toBeInTheDocument()
    for (const name of ['Depth', 'Bevel', 'Sides', 'Back']) expect(screen.getByRole('group', { name })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Gold' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('The artwork shows through on the back.')).toBeInTheDocument()
    await waitFor(() => expect(calls.some((c) => c.path === '/estimate' && c.query.model === 'logo')).toBe(true))
  })

  it('Logo: sends the picture and the chosen options, then shows the cut-out step', async () => {
    const calls = api(answer({ start: 'logo', model_resolved: 'logo', cutout: media('c1', { home: '3d' }), cutout_job: job('j-cut', { type: 'generate', status: 'running', progress: 0.2 }) }))
    renderAt('/3d?from=logo&source=l1', route, seedCatalog)
    const user = userEvent.setup()

    expect(await screen.findByRole('radio', { name: 'Logo' })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('radio', { name: 'Thick' }))
    await user.click(screen.getByRole('radio', { name: 'Round' }))
    await user.click(screen.getByRole('radio', { name: 'Brushed steel' }))
    await user.click(screen.getByRole('radio', { name: 'Plain' }))
    expect(screen.getByText('The back takes the finish.')).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: /Remove background/ }))
    await user.click(screen.getByRole('button', { name: /^Make 3D · badge/ }))

    await waitFor(() =>
      expect(posted(calls)).toEqual({ logo_id: 'l1', logo: { depth: 'thick', bevel: 'round', finish: 'steel', back: 'plain' }, remove_background: false }),
    )
    const steps = await screen.findByRole('list', { name: 'Progress' })
    expect(within(steps).getByText('Cut-out').parentElement).toHaveTextContent('Making… 20%')
    expect(within(steps).getByText('3D model').parentElement).toHaveTextContent('After the cut-out')
  })
})
