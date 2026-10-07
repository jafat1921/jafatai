import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { qk } from '@/hooks/keys'
import { addRefs, draftFrom, kitPatch, kitProblems, normalizeHex } from '@/lib/brand'
import { fakeXhr, file, kit } from '@/test/brand-fixtures'
import { media, mockApi, renderAt } from '@/test/media-fixtures'
import { BrandKitEditorPage } from './BrandKitEditorPage'
import { BrandKitsPage } from './BrandKitsPage'

afterEach(() => vi.unstubAllGlobals())

describe('brand kit rules', () => {
  it('normalises hex colours and refuses anything else', () => {
    expect(normalizeHex('0f4c5c')).toBe('#0F4C5C')
    expect(normalizeHex(' #abc ')).toBe('#AABBCC')
    expect(normalizeHex('#12345')).toBeNull()
    expect(normalizeHex('teal')).toBeNull()
  })

  it('lists every problem in words: name, hex, too many refs, unnamed product', () => {
    const d = {
      ...draftFrom(kit('k1')),
      name: ' ',
      palette: [{ hex: '#0F4C5C' }, { hex: 'nope' }],
      reference_media_ids: ['1', '2', '3', '4', '5', '6', '7'],
      products: [{ media_id: 'p1', name: '', description: '' }],
    }
    expect(kitProblems(d)).toEqual([
      'Give the kit a name.',
      'Colour 2 (“nope”) isn\'t a hex colour like #0F4C5C.',
      'Use at most 6 mood references.',
      'Product 1 needs a name.',
    ])
    expect(kitProblems(draftFrom(kit('k1')))).toEqual([])
  })

  it('caps mood references at six and says how many were left out', () => {
    expect(addRefs(['a', 'b', 'c', 'd', 'e'], ['e', 'f', 'g', 'h'])).toEqual({ ids: ['a', 'b', 'c', 'd', 'e', 'f'], dropped: 2 })
  })

  it('sends normalised hexes and trimmed names', () => {
    const p = kitPatch({ ...draftFrom(kit('k1')), name: ' Leaf ', palette: [{ hex: 'e3b23c', name: ' warm sand ' }, { hex: '#0f4c5c', name: '' }] })
    expect(p.name).toBe('Leaf')
    expect(p.palette).toEqual([{ hex: '#E3B23C', name: 'warm sand' }, { hex: '#0F4C5C' }])
  })
})

function editor(k = kit('k1', { name: 'Leaf Coffee', is_default: true })) {
  const calls = mockApi((method, path, _q, body) => {
    if (method === 'PATCH' && path === '/brand-kits/k1') return { ...k, ...(body as object) }
    if (path === '/media') return { items: [] }
  })
  const r = renderAt('/brand-kits/k1', [{ path: '/brand-kits/:kitId', element: <BrandKitEditorPage /> }], (qc) => qc.setQueryData(qk.brandKit('k1'), k))
  return { ...r, calls, user: userEvent.setup() }
}

describe('Brand kit editor', () => {
  it('blocks saving a bad hex, then saves the fixed palette', async () => {
    const { calls, user } = editor()
    await user.click(screen.getByRole('button', { name: 'Add colour' }))
    const hex = screen.getByRole('textbox', { name: 'Colour 1 hex' })
    // paste, not type: the whole editor re-renders per keystroke, which is slow under jsdom
    await user.clear(hex)
    await user.paste('#12')
    expect(screen.getByText('Use a hex colour like #0F4C5C.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Save/ })).toBeDisabled()

    await user.clear(hex)
    await user.paste('0f4c5c')
    await user.click(screen.getByRole('textbox', { name: 'Colour 1 name' }))
    await user.paste('deep teal')
    await user.click(screen.getByRole('button', { name: /^Save/ }))
    const patch = calls.find((c) => c.method === 'PATCH')
    expect(patch?.body).toMatchObject({ name: 'Leaf Coffee', palette: [{ hex: '#0F4C5C', name: 'deep teal' }] })
    expect(await screen.findByText('All changes saved')).toBeInTheDocument()
  })

  it('stops at six colours and six mood references', () => {
    const six = kit('k1', {
      palette: ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666'].map((hex) => ({ hex })),
      reference_media_ids: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
    })
    editor(six)
    expect(screen.getByRole('button', { name: 'Add colour' })).toBeDisabled()
    expect(screen.getByRole('heading', { name: 'Mood references (6/6)' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Add mood references' })).not.toBeInTheDocument()
  })

  it('uploads a TTF to the font endpoint, refuses a WOFF, and previews Urdu text either way round', async () => {
    const sent = fakeXhr(() => ({ status: 201, body: { item: { ...media('f1', { title: 'Leaf Sans' }), kind: 'font' }, warnings: [] } }))
    const { calls, user } = editor()
    const zone = screen.getByRole('group', { name: 'Add a font' })

    fireEvent.drop(zone, { dataTransfer: { files: [file('Leaf.woff', 'font/woff')] } })
    expect(within(screen.getByRole('list', { name: 'Add a font uploads' })).getByRole('alert')).toHaveTextContent(/Try TTF or OTF up to 10 MB/)
    expect(sent).toHaveLength(0)

    fireEvent.drop(zone, { dataTransfer: { files: [file('Leaf.ttf', '')] } })
    const fonts = await screen.findByRole('list', { name: 'Fonts' })
    expect(sent[0].url).toBe('/api/brand-kits/assets?purpose=font')
    expect(within(fonts).getByText(/Leaf Sans · used for cards and the logo reveal/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Preview text' })).toHaveAttribute('dir', 'auto')

    await user.click(screen.getByRole('button', { name: /^Save/ }))
    expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({ font_files: ['f1'] })
  })

  it('asks for a logo description and keeps the extras folded away and off', async () => {
    const { user } = editor(kit('k1', { logos: { primary: { media_id: 'lg', description: '' } }, assets: { lg: { media_id: 'lg', media_url: '/m/lg.png', missing: false } } }))
    expect(screen.getByText(/describe each logo so the AI places it well/i)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Describe it' })).toHaveAttribute('placeholder', 'e.g. round green leaf with white wordmark')
    const extras = screen.getByRole('button', { name: /Optional extras/ })
    expect(extras).toHaveAttribute('aria-expanded', 'false')
    expect(extras).toHaveTextContent('All off')
    expect(screen.getByRole('radio', { name: 'Auto' })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: 'Exact logo reveal' }))
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
  })

  it('previews the logo reveal and plays it when ready', async () => {
    const calls = mockApi((method, path) => {
      if (method === 'POST' && path === '/brand-kits/k1/logo-reveal') return { item: media('rv', { kind: 'video', media_url: null, status: 'queued' }), job: { id: 'j', type: 'brand_reveal', status: 'queued', progress: 0, message: '', attempts: 0, created_at: '' } }
      if (path === '/media/rv') return { ...media('rv', { kind: 'video', media_url: '/m/rv.mp4', status: 'ready' }), versions: [] }
    })
    const k = kit('k1', { logos: { primary: { media_id: 'lg', description: 'leaf' } } })
    const { qc } = renderAt('/brand-kits/k1', [{ path: '/brand-kits/:kitId', element: <BrandKitEditorPage /> }], (q) => q.setQueryData(qk.brandKit('k1'), k))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Preview logo reveal' }))
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ duration_s: 3, aspect: '16:9', background: { kind: 'color' }, show_tagline: true })
    expect(await screen.findByText(/Rendering the reveal/)).toBeInTheDocument()
    // the SSE event that marks it ready
    qc.setQueryData(qk.mediaItem('rv'), { ...media('rv', { kind: 'video', media_url: '/m/rv.mp4', status: 'ready' }), versions: [] })
    expect(await screen.findByLabelText('Logo reveal preview')).toHaveAttribute('src', '/m/rv.mp4')
  })
})

describe('Brand kits list', () => {
  it('explains the idea when empty and creates the first kit', async () => {
    const calls = mockApi((method, path) => {
      if (method === 'POST' && path === '/brand-kits') return kit('new1', { name: 'My brand', is_default: true })
      if (path === '/brand-kits') return []
    })
    renderAt('/brand-kits', [
      { path: '/brand-kits', element: <BrandKitsPage /> },
      { path: '/brand-kits/:kitId', element: <p>editor</p> },
    ])
    const user = userEvent.setup()
    expect(await screen.findByText('No brand kits yet')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create your first kit' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/brand-kits/new1'))
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'My brand' })
  })

  it('shows the default kit first with its palette, and can make another the default', async () => {
    const calls = mockApi((method, path) => {
      if (path === '/brand-kits') return [kit('a', { name: 'Leaf', is_default: true, palette: [{ hex: '#0F4C5C', name: 'teal' }] }), kit('b', { name: 'Stone' })]
      if (method === 'POST' && path === '/brand-kits/b/default') return kit('b', { name: 'Stone', is_default: true })
    })
    renderAt('/brand-kits', [{ path: '/brand-kits', element: <BrandKitsPage /> }])
    const user = userEvent.setup()
    const list = await screen.findByRole('list', { name: 'Your brand kits' })
    expect(within(list).getByRole('img', { name: 'Palette: teal' })).toBeInTheDocument()
    await user.click(within(list).getByRole('button', { name: 'Make default' }))
    expect(calls.some((c) => c.path === '/brand-kits/b/default')).toBe(true)
  })
})
