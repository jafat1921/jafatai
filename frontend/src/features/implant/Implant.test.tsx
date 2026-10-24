import { screen, waitFor, within } from '@testing-library/react'
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
    views: { front: 'Front', left_oblique: 'Left 45°', right_oblique: 'Right 45°' },
    photos: { front: photo('front'), left_oblique: photo('left_oblique'), right_oblique: null },
    sessions: [],
    chart: { session_id: null, option: null, approved_at: null, versions: 0, url: null },
    ...extra,
  }
}

const OPTIONS = [300, 350].map((cc) => ({ label: '', left_cc: cc, right_cc: cc, profile: 'moderate_plus' as const, shape: 'round' as const, placement: 'dual_plane' as const, fill: 'silicone' as const }))

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

  it('renders the options with the spec and the estimate', async () => {
    const { calls, user } = openPatient(patient(), (method, path) => (method === 'POST' && path === '/implant/patients/p1/sessions' ? withResults('queued') : undefined))
    await user.click(await screen.findByRole('button', { name: '300 / 350 / 400 cc moderate-plus' }))
    const go = screen.getByRole('button', { name: /Render the options/ })
    expect(go).toHaveTextContent('3 options × 2 photos = 6 pictures')
    await user.click(go)
    await waitFor(() => expect(calls.find((c) => c.path === '/implant/patients/p1/sessions')).toBeDefined())
    const body = calls.find((c) => c.path === '/implant/patients/p1/sessions')!.body as { options: unknown[] }
    expect(body.options).toEqual(
      [300, 350, 400].map((cc) => ({ label: '', left_cc: cc, right_cc: cc, profile: 'moderate_plus', shape: 'round', placement: 'dual_plane', fill: 'silicone' })),
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
})
