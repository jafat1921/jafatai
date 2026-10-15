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
  socials: [],
  follow: { show: false, text: '' },
  footer_items: { contact: ['phone'], socials: [] },
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
    brand_kit: { id: 'k1', name: 'iXperts', palette: KIT.palette, contact: {}, socials: [], claims: [], has_fonts: false, has_logo: true, missing_contact: ['website', 'socials'] },
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
    expect(screen.getByText(/Add your website or booking link and social accounts/)).toBeInTheDocument()
    // the footer pick starts from the kit's digital details; unticking one sends the campaign's own pick
    const phone = screen.getByRole('checkbox', { name: 'Phone' })
    expect(phone).toBeChecked()
    await userEvent.click(phone)
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
      footer_items: { contact: [], socials: [] },
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
    await userEvent.click(within(editor).getByRole('radio', { name: 'Split colour block' }))
    await userEvent.selectOptions(within(editor).getByLabelText('Accent'), '#E8857B')
    await waitFor(() => expect(calls.some((c) => c.path === '/ads/ad1/ads/a1/preview')).toBe(true), { timeout: 3000 })
    await waitFor(() => expect(within(editor).getByRole('img', { name: 'Preview with your changes' })).toHaveAttribute('src', 'blob:preview'))
    await userEvent.click(within(editor).getByRole('button', { name: 'Save this ad' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && c.path === '/ads/ad1/ads/a1')).toBeTruthy())
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ texts: { headline: 'Ny rubrik' }, style: 'split', colours: { accent: '#E8857B' } })
    // nothing went to a GPU route
    expect(calls.some((c) => c.path.startsWith('/images'))).toBe(false)
  })

  it('picks the footer items, socials and the follow line per ad', async () => {
    const kitOut = {
      id: 'k1',
      name: 'iXperts',
      palette: KIT.palette,
      contact: { phone: '+46 72 846 7394', website: 'https://www.ixperts.se', location: 'Stockholm' },
      socials: [
        { platform: 'instagram' as const, handle: '@ixperts.se', url: null, show_in_ads: true },
        { platform: 'tiktok' as const, handle: '@ixperts', url: null, show_in_ads: false },
      ],
      claims: [],
      has_fonts: false,
      has_logo: true,
      missing_contact: [],
    }
    const own: AdSpec = {
      ...spec,
      contact: { website: 'https://www.ixperts.se', phone: '+46 72 846 7394' },
      socials: [kitOut.socials[0]],
      footer_items: { contact: ['website', 'phone'], socials: ['instagram:ixperts.se'] },
    }
    const done = campaign({
      stage: 'done',
      status: 'done',
      review: null,
      brand_kit: kitOut,
      ads: [{ ...ad, spec: own, report: { ...ad.report, footer: { rows: 2, items: ['website'], dropped: ['location'], folded: false, size: 23 } } }],
    })
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:preview', revokeObjectURL: () => {} }))
    const calls = mockApi((method, path) => {
      if (method === 'POST' && path === '/ads/ad1/ads/a1/preview') return new Response('png', { status: 200, headers: { 'Content-Type': 'image/png' } })
      if (method === 'PATCH' && path === '/ads/ad1/ads/a1') return { ...ad, version: 2, spec: own }
      if (path === '/ads/ad1') return done
      return []
    })
    renderAt('/image/ads/ad1', routes)
    const tile = await screen.findByRole('listitem', { name: 'Concept 1, Feed 4:5' })
    await userEvent.click(within(tile).getByRole('button', { name: 'Edit' }))
    const editor = screen.getByRole('complementary', { name: 'Edit Feed 4:5' })
    expect(within(editor).getByText(/Left out to fit this format: address/)).toBeInTheDocument()
    expect(within(editor).getByRole('checkbox', { name: 'Website' })).toBeChecked()
    expect(within(editor).queryByRole('checkbox', { name: 'Email' })).toBeNull()
    await userEvent.click(within(editor).getByRole('checkbox', { name: 'Address' }))
    await userEvent.click(within(editor).getByRole('checkbox', { name: /Instagram/ }))
    await userEvent.click(within(editor).getByRole('checkbox', { name: /TikTok/ }))
    await userEvent.click(within(editor).getByRole('switch', { name: '“Follow us” line' }))
    await userEvent.type(within(editor).getByLabelText(/Its words/), 'Häng med')
    await userEvent.click(within(editor).getByRole('button', { name: 'Save this ad' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && c.path === '/ads/ad1/ads/a1')).toBeTruthy())
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      footer_items: { contact: ['website', 'phone', 'location'], socials: ['tiktok:ixperts'] },
      follow: { show: true, text: 'Häng med' },
    })
  })
})

describe('design leap (M16b)', () => {
  it('sends the shape, placement and key word only when they changed', () => {
    const own: AdSpec = { ...spec, style: 'cutout_blob', texts: { ...spec.texts, highlight: 'ljusen' }, shape: { mask: 'blob', colour: '#E8857B', seed: 7 }, placement: { flip: null } }
    expect(patchFrom(own, own)).toEqual({})
    const edit: AdSpec = { ...own, texts: { ...own.texts, highlight: '' }, shape: { ...own.shape!, colour: '#22223B', seed: 99 }, placement: { flip: true } }
    expect(patchFrom(own, edit)).toEqual({ texts: { highlight: '' }, shape: { colour: '#22223B', seed: 99 }, placement: { flip: true } })
    expect(patchFrom(own, { ...own, shape: { ...own.shape!, mask: 'arch' } })).toEqual({ shape: { mask: 'arch' } })
  })

  it('edits the key word, shape colour, copy side and mask shape, and shows the final check', async () => {
    const own: AdSpec = { ...spec, style: 'cutout_blob', texts: { ...spec.texts, highlight: 'ljusen' }, shape: { mask: 'arch', colour: '#E8857B', seed: 7 }, placement: { flip: null } }
    const done = campaign({
      stage: 'done',
      status: 'done',
      review: null,
      ads: [
        {
          ...ad,
          spec: own,
          report: {
            ...ad.report,
            fallback: 'big_price -> side_wash',
            quality: { contrast: {}, all_pass: true, dropped: {}, copy_check: [], treatment: [], qa: { checked: true, by: 'vision', score: 5, issues: ['copy over the face'], retried: [], flagged: true } },
          },
        },
      ],
    })
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:preview', revokeObjectURL: () => {} }))
    const calls = mockApi((method, path) => {
      if (method === 'POST' && path === '/ads/ad1/ads/a1/preview') return new Response('png', { status: 200, headers: { 'Content-Type': 'image/png' } })
      if (method === 'PATCH' && path === '/ads/ad1/ads/a1') return { ...ad, version: 2, spec: own }
      if (path === '/ads/ad1') return done
      return []
    })
    renderAt('/image/ads/ad1', routes)
    const tile = await screen.findByRole('listitem', { name: 'Concept 1, Feed 4:5' })
    await userEvent.click(within(tile).getByRole('button', { name: 'Edit' }))
    const editor = screen.getByRole('complementary', { name: 'Edit Feed 4:5' })
    expect(within(editor).getByText('The final check flagged this ad: copy over the face')).toBeInTheDocument()
    expect(within(editor).getByText(/Big price couldn.t be used for this ad, so it uses Side wash instead/)).toBeInTheDocument()
    expect(within(editor).getByRole('radio', { name: 'Cut-out on a shape' })).toHaveAttribute('aria-checked', 'true')

    const kw = within(editor).getByLabelText('Key word')
    expect(kw).toHaveValue('ljusen')
    expect(kw).toHaveAttribute('dir', 'auto')
    await userEvent.clear(kw)
    await userEvent.type(kw, 'Tänd')
    await waitFor(() => expect(calls.some((c) => c.path === '/ads/ad1/ads/a1/preview' && (c.body as { texts?: { highlight?: string } }).texts?.highlight === 'Tänd')).toBe(true), { timeout: 3000 })

    const hex = within(editor).getByLabelText('Shape colour')
    await userEvent.clear(hex)
    await userEvent.type(hex, '22223b')
    await userEvent.click(within(editor).getByRole('radio', { name: 'Swap' }))
    expect(within(editor).queryByRole('radiogroup', { name: 'Mask shape' })).toBeNull()
    await userEvent.click(within(editor).getByRole('radio', { name: 'Photo in an arch' }))
    await userEvent.click(within(within(editor).getByRole('radiogroup', { name: 'Mask shape' })).getByRole('radio', { name: 'Circle' }))
    expect(document.body.textContent).not.toMatch(/licen[cs]e|commercial/i)

    await userEvent.click(within(editor).getByRole('button', { name: 'Save this ad' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && c.path === '/ads/ad1/ads/a1')).toBeTruthy())
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      texts: { highlight: 'Tänd' },
      style: 'arch_mask',
      shape: { mask: 'circle', colour: '#22223B' },
      placement: { flip: true },
    })
  })

  it('sends quality, photo candidates, quotes and the style switch with the brief', async () => {
    const styled = { ...KIT, ad_style: { references: [], rules: { layouts: ['arch_mask'] }, status: 'ready', error: null, job_id: null, updated_at: T } } as BrandKit
    const calls = mockApi((method, path) => {
      if (path === '/brand-kits') return [styled]
      if (method === 'POST' && path === '/ads') return campaign({ status: 'running', review: null })
      if (path === '/ads/ad1') return campaign()
      return []
    })
    renderAt('/image/ads', routes)
    expect(await screen.findByText('Using your style')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('What are you advertising?'), 'Cleaning')
    await userEvent.click(screen.getByRole('button', { name: 'Add a quote' }))
    await userEvent.type(screen.getByLabelText('Quote 1'), 'Spotless every time')
    await userEvent.type(screen.getByLabelText('Who said quote 1'), 'Anna, Solna')
    await userEvent.click(screen.getByRole('button', { name: 'Add a quote' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove quote 2' }))
    expect(screen.getByText(/the AI never writes reviews/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Final' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText(/Photos to choose from/)).toBeEnabled()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Follow my ad style' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Draft' }))
    expect(screen.getByLabelText(/Photos to choose from/)).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /Make the ads/ }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/ads')).toBeTruthy())
    expect(calls.find((c) => c.method === 'POST' && c.path === '/ads')!.body).toMatchObject({
      quality: 'draft',
      candidates: 3,
      quotes: [{ text: 'Spotless every time', by: 'Anna, Solna' }],
      use_style: false,
    })
  })

  it('offers the ranked headlines and shows the photo picks on a concept', async () => {
    const c1 = concept(1, {
      key_word: 'ljusen',
      headline_options: [
        { headline: 'Tänd ljusen 1', key_word: 'ljusen', score: 9 },
        { headline: 'Mys utan\ndamm', key_word: 'Mys', score: 8 },
      ],
      photos: {
        portrait: {
          base: null,
          logo: null,
          final: 'g2',
          note: null,
          candidates: [
            { id: 'g1', status: 'done', thumb_url: '/t/g1', media_url: null, score: 6.5, issues: [], picked: false },
            { id: 'g2', status: 'done', thumb_url: '/t/g2', media_url: null, score: 8, issues: [], picked: true },
          ],
          pick: { by: 'vision', model: 'gemma' },
        },
      },
    })
    let camp = campaign({ concepts: [c1, concept(2)] })
    const calls = mockApi((method, path, _q, body) => {
      if (method === 'PATCH' && path === '/ads/ad1/concepts/c1') {
        camp = { ...camp, concepts: camp.concepts.map((c) => (c.id === 'c1' ? { ...c, ...(body as object) } : c)) }
        return camp
      }
      if (path === '/ads/ad1') return camp
      return []
    })
    renderAt('/image/ads/ad1', routes)
    const card = await screen.findByRole('listitem', { name: 'Concept 1' })
    expect(within(card).getByLabelText('Key word')).toHaveValue('ljusen')
    expect(within(card).getByRole('img', { name: 'Photo 2, used in the ads, score 8' })).toBeInTheDocument()
    expect(within(card).getByRole('radio', { name: 'Frosted panel' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(within(card).getByRole('button', { name: 'Mys utan damm' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ headline: 'Mys utan\ndamm', key_word: 'Mys' }))
  })
})
