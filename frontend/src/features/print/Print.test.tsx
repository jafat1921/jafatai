import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Rail } from '@/components/shell/Rail'
import { AdminLayout } from '@/features/admin/shared'
import { qk } from '@/hooks/keys'
import { activeRail, pageTitle } from '@/lib/nav'
import { bestDpi, guessLanguage, pixels, shapeFamily, sizeLabel, tooBig, type PrintDesign, type PrintJob } from '@/lib/print'
import type { User } from '@/lib/types'
import { mockApi, renderAt, systemOk } from '@/test/media-fixtures'
import { PrintJobPage } from './PrintJobPage'
import { PrintStudioPage } from './PrintStudioPage'

afterEach(() => vi.unstubAllGlobals())

const admin: User = { id: 'u1', email: 'owner@studio.test', display_name: 'Owner', workspace_id: 'w1', role: 'owner', admin: true, verified: true }
const member: User = { ...admin, id: 'u2', admin: false }

const LINES = { name: 'Stjärnans Livs', tagline: 'Frukt & Grönt', opening_hours: 'Öppet alla dagar 08–22', phone: '[Telefonnummer]', offers: [] }

function design(extra: Partial<PrintDesign> = {}): PrintDesign {
  return {
    id: 'd1',
    concept_id: 'c1',
    n: 1,
    status: 'ready',
    error: null,
    media_id: 'm1',
    generation_id: 'g1',
    version: 1,
    image_url: '/api/media/p.png',
    thumb_url: '/api/media/thumb/g1',
    width: 856,
    height: 2400,
    overrides: {},
    report: {
      layout: 'stack',
      all_pass: true,
      contrast: { name: 7.4, hours: 4.52 },
      min_text: { cap_mm: 15, cap_cm: 1.5, role: 'hours', need_mm: 15, distance: 'street', pass: true },
      gamut: [{ role: 'accent', hex: '#00FF00', safe: '#ADEC9A', chroma: 119.8, ceiling: 48.5 }],
      dropped: ['address'],
      boxes: { trim: [0.0117, 0.0042, 0.988, 0.9958], safe: [0.07, 0.03, 0.93, 0.97] },
      colours: { ground: '#FFF8E1', ink: '#1B5E20', accent: '#00FF00', band_ink: '#1B5E20' },
      canvas: { width_mm: 250, height_mm: 700, bleed_mm: 3, dpi: 150, px: [1512, 4169], mp: 6.3, label: '' },
    },
    spec: {
      job: 'sign',
      design: 'typographic',
      layout: 'stack',
      decor: 'awning',
      hero: 'name',
      caps: true,
      size: { width_mm: 250, height_mm: 700, bleed_mm: 3, dpi: 150, shape: 'rect' },
      language: 'sv',
      rtl: false,
      texts: { name: 'Stjärnans Livs', tagline: 'Frukt & Grönt', headline: '', offers: [], hours: 'Öppet alla dagar 08–22', phone: '[Telefonnummer]', address: '', website: '', cta: '' },
      colours: { ground: '#FFF8E1', ink: '#1B5E20', accent: '#00FF00' },
      font_preset: 'condensed',
      logo: { position: 'auto', variant: 'auto' },
      focus: { x: 0.5, y: 0.5 },
      print_safe: false,
    },
    files: { status: 'none', files: {}, made_at: null },
    stale: false,
    ...extra,
  }
}

function job(extra: Partial<PrintJob> = {}): PrintJob {
  return {
    id: 'p1',
    kind: 'print',
    title: 'Stjärnans Livs · 25 × 70 cm',
    language: 'sv',
    rtl: false,
    stage: 'done',
    status: 'done',
    review: null,
    stages: [
      { key: 'concepts', label: 'Concepts', status: 'done', detail: null },
      { key: 'pictures', label: 'Pictures', status: 'done', detail: null },
      { key: 'layout', label: 'Layout', status: 'done', detail: null },
      { key: 'files', label: 'Print files', status: 'done', detail: null },
    ],
    brief: { job: 'sign', width_cm: 25, height_cm: 70, lines: LINES, language: 'sv' },
    size: { width_cm: 25, height_cm: 70, dpi: 150, bleed_mm: 3, shape: 'rect', px: [1512, 4169], trim_px: [1476, 4134], mp: 6.3, label: '25 × 70 cm · 150 dpi · 1476 × 4134 px', family: 'tall', min_cap_mm: 15 },
    brand_kit: null,
    concepts: [
      { id: 'c1', n: 1, approved: true, family: 'typographic', layout: 'stack', decor: 'awning', hero: 'name', headline: '', cta: '', font: 'condensed', caps: true, insight: '', offers: [], colours: {}, error: null, pictures: {} },
    ],
    designs: [design()],
    job: null,
    created_at: '2026-10-18T10:00:00Z',
    updated_at: '2026-10-18T10:00:00Z',
    ...extra,
  }
}

describe('print sizes', () => {
  it('works out pixels, families, the dpi limit and the language', () => {
    expect(pixels(25, 70, 150)).toMatchObject({ trim: [1476, 4134], full: [1512, 4169] })
    expect(sizeLabel(106, 160, 150)).toBe('106 × 160 cm · 150 dpi · 6260 × 9449 px')
    expect(shapeFamily('sign', 25, 70)).toBe('tall')
    expect(shapeFamily('sign', 70, 25)).toBe('wide')
    expect(shapeFamily('board', 106, 160)).toBe('tall')
    expect(shapeFamily('flyer', 21, 29.7)).toBe('sheet')
    expect(shapeFamily('sticker', 10, 10, 'round')).toBe('square')
    expect(tooBig(106, 160, 300)).toBe(true)
    expect(bestDpi(106, 160, 300)).toBe(200)
    expect(guessLanguage('Stjärnans Livs')).toBe('sv')
    expect(guessLanguage('ستارہ جنرل سٹور')).toBe('ur')
    expect(guessLanguage('Corner Shop')).toBe('en')
  })
})

describe('Print Studio access', () => {
  it('shows the rail entry to admins only and lights it on its pages', async () => {
    mockApi((_m, p) => {
      if (p === '/system/status') return systemOk
      if (p === '/auth/me') return member
    })
    renderAt('/admin/print', [], (qc) => qc.setQueryData(qk.jobs, []), <Rail />)
    const rail = screen.getByRole('navigation', { name: 'Main' })
    await within(rail).findByRole('link', { name: /^Settings\./ })
    expect(within(rail).queryByRole('link', { name: 'Print Studio' })).toBeNull()
    vi.unstubAllGlobals()
    mockApi((_m, p) => {
      if (p === '/system/status') return systemOk
      if (p === '/auth/me') return admin
    })
    renderAt('/admin/print/p1', [], (qc) => qc.setQueryData(qk.jobs, []), <Rail />)
    const link = await screen.findByRole('link', { name: 'Print Studio' })
    expect(link).toHaveAttribute('href', '/admin/print')
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(activeRail('/admin/print')).toBe('print')
    expect(activeRail('/admin/users')).toBe('admin')
    expect(pageTitle('/admin/print/p1')).toBe('Print Studio')
  })

  it('sends anyone else home from the route', async () => {
    mockApi((_m, p) => (p === '/auth/me' ? member : undefined))
    renderAt('/admin/print', [{ path: '/admin/print', element: <AdminLayout /> }, { path: '/', element: <p>home</p> }], (qc) => qc.setQueryData(['me'], member))
    expect(await screen.findByText('home')).toBeInTheDocument()
  })
})

describe('Print Studio brief', () => {
  function open() {
    const calls = mockApi((method, path) => {
      if (path === '/auth/me') return admin
      if (path === '/print' && method === 'GET') return []
      if (path === '/print' && method === 'POST') return job()
      if (path === '/brand-kits') return []
    })
    renderAt('/admin/print', [{ path: '/admin/print', element: <PrintStudioPage /> }, { path: '/admin/print/:id', element: <p>job page</p> }], (qc) => qc.setQueryData(['me'], admin))
    return { calls, user: userEvent.setup() }
  }

  it('picks a preset or a free size and shows the pixels', async () => {
    const { user } = open()
    expect(await screen.findByText('25 × 70 cm · 150 dpi · 1476 × 4134 px')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Board 106 × 160' }))
    expect(screen.getByText('106 × 160 cm · 150 dpi · 6260 × 9449 px')).toBeInTheDocument()
    // turning it round
    await user.click(screen.getByRole('button', { name: /Swap width and height/ }))
    expect(screen.getByText('160 × 106 cm · 150 dpi · 9449 × 6260 px')).toBeInTheDocument()
    // a free size in millimetres
    await user.click(screen.getByRole('radio', { name: 'mm' }))
    const width = screen.getByLabelText('Width (mm)')
    await user.clear(width)
    await user.type(width, '700')
    const height = screen.getByLabelText('Height (mm)')
    await user.clear(height)
    await user.type(height, '250')
    expect(screen.getByText('70 × 25 cm · 150 dpi · 4134 × 1476 px')).toBeInTheDocument()
    // too many pixels: the dpi it can take is offered
    await user.click(screen.getByRole('button', { name: 'Board 106 × 160' }))
    await user.selectOptions(screen.getByLabelText('Resolution'), '200')
    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByRole('option', { name: /300 dpi \(too large/ }) as HTMLOptionElement).disabled).toBe(true)
  })

  it('sends the brief with the shop’s exact lines and the guessed language', async () => {
    const { calls, user } = open()
    const go = await screen.findByRole('button', { name: 'Design the options' })
    await user.click(go)
    expect(screen.getByText('Type the shop’s name first.')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    await user.type(screen.getByLabelText('Name (required)'), 'Stjärnans Livs')
    await user.type(screen.getByLabelText('Tagline'), 'Frukt & Grönt')
    await user.type(screen.getByLabelText('Opening hours'), 'Öppet alla dagar 08–22')
    await user.type(screen.getByLabelText('Kind of business'), 'livs / mini market')
    await user.type(screen.getByLabelText('Another offer'), 'Bananer 19,90 kr/kg{Enter}')
    expect(screen.getByRole('option', { name: 'Auto, from the lines (Swedish)' })).toBeInTheDocument()
    await user.click(go)
    await waitFor(() => expect(screen.getByText('job page')).toBeInTheDocument())
    const body = calls.find((c) => c.method === 'POST' && c.path === '/print')!.body as Record<string, unknown>
    expect(body).toMatchObject({
      job: 'sign',
      width_cm: 25,
      height_cm: 70,
      dpi: 150,
      viewing_distance: 'street',
      language: 'sv',
      business_type: 'livs / mini market',
      lines: { name: 'Stjärnans Livs', tagline: 'Frukt & Grönt', opening_hours: 'Öppet alla dagar 08–22', offers: ['Bananer 19,90 kr/kg'] },
      variants: 3,
    })
  })
})

describe('Print job page', () => {
  function open(j: PrintJob = job(), extra: (method: string, path: string, body: unknown) => unknown = () => undefined) {
    const calls = mockApi((method, path, _q, body) => {
      const hit = extra(method, path, body)
      if (hit !== undefined) return hit
      if (path === '/auth/me') return admin
      if (path === '/print/p1') return j
    })
    renderAt('/admin/print/p1', [{ path: '/admin/print/:id', element: <PrintJobPage /> }], (qc) => qc.setQueryData(['me'], admin))
    return { calls, user: userEvent.setup() }
  }

  it('shows each option at its true ratio with its physical size', async () => {
    open()
    const card = await screen.findByRole('listitem', { name: 'Option 1' })
    const img = within(card).getByRole('img', { name: /Option 1: Stjärnans Livs/ })
    expect(img.parentElement).toHaveStyle({ aspectRatio: '1512 / 4169' })
    expect(within(card).getByText('25 × 70 cm · 150 dpi · 1476 × 4134 px')).toBeInTheDocument()
    expect(within(card).getByText('Passes the print checks')).toBeInTheDocument()
  })

  it('opens the editor with the print checks and makes the files', async () => {
    const { calls, user } = open(job(), (method, path) => {
      if (method === 'POST' && path === '/print/p1/files') return { id: 'j9', type: 'ad_campaign', status: 'queued', progress: 0, message: '' }
    })
    await user.click(await screen.findByRole('button', { name: 'Edit and download' }))
    const checks = screen.getByRole('region', { name: 'Print checks' })
    expect(within(checks).getByText('Smallest text 1.5 cm')).toBeInTheDocument()
    expect(within(checks).getByText('Contrast passes WCAG AA')).toBeInTheDocument()
    expect(within(checks).getByText('Some colours will print duller')).toBeInTheDocument()
    expect(within(checks).getByText(/Accent #00FF00 prints closer to #ADEC9A/)).toBeInTheDocument()
    expect(within(checks).getByText(/^Address\./)).toBeInTheDocument()
    expect(within(checks).getByRole('switch', { name: /Show trim and safe area/ })).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Make the print files' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/print/p1/files')?.body).toEqual({ design_ids: ['d1'] }))
  })

  it('lists the downloads once the files are made, and makes another size', async () => {
    const files = {
      status: 'ready' as const,
      made_at: null,
      files: Object.fromEntries(
        (['pdf', 'png', 'jpg', 'svg', 'zip'] as const).map((f) => [f, { url: `/api/print/p1/designs/d1/files/${f}`, media_type: '', bytes: 2_500_000, generation_id: f }]),
      ),
    }
    const { calls, user } = open(job({ designs: [design({ files })] }), (method, path) => {
      if (method === 'POST' && path === '/print/p1/designs/d1/resize') return job({ id: 'p2' })
    })
    await user.click(await screen.findByRole('button', { name: 'Edit and download' }))
    const dl = screen.getByRole('region', { name: 'Download option 1' })
    expect(within(dl).getByRole('link', { name: /PDF \(print\)/ })).toHaveAttribute('href', '/api/print/p1/designs/d1/files/pdf')
    expect(within(dl).getByRole('link', { name: /SVG \(editable\)/ })).toBeInTheDocument()
    expect(within(dl).getByRole('link', { name: /Layers \(ZIP\)/ })).toHaveTextContent('2.4 MB')
    await user.click(screen.getByRole('button', { name: 'Board 106 × 160' }))
    expect(screen.getByText('106 × 160 cm · 150 dpi · 6260 × 9449 px')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Make it' }))
    await waitFor(() => expect(calls.find((c) => c.path === '/print/p1/designs/d1/resize')?.body).toEqual({ width_cm: 106, height_cm: 160, job: 'board' }))
  })

  it('edits a line and saves only what changed', async () => {
    const { calls, user } = open(job(), (method, path, body) => {
      if (method === 'POST' && path === '/print/p1/designs/d1/preview') return new Response(new Blob(['x'], { type: 'image/png' }))
      if (method === 'PATCH' && path === '/print/p1/designs/d1') return { ...design(), version: 2, overrides: body as Record<string, unknown> }
    })
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview')
    globalThis.URL.revokeObjectURL = vi.fn()
    await user.click(await screen.findByRole('button', { name: 'Edit and download' }))
    const form = screen.getByRole('form', { name: 'Edit option 1' })
    await user.type(within(form).getByLabelText('Hero line'), 'Färskt varje dag')
    await user.click(within(form).getByRole('radio', { name: 'Frame' }))
    await user.click(within(form).getByRole('button', { name: 'Save this version' }))
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ texts: { headline: 'Färskt varje dag' }, decor: 'frame' }),
    )
  })
})
