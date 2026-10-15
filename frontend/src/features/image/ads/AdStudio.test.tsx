import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hexOrNull, patchFrom, type Ad, type AdCampaign, type AdConcept, type AdSpec } from '@/lib/ads'
import type { BrandKit } from '@/lib/brand'
import { T, job, mockApi, renderAt } from '@/test/media-fixtures'
import { AdCampaignPage } from './AdCampaignPage'
import { AdStudioPage } from './AdStudioPage'

const routes = [
  { path: '/image/ads', element: <AdStudioPage /> },
  { path: '/image/ads/:id', element: <AdCampaignPage /> },
]

const KIT = {
  id: 'k1',
  workspace_id: 'w1',
  name: 'iXperts',
  is_default: true,
  palette: [
    { hex: '#22223B', name: 'Navy' },
    { hex: '#E8857B', name: 'Coral' },
  ],
  style_text: '',
  voice_text: '',
  tagline: '',
  logos: {},
  products: [],
  font_files: [],
  reference_media_ids: [],
  settings: {},
  contact: { phone: '+46 72 846 7394' },
  claims: ['Från 215 kr/timme', 'Ingen bindningstid'],
  assets: {},
  created_at: T,
  updated_at: T,
} as unknown as BrandKit

const concept = (n: number, extra: Partial<AdConcept> = {}): AdConcept => ({
  id: `c${n}`,
  n,
  approved: true,
  edited: false,
  insight: 'Dark evenings',
  kicker: 'Höstmys',
  headline: `Tänd ljusen ${n}`,
  body: 'Vi tar dammet.',
  cta: 'Boka nu',
  offers: ['Från 215 kr/timme'],
  layout: 'frosted',
  photo_prompt: 'a cosy room',
  placement: 'right',
  logo_surface: '',
  error: null,
  guard: { offers_dropped: ['Gratis första gången'], numbers_removed: [] },
  photos: {},
  ...extra,
})

const spec: AdSpec = {
  format: '4:5',
  style: 'frosted',
  font_preset: 'modern',
  language: 'sv',
  rtl: false,
  texts: { kicker: 'Höstmys', headline: 'Tänd ljusen 1', body: 'Vi tar dammet.', offers: ['Från 215 kr/timme'], cta: 'Boka nu', badge_big: '215 kr', badge_small: 'FRÅN' },
  colours: {},
  palette: KIT.palette,
  logo: { position: 'tl', variant: 'auto' },
  footer: true,
  contact: { phone: '+46 72 846 7394' },
  focus: { x: 0.5, y: 0.5 },
  photo_id: 'p1',
}

const ad: Ad = {
  id: 'a1',
  concept_id: 'c1',
  format: '4:5',
  status: 'ready',
  error: null,
  media_id: 'm1',
  generation_id: 'g1',
  version: 1,
  image_url: '/api/media/a1.png',
  thumb_url: '/api/media/thumb/g1',
  width: 1080,
  height: 1350,
  overrides: {},
  report: { contrast: { body: 11 }, treatment: [] },
  spec,
  stale: false,
}

function campaign(extra: Partial<AdCampaign> = {}): AdCampaign {
  return {
    id: 'ad1',
    title: 'Höststädning',
    language: 'sv',
    rtl: false,
    stage: 'concepts',
    status: 'review',
    review: 'concepts',
    stages: [
      { key: 'concepts', label: 'Concepts', status: 'review', detail: null },
      { key: 'photos', label: 'Photos', status: 'pending', detail: null },
      { key: 'layout', label: 'Layout', status: 'pending', detail: null },
    ],
    brief: {
      subject: 'Weekly cleaning',
      description: '',
      brief: '',
      occasion: '',
      market: '',
      tone: '',
      must_say: '',
      offers: [],
      formats: ['4:5'],
      variants: 2,
      image_model: 'zimage_turbo',
      product_media_ids: [],
      review: true,
      logo_on_surface: true,
      font_preset: null,
    },
    brand_kit: { id: 'k1', name: 'iXperts', palette: KIT.palette, contact: {}, claims: [], has_fonts: false, has_logo: true, missing_contact: ['website', 'location'] },
    concepts: [concept(1), concept(2)],
    ads: [],
    ad_json_url: null,
    zip_url: null,
    job: null,
    created_at: T,
    updated_at: T,
    ...extra,
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ad helpers', () => {
  it('sends only what changed', () => {
    const edit = { ...spec, style: 'split' as const, texts: { ...spec.texts, headline: 'Ny' }, colours: { accent: '#E8857B' } }
    expect(patchFrom(spec, edit)).toEqual({ style: 'split', texts: { headline: 'Ny' }, colours: { accent: '#E8857B' } })
    expect(patchFrom(spec, spec)).toEqual({})
    expect(hexOrNull('e8857b')).toBe('#E8857B')
    expect(hexOrNull('teal')).toBeNull()
  })
})

describe('brief form', () => {
  it('picks the default kit, nudges for contact details, sends the ticked offers', async () => {
    const calls = mockApi((method, path) => {
      if (path === '/brand-kits') return [KIT]
      if (method === 'POST' && path === '/ads') return campaign({ status: 'running', review: null })
      if (path === '/ads/ad1') return campaign()
      return []
    })
    renderAt('/image/ads', routes)
    expect(await screen.findByText('Say what you are advertising first.')).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'iXperts' })).toHaveAttribute('href', '/brand-kits/k1')
    expect(screen.getByText(/Add your website and location/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('What are you advertising?'), 'Weekly home cleaning')
    await userEvent.click(screen.getByRole('button', { name: 'Från 215 kr/timme' }))
    await userEvent.type(screen.getByLabelText('Another offer'), '15% rabatt{Enter}')
    await userEvent.click(screen.getByRole('button', { name: /Story 9:16/ }))
    await userEvent.selectOptions(screen.getByLabelText('Language of the ads'), 'sv')
    for (const input of [screen.getByLabelText('What are you advertising?'), screen.getByLabelText('Brief (optional)')]) {
      expect(input).toHaveAttribute('dir', 'auto')
    }
    expect(document.body.textContent).not.toMatch(/licen[cs]e|commercial/i)
    await userEvent.click(screen.getByRole('button', { name: /Make the ads/ }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/ads')).toBeTruthy())
    const body = calls.find((c) => c.method === 'POST' && c.path === '/ads')!.body as Record<string, unknown>
    expect(body).toMatchObject({
      subject: 'Weekly home cleaning',
      brand_kit_id: 'k1',
      language: 'sv',
      offers: ['Från 215 kr/timme', '15% rabatt'],
      formats: ['4:5', '9:16'],
      review: true,
      product_media_ids: [],
    })
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/image/ads/ad1'))
  })
})

describe('campaign page', () => {
  it('edits a concept, unticks one and approves the rest', async () => {
    let camp = campaign()
    const calls = mockApi((method, path, _q, body) => {
      if (method === 'PATCH' && path === '/ads/ad1/concepts/c2') {
        const b = body as Record<string, unknown>
        camp = { ...camp, concepts: camp.concepts.map((c) => (c.id === 'c2' ? { ...c, ...b } : c)) }
        return camp
      }
      if (method === 'PATCH' && path === '/ads/ad1/concepts/c1') return camp
      if (method === 'POST' && path === '/ads/ad1/continue') return job('j1', { type: 'ad_campaign' })
      if (path === '/ads/ad1') return camp
      return []
    })
    renderAt('/image/ads/ad1', routes)
    const card = await screen.findByRole('listitem', { name: 'Concept 1' })
    expect(within(card).getByText(/Left out because they weren't in your offers/)).toBeInTheDocument()
    const headline = within(card).getByLabelText('Headline')
    expect(headline).toHaveAttribute('dir', 'auto')
    expect(headline).toHaveAttribute('lang', 'sv')
    await userEvent.clear(headline)
    await userEvent.type(headline, 'Släpp in ljuset')
    await userEvent.click(within(card).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && c.path === '/ads/ad1/concepts/c1')).toBeTruthy())
    expect(calls.find((c) => c.path === '/ads/ad1/concepts/c1')!.body).toEqual({ headline: 'Släpp in ljuset' })

    await userEvent.click(screen.getByRole('switch', { name: 'Make concept 2' }))
    await waitFor(() => expect(calls.find((c) => c.path === '/ads/ad1/concepts/c2')?.body).toEqual({ approved: false }))
    const go = await screen.findByRole('button', { name: 'Make 1 concept' })
    await userEvent.click(go)
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/ads/ad1/continue')).toBe(true))
  })

  it('opens the editor, previews live and saves a re-render', async () => {
    const done = campaign({
      stage: 'done',
      status: 'done',
      review: null,
      stages: ['concepts', 'photos', 'layout'].map((k) => ({ key: k as 'concepts', label: k, status: 'done', detail: null })),
      ads: [ad],
      zip_url: '/api/ads/ad1/zip',
    })
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:preview', revokeObjectURL: () => {} }))
    const calls = mockApi((method, path) => {
      if (method === 'POST' && path === '/ads/ad1/ads/a1/preview') return new Response('png', { status: 200, headers: { 'Content-Type': 'image/png' } })
      if (method === 'PATCH' && path === '/ads/ad1/ads/a1') return { ...ad, version: 2, generation_id: 'g2', spec: { ...spec, style: 'split', texts: { ...spec.texts, headline: 'Ny rubrik' } } }
      if (path === '/ads/ad1') return done
      return []
    })
    renderAt('/image/ads/ad1', routes)
    expect(await screen.findByRole('link', { name: /Download all/ })).toHaveAttribute('href', '/api/ads/ad1/zip')
    const tile = screen.getByRole('listitem', { name: 'Concept 1, Feed 4:5' })
    await userEvent.click(within(tile).getByRole('button', { name: 'Edit' }))
    const editor = screen.getByRole('complementary', { name: 'Edit Feed 4:5' })
    const headline = within(editor).getByLabelText('Headline')
    await userEvent.clear(headline)
    await userEvent.type(headline, 'Ny rubrik')
    await userEvent.selectOptions(within(editor).getByLabelText('Layout'), 'split')
    await userEvent.selectOptions(within(editor).getByLabelText('Accent'), '#E8857B')
    await waitFor(() => expect(calls.some((c) => c.path === '/ads/ad1/ads/a1/preview')).toBe(true), { timeout: 3000 })
    await waitFor(() => expect(within(editor).getByRole('img', { name: 'Preview with your changes' })).toHaveAttribute('src', 'blob:preview'))
    await userEvent.click(within(editor).getByRole('button', { name: 'Save this ad' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && c.path === '/ads/ad1/ads/a1')).toBeTruthy())
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ texts: { headline: 'Ny rubrik' }, style: 'split', colours: { accent: '#E8857B' } })
    // nothing went to a GPU route
    expect(calls.some((c) => c.path.startsWith('/images'))).toBe(false)
  })
})
