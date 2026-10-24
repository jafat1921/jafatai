import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Rail } from '@/components/shell/Rail'
import { qk } from '@/hooks/keys'
import { cropBox, type ImplantPicture, type Patient } from '@/lib/implant'
import { activeRail, pageTitle } from '@/lib/nav'
import type { User } from '@/lib/types'
import { mockApi, renderAt, systemOk } from '@/test/media-fixtures'
import { ImplantLayout } from './ImplantLayout'
import { ImplantPatientPage } from './ImplantPatientPage'
import { ImplantPatientsPage } from './ImplantPatientsPage'

afterEach(() => vi.unstubAllGlobals())

const member: User = { id: 'u2', email: 'dr@clinic.test', display_name: 'Dr Rana', workspace_id: 'w1', role: 'owner', admin: false, verified: true }
const surgeon: User = { ...member, implant: true }

const photo = (view: ImplantPicture['view'], extra: Partial<ImplantPicture> = {}): ImplantPicture => ({
  id: `ph-${view}`,
  status: 'ready',
  url: `/api/implant/files/ph-${view}`,
  job_id: null,
  view,
  garment: 'garment',
  ...extra,
})

function patient(extra: Partial<Patient> = {}): Patient {
  return {
    id: 'p1',
    label: 'P-0001',
    adult_confirmed: true,
    consent: { at: '2026-10-24T09:00:00Z', attested_by: 'Dr Rana', topless_ok: false, form: false },
    retention_months: 24,
    last_activity_at: '2026-10-24T09:00:00Z',
    created_at: '2026-10-24T09:00:00Z',
    approved: false,
    measurements: {},
    notes: '',
    views: { front: 'Front', left_oblique: 'Left 45°', right_oblique: 'Right 45°', left_lateral: 'Left 90°', right_lateral: 'Right 90°' },
    photos: { front: photo('front'), left_oblique: photo('left_oblique'), right_oblique: null },
    sessions: [],
    chart: { session_id: null, option: null, approved_at: null, versions: 0, url: null },
    ...extra,
  }
}

const OPTIONS = [300, 350].map((cc) => ({ label: '', left_cc: cc, right_cc: cc, profile: 'moderate_plus' as const, shape: 'round' as const, placement: 'dual_plane' as const, fill: 'silicone' as const, procedure: 'augmentation' as const }))

const withResults = (status: ImplantPicture['status'] = 'ready') =>
  patient({
    sessions: [
      {
        id: 's1',
        created_at: '2026-10-24T09:30:00Z',
        options: OPTIONS,
        results: [0, 1].map((option) => ({ id: `r${option}`, status, url: status === 'ready' ? `/api/implant/files/r${option}` : null, job_id: `j${option}`, option, view: 'front' as const })),
      },
    ],
  })

function openPatient(p: Patient = patient(), extra: (method: string, path: string, body: unknown) => unknown = () => undefined) {
  const calls = mockApi((method, path, _q, body) => {
    const hit = extra(method, path, body)
    if (hit !== undefined) return hit
    if (path === '/auth/me') return surgeon
    if (path === '/implant/patients/p1') return p
  })
  renderAt('/clinic/implant/p1', [{ path: '/clinic/implant/:id', element: <ImplantPatientPage /> }], (qc) => qc.setQueryData(['me'], surgeon))
  return { calls, user: userEvent.setup() }
}

describe('Implant Preview access', () => {
  it('shows the rail entry only to admins and granted surgeons', async () => {
    mockApi((_m, p) => {
      if (p === '/system/status') return systemOk
      if (p === '/auth/me') return member
    })
    renderAt('/', [], (qc) => qc.setQueryData(qk.jobs, []), <Rail />)
    const rail = screen.getByRole('navigation', { name: 'Main' })
    await within(rail).findByRole('link', { name: /^Settings\./ })
    expect(within(rail).queryByRole('link', { name: 'Implant Preview' })).toBeNull()
    vi.unstubAllGlobals()
    mockApi((_m, p) => {
      if (p === '/system/status') return systemOk
      if (p === '/auth/me') return surgeon
    })
    renderAt('/clinic/implant/p1', [], (qc) => qc.setQueryData(qk.jobs, []), <Rail />)
    const link = await screen.findByRole('link', { name: 'Implant Preview' })
    expect(link).toHaveAttribute('href', '/clinic/implant')
    expect(link).toHaveAttribute('aria-current', 'page')
    // a surgeon who isn't an admin gets no Print Studio
    expect(screen.queryByRole('link', { name: 'Print Studio' })).toBeNull()
    expect(activeRail('/clinic/implant')).toBe('implant')
    expect(pageTitle('/clinic/implant/p1')).toBe('Implant Preview')
  })

  it('sends anyone else home from the route', async () => {
    mockApi((_m, p) => (p === '/auth/me' ? member : undefined))
    renderAt('/clinic/implant', [{ path: '/clinic/implant', element: <ImplantLayout /> }, { path: '/', element: <p>home</p> }], (qc) => qc.setQueryData(['me'], member))
    expect(await screen.findByText('home')).toBeInTheDocument()
  })
})

describe('Implant patients', () => {
  it('keeps Create disabled until both required ticks are on', async () => {
    const calls = mockApi((method, path) => {
      if (path === '/auth/me') return surgeon
      if (path === '/implant/patients' && method === 'GET') return []
      if (path === '/implant/patients' && method === 'POST') return patient()
    })
    renderAt('/clinic/implant', [{ path: '/clinic/implant', element: <ImplantPatientsPage /> }, { path: '/clinic/implant/:id', element: <p>patient page</p> }], (qc) => qc.setQueryData(['me'], surgeon))
    const user = userEvent.setup()
    expect(await screen.findByText('Add one to start a consultation.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New patient' }))
    const dialog = screen.getByRole('dialog', { name: 'New patient' })
    const create = within(dialog).getByRole('button', { name: 'Create' })
    await user.type(within(dialog).getByLabelText('Patient code or name'), 'P-0001')
    expect(create).toBeDisabled()
    expect(create).toHaveAccessibleDescription(/the age tick, the consent tick/)
    await user.click(within(dialog).getByRole('checkbox', { name: /18 or older/ }))
    expect(create).toBeDisabled()
    await user.click(within(dialog).getByRole('checkbox', { name: /signed the consent form/ }))
    expect(create).toBeEnabled()
    await user.click(create)
    await waitFor(() => expect(screen.getByText('patient page')).toBeInTheDocument())
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ label: 'P-0001', adult_confirmed: true, consent_attested: true, topless_ok: false, retention_months: 24 })
  })
})

describe('Implant patient page', () => {
  it('holds back Topless without consent and explains why', async () => {
    openPatient()
    const slot = (await screen.findByRole('heading', { name: 'Front' })).closest('li')!
    const topless = within(slot).getByRole('radio', { name: 'Topless' })
    expect(topless).toHaveAttribute('aria-disabled', 'true')
    expect(topless).toHaveAccessibleDescription(/separate consent/)
    expect(within(slot).getByRole('radio', { name: 'Bra/top' })).toBeChecked()
    expect(cropBox(15, 100)).toBe('0,0.15,1,0.85')
  })

  it('her own photo comes first, is always in her clothes, and the clinical views keep their choice', async () => {
    const p = patient()
    p.consent.topless_ok = true
    p.views = { own: 'Her own photo', ...p.views }
    openPatient(p)
    const photos = await screen.findByRole('region', { name: 'Photos' })
    expect(within(photos).getAllByRole('heading', { level: 3 })[0]).toHaveTextContent('Her own photo')
    const own = within(photos).getByRole('heading', { name: 'Her own photo' }).closest('li')!
    expect(within(own).queryByRole('radio')).not.toBeInTheDocument()
    expect(within(own).getByText(/dupatta off the chest/)).toBeInTheDocument()
    const front = within(photos).getByRole('heading', { name: 'Front' }).closest('li')!
    expect(within(front).getByRole('radio', { name: 'Topless' })).toHaveAttribute('aria-disabled', 'false')
  })

  it('renders the options with the spec and the estimate', async () => {
    const { calls, user } = openPatient(patient(), (method, path) => (method === 'POST' && path === '/implant/patients/p1/sessions' ? withResults('queued') : undefined))
    await user.click(await screen.findByRole('button', { name: '300 / 350 / 400 cc moderate-plus' }))
    const b = screen.getByRole('group', { name: 'Option B' })
    await user.selectOptions(within(b).getByLabelText('Procedure'), 'Augmentation with lift (mastopexy)')
    const go = screen.getByRole('button', { name: /Render the options/ })
    expect(go).toHaveTextContent('3 options × 2 photos = 6 pictures')
    await user.click(go)
    await waitFor(() => expect(calls.find((c) => c.path === '/implant/patients/p1/sessions')).toBeDefined())
    const body = calls.find((c) => c.path === '/implant/patients/p1/sessions')!.body as { options: unknown[] }
    expect(body.options).toEqual(
      [300, 350, 400].map((cc) => ({
        label: '',
        left_cc: cc,
        right_cc: cc,
        profile: 'moderate_plus',
        shape: 'round',
        placement: 'dual_plane',
        fill: 'silicone',
        procedure: cc === 350 ? 'augmentation_lift' : 'augmentation',
      })),
    )
    expect(await screen.findAllByText('Waiting in queue')).toHaveLength(2)
  })

  it('approves an option with the surgeon’s notes', async () => {
    const { calls, user } = openPatient(withResults(), (method, path) =>
      method === 'POST' && path === '/implant/patients/p1/sessions/s1/approve'
        ? { ...withResults(), approved: true, chart: { session_id: 's1', option: 1, approved_at: '2026-10-24T10:00:00Z', versions: 1, url: '/api/implant/patients/p1/chart.pdf' } }
        : undefined,
    )
    // scoped: role queries over the whole page are slow in jsdom
    const approve = await screen.findByRole('list', { name: 'Approve an option' })
    await user.click(within(approve).getByRole('button', { name: /^Approve this option….*option B/ }))
    await user.type(within(approve).getByLabelText('Surgeon’s notes for option B'), 'Dual plane, IMF incision')
    await user.click(within(approve).getByRole('button', { name: 'Approve and make the chart' }))
    await waitFor(() => expect(calls.find((c) => c.path === '/implant/patients/p1/sessions/s1/approve')?.body).toEqual({ option: 1, notes: 'Dual plane, IMF incision' }))
    expect(await screen.findByText('Chart approved 24 Oct · option B · version 1')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download chart' })).toHaveAttribute('href', '/api/implant/patients/p1/chart.pdf')
  })

  it('opens a finished picture against its photo', async () => {
    const { user } = openPatient(withResults())
    await user.click(await screen.findByRole('button', { name: 'Option A, Front: compare with the photo' }))
    const dialog = screen.getByRole('dialog', { name: 'Option A, Front' })
    expect(within(dialog).getByRole('slider')).toBeInTheDocument()
    const srcs = within(dialog)
      .getAllByRole('img')
      .map((i) => i.getAttribute('src'))
    expect(srcs).toEqual(expect.arrayContaining(['/api/implant/files/ph-front', '/api/implant/files/r0']))
  })

  it('gives every view from the server its own slot and results row', async () => {
    const p = withResults()
    p.photos.left_lateral = photo('left_lateral')
    p.sessions[0].results.push({ id: 'r9', status: 'ready', url: '/api/implant/files/r9', job_id: null, option: 0, view: 'left_lateral' })
    openPatient(p)
    const photos = await screen.findByRole('region', { name: 'Photos' })
    expect(within(photos).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Front', 'Left 45°', 'Right 45°', 'Left 90°', 'Right 90°'])
    expect(screen.getByRole('button', { name: 'Option A, Left 90°: compare with the photo' })).toBeInTheDocument()
  })

  it('outlines the chest area and saves the surgeon’s own', async () => {
    const p = patient({ photos: { front: photo('front', { chest_box: [100, 200, 600, 800] }), left_oblique: photo('left_oblique'), right_oblique: null } })
    const { calls, user } = openPatient(p, (method, path, body) => (method === 'PATCH' && path === '/implant/photos/ph-front' ? photo('front', body as Partial<ImplantPicture>) : undefined))
    const front = (await screen.findByRole('heading', { name: 'Front' })).closest('li')!
    const left = screen.getByRole('heading', { name: 'Left 45°' }).closest('li')!
    expect(within(front).getByTestId('chest-box')).toHaveStyle({ top: '10%', left: '20%', height: '50%', width: '60%' })
    expect(within(left).queryByTestId('chest-box')).toBeNull()
    expect(within(left).getByText(/found automatically on the first render/)).toBeInTheDocument()

    await user.click(within(front).getByRole('button', { name: 'Adjust chest area, Front' }))
    expect(within(front).getByText('Everything outside this area stays exactly as in the photo.')).toBeInTheDocument()
    fireEvent.change(within(front).getByLabelText(/^Top: /), { target: { value: '20' } })
    fireEvent.change(within(front).getByLabelText(/^Right: /), { target: { value: '90' } })
    expect(within(front).getByTestId('chest-box')).toHaveStyle({ top: '20%', width: '70%' })
    await user.click(within(front).getByRole('button', { name: 'Save chest area, Front' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/implant/photos/ph-front', body: { chest_box: [200, 200, 600, 900] } }))
  })

  it('shows the implant size and the planner’s warnings under each option', async () => {
    const check = {
      sides: { left: { width_cm: 11.8, projection_cm: 3.9, cup_change: 1.5 }, right: { width_cm: 11.8, projection_cm: 3.9, cup_change: 1.5 } },
      checks: [
        { level: 'warn', text: 'Ptosis grade 2: a lift is likely needed.' },
        { level: 'info', text: 'Her base widths differ by 1.5 cm.' },
      ],
    }
    const { calls } = openPatient(patient({ measurements: { ptosis_grade: 2 } }), (method, path) => (method === 'POST' && path === '/implant/patients/p1/check' ? [check] : undefined))
    expect(await screen.findByText('≈ 11.8 cm wide · 3.9 cm projection · about +1.5 cups')).toBeInTheDocument()
    expect(screen.getByText('Ptosis grade 2: a lift is likely needed.').closest('li')).toHaveClass('text-studio-warning')
    expect(screen.getByText('Her base widths differ by 1.5 cm.')).toHaveClass('text-studio-muted')
    expect(screen.getByText('Approximate; confirm with the manufacturer’s chart.')).toBeInTheDocument()
    expect(screen.getByText('Add her bra size in Measurements to see the expected cup.')).toHaveClass('text-studio-muted')
    const sent = calls.filter((c) => c.path === '/implant/patients/p1/check')
    expect(sent).toHaveLength(1)
    expect(sent[0].body).toEqual({ options: [{ label: '', left_cc: 300, right_cc: 300, profile: 'moderate_plus', shape: 'round', placement: 'dual_plane', fill: 'silicone', procedure: 'augmentation' }] })
  })

  it('names the cup she goes to, per side when they differ', async () => {
    const side = { width_cm: 11.8, projection_cm: 3.9, cup_change: 1.5 }
    const check = { sides: { left: { ...side, target_cup: 'a full B cup' }, right: { ...side, target_cup: 'a C cup' } }, checks: [] }
    openPatient(patient({ measurements: { bra_size: '32A' } }), (method, path) => (method === 'POST' && path === '/implant/patients/p1/check' ? [check] : undefined))
    expect(await screen.findByText('L From her current 32A to a full B cup')).toBeInTheDocument()
    expect(screen.getByText('R From her current 32A to a C cup')).toBeInTheDocument()
    expect(screen.queryByText(/Add her bra size/)).toBeNull()
  })
})
