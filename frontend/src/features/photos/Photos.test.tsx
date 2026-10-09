import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Album } from '@/lib/catalogue'
import { media, mockApi, renderAt } from '@/test/media-fixtures'
import { PhotosPage } from './PhotosPage'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

const photos = [
  media('p1', { title: 'Bride', origin: 'upload', rating: 3, camera: 'NIKON Z 8', source_type: 'image/x-raw', thumb_url: '/t/p1' }),
  media('p2', { title: 'Groom', origin: 'upload', flag: 'pick', thumb_url: '/t/p2' }),
  media('p3', { title: 'Cake', origin: 'upload', flag: 'reject', thumb_url: '/t/p3' }),
]
const album = (id: string, extra: Partial<Album> = {}): Album =>
  ({ id, name: `Album ${id}`, kind: 'album', parent_id: null, client_id: null, shoot_date: null, venue: '', notes: '', rules: null, cover_id: null, cover_url: null, sort: 0, count: 0, ...extra })
const facets = { flag: { pick: 1, reject: 1, none: 1 }, rating: { '0': 2, '3': 1 }, label: { none: 3 }, camera: [{ value: 'NIKON Z 8', count: 1 }], lens: [], keyword: [], date: [], edited: { yes: 0, no: 3 }, total: 3 }

function setup(path = '/photos', extra: (m: string, p: string, q: Record<string, string>, b: unknown) => unknown = () => undefined) {
  const calls = mockApi((method, p, q, body) => {
    const hit = extra(method, p, q, body)
    if (hit !== undefined) return hit
    if (p === '/photos') return { items: photos, total: 3, offset: 0, next_offset: null }
    if (p === '/photos/facets') return facets
    if (p === '/albums') return [album('a1', { name: 'Portfolio' }), album('s1', { name: 'Mehndi', kind: 'shoot', client_id: 'c1', shoot_date: '2026-05-01' })]
    if (p === '/clients') return [{ id: 'c1', name: 'Ayesha', email: '', phone: '', notes: '', shoots: 1, photos: 2 }]
    if (method === 'POST' && p === '/photos/marks') return { updated: 1 }
    if (method === 'POST' && p.endsWith('/items')) return { changed: 1, album: album('a1') }
    return undefined
  })
  renderAt(path, [{ path: '/photos', element: <PhotosPage /> }])
  return calls
}

describe('Photos library', () => {
  it('shows the catalogue with marks, badges, sources and clients', async () => {
    setup()
    const grid = await screen.findByRole('list', { name: 'Photos' })
    expect(within(grid).getByRole('button', { name: /Bride, 3 stars/ })).toBeInTheDocument()
    expect(within(grid).getByRole('button', { name: /Groom, pick/ })).toBeInTheDocument()
    expect(within(grid).getByText('RAW')).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Photo sources' })
    expect(await within(nav).findByRole('button', { name: 'Ayesha actions' })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: /Mehndi · 2026-05-01/ })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Portfolio actions' })).toBeInTheDocument()
  })

  it('culls with the keyboard: P picks, 4 rates, auto-advance moves on', async () => {
    const calls = setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /^Bride/ }))
    fireEvent.keyDown(window, { key: 'p' })
    await waitFor(() => expect(calls.find((c) => c.path === '/photos/marks')?.body).toEqual({ ids: ['p1'], flag: 'pick' }))
    await user.click(screen.getByRole('button', { name: /Auto-advance/ }))
    fireEvent.keyDown(window, { key: '4' })
    await waitFor(() => expect(calls.filter((c) => c.path === '/photos/marks')[1]?.body).toEqual({ ids: ['p1'], rating: 4 }))
    // the next mark lands on the next photo
    fireEvent.keyDown(window, { key: 'x' })
    await waitFor(() => expect(calls.filter((c) => c.path === '/photos/marks')[2]?.body).toEqual({ ids: ['p2'], flag: 'reject' }))
    // keys are ignored while typing
    await user.type(screen.getByPlaceholderText('Search'), 'p')
    expect(calls.filter((c) => c.path === '/photos/marks')).toHaveLength(3)
  })

  it('B adds the selection to the target album; Shift-click selects a range', async () => {
    const calls = setup()
    const user = userEvent.setup()
    const nav = await screen.findByRole('navigation', { name: 'Photo sources' })
    await user.click(await within(nav).findByRole('button', { name: 'Portfolio actions' }))
    await user.click(await screen.findByRole('menuitem', { name: /Set as target album/ }))
    await user.click(screen.getByRole('button', { name: /^Bride/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Cake/ }), { shiftKey: true })
    expect(screen.getByText(/3 selected/)).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'b' })
    await waitFor(() => expect(calls.find((c) => c.path === '/albums/a1/items')?.body).toEqual({ ids: ['p1', 'p2', 'p3'], action: 'add' }))
  })

  it('filters by flag and camera through the URL and the API', async () => {
    const calls = setup()
    const user = userEvent.setup()
    await screen.findByRole('list', { name: 'Photos' })
    await user.click(screen.getByRole('button', { name: /Picks/, pressed: false }))
    await waitFor(() => expect(calls.some((c) => c.path === '/photos' && c.query.flag === 'pick')).toBe(true))
    await user.click(screen.getByRole('button', { name: /Camera/ }))
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /NIKON Z 8/ }))
    await waitFor(() => expect(calls.some((c) => c.path === '/photos' && c.query.camera === 'NIKON Z 8' && c.query.flag === 'pick')).toBe(true))
  })

  it('opens a shoot from Sources and switches to loupe with E', async () => {
    const calls = setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Mehndi · 2026-05-01/ }))
    await waitFor(() => expect(calls.some((c) => c.path === '/photos' && c.query.album_id === 's1')).toBe(true))
    await user.click(await screen.findByRole('button', { name: /^Bride/ }))
    fireEvent.keyDown(window, { key: 'e' })
    expect(await screen.findByRole('img', { name: 'Bride' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Filmstrip' })).toBeInTheDocument()
  })

  it('creates a smart album from rules', async () => {
    const calls = setup('/photos', (m, p) => (m === 'POST' && p === '/albums' ? album('n1', { kind: 'smart' }) : undefined))
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /New…/ }))
    await user.click(await screen.findByRole('menuitem', { name: /Smart album/ }))
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'Five stars')
    await user.clear(screen.getByRole('spinbutton', { name: 'Rule 1 value' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Rule 1 value' }), '5')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/albums')?.body).toMatchObject({
      name: 'Five stars', kind: 'smart', rules: { match: 'all', rules: [{ field: 'rating', op: '>=', value: 5 }] },
    }))
  })

  it('import refuses non-photos before uploading', async () => {
    setup()
    const user = userEvent.setup({ applyAccept: false })
    await user.click(await screen.findByRole('button', { name: /^Import$/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Import photos' })
    const input = dialog.querySelector('input[type=file]') as HTMLInputElement
    await user.upload(input, new File(['x'], 'notes.txt', { type: 'text/plain' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/isn't a photo we can import/)
  })
})
