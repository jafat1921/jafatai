// M22 Implant Preview: private to the surgeon who made each patient. The server answers 404 to everyone else.
import { request, send } from './api'
import type { GenerationStatus, Job } from './types'

export type View = 'own' | 'front' | 'left_oblique' | 'right_oblique' | 'left_lateral' | 'right_lateral'
// [y1, x1, y2, x2] on a 0–1000 scale, y down
export type ChestBox = [number, number, number, number]
export type Garment = 'garment' | 'topless'
// the AI edit redraws the chest; the shape warp reshapes her own photo by measurement
export type Engine = 'ai' | 'warp'
export type Profile = 'low' | 'moderate' | 'moderate_plus' | 'high' | 'extra_high'
export type ImplantShape = 'round' | 'teardrop'
export type Placement = 'subglandular' | 'submuscular' | 'dual_plane'
export type Fill = 'silicone' | 'saline'
export type Procedure = 'augmentation' | 'augmentation_lift'

export interface Consent {
  at: string | null
  attested_by: string | null
  topless_ok: boolean
  form: boolean
}

export interface PatientSummary {
  id: string
  label: string
  adult_confirmed: boolean
  consent: Consent
  retention_months: number
  last_activity_at: string
  created_at: string
  approved: boolean
}

export interface Measurements {
  height_cm?: number | null
  weight_kg?: number | null
  bra_size?: string
  chest_width_cm?: number | null
  bw_left_cm?: number | null
  bw_right_cm?: number | null
  snn_left_cm?: number | null
  snn_right_cm?: number | null
  nimf_left_cm?: number | null
  nimf_right_cm?: number | null
  pinch_cm?: number | null
  ptosis_grade?: number | null
  asymmetry?: string
}

export interface ImplantPicture {
  id: string
  status: GenerationStatus
  url: string | null
  job_id: string | null
  view?: View
  garment?: Garment
  option?: number
  chest_box?: ChestBox
  garment_check?: boolean | null
  engine?: Engine
}

export interface ImplantOption {
  label: string
  left_cc: number
  right_cc: number
  profile: Profile
  shape: ImplantShape
  placement: Placement
  fill: Fill
  procedure: Procedure
}

export interface ImplantSession {
  id: string
  created_at: string
  options: ImplantOption[]
  results: ImplantPicture[]
}

export interface SideCheck {
  width_cm: number
  projection_cm: number
  cup_change: number
  // only when her bra size is entered, e.g. "a full B cup"
  target_cup?: string | null
}

export interface OptionCheck {
  sides: { left: SideCheck; right: SideCheck }
  checks: { level: 'info' | 'warn'; text: string }[]
}

export interface Chart {
  session_id: string | null
  option: number | null
  approved_at: string | null
  versions: number
  url: string | null
  engine?: Engine
}

export interface Patient extends PatientSummary {
  measurements: Measurements
  notes: string
  views: Partial<Record<View, string>>
  photos: Partial<Record<View, ImplantPicture | null>>
  sessions: ImplantSession[]
  chart: Chart
}

export interface PatientCreate {
  label: string
  adult_confirmed: boolean
  consent_attested: boolean
  topless_ok: boolean
  retention_months: number
  measurements?: Measurements
  notes?: string
}

export type PatientPatch = Partial<Pick<Patient, 'label' | 'retention_months' | 'measurements' | 'notes'>> & { topless_ok?: boolean }

export const VIEWS: View[] = ['front', 'left_oblique', 'right_oblique', 'left_lateral', 'right_lateral']
export const VIEW_LABEL: Record<View, string> = { own: 'Her own photo', front: 'Front', left_oblique: 'Left 45°', right_oblique: 'Right 45°', left_lateral: 'Left 90°', right_lateral: 'Right 90°' }

// the server decides which views a patient has; fall back for an older answer without them
export const patientViews = (p: Patient) => {
  const vs = Object.keys(p.views ?? {}) as View[]
  return vs.length ? vs : VIEWS
}

// same as backend/app/implant/finish.py DEFAULT_BOX
export const CHEST_DEFAULT: Record<View, ChestBox> = {
  own: [80, 100, 650, 900],
  front: [0, 100, 620, 900],
  left_oblique: [0, 80, 620, 920],
  right_oblique: [0, 80, 620, 920],
  left_lateral: [0, 150, 620, 950],
  right_lateral: [0, 50, 620, 850],
}
export const LETTERS = ['A', 'B', 'C']

// same labels as the PDFs (backend/app/implant/sheets.py MEASURES)
export const MEASURES: { key: keyof Measurements; label: string; text?: boolean }[] = [
  { key: 'height_cm', label: 'Height (cm)' },
  { key: 'weight_kg', label: 'Weight (kg)' },
  { key: 'bra_size', label: 'Current bra size', text: true },
  { key: 'chest_width_cm', label: 'Chest width (cm)' },
  { key: 'bw_left_cm', label: 'Base width L (cm)' },
  { key: 'bw_right_cm', label: 'Base width R (cm)' },
  { key: 'snn_left_cm', label: 'Notch–nipple L (cm)' },
  { key: 'snn_right_cm', label: 'Notch–nipple R (cm)' },
  { key: 'nimf_left_cm', label: 'Nipple–fold L (cm)' },
  { key: 'nimf_right_cm', label: 'Nipple–fold R (cm)' },
  { key: 'pinch_cm', label: 'Upper-pole pinch (cm)' },
  { key: 'ptosis_grade', label: 'Ptosis grade (0–3)' },
  { key: 'asymmetry', label: 'Asymmetry', text: true },
]

export const PROFILE_LABEL: Record<Profile, string> = { low: 'Low', moderate: 'Moderate', moderate_plus: 'Moderate plus', high: 'High', extra_high: 'Extra high' }
export const SHAPE_LABEL: Record<ImplantShape, string> = { round: 'Round', teardrop: 'Teardrop' }
export const PLACEMENT_LABEL: Record<Placement, string> = { subglandular: 'Subglandular', submuscular: 'Submuscular', dual_plane: 'Dual plane' }
export const FILL_LABEL: Record<Fill, string> = { silicone: 'Silicone', saline: 'Saline' }
export const PROCEDURE_LABEL: Record<Procedure, string> = { augmentation: 'Augmentation', augmentation_lift: 'Augmentation with lift (mastopexy)' }

export const ENGINES: Engine[] = ['ai', 'warp']
export const ENGINE_LABEL: Record<Engine, string> = { ai: 'AI', warp: 'Shape warp' }
export const engineOf = (p: ImplantPicture) => p.engine ?? 'ai'
// retention 0: deleted when the consultation ends, or 12 hours after the last change
export const SESSION_ONLY = 0
export const sessionOnly = (p: PatientSummary) => p.retention_months === SESSION_ONLY

export const ccOk = (n: number) => Number.isInteger(n) && n >= 100 && n <= 900

export const newOption = (cc = 300): ImplantOption => ({ label: '', left_cc: cc, right_cc: cc, profile: 'moderate_plus', shape: 'round', placement: 'dual_plane', fill: 'silicone', procedure: 'augmentation' })

export const optionLine = (o: ImplantOption) =>
  `${o.left_cc === o.right_cc ? `${o.left_cc} cc` : `L ${o.left_cc} / R ${o.right_cc} cc`} · ${PROFILE_LABEL[o.profile] ?? o.profile}`

export const isPending = (p: ImplantPicture | null | undefined) => !!p && (p.status === 'queued' || p.status === 'generating')
export const isDone = (p: ImplantPicture | null | undefined) => !!p && (p.status === 'ready' || p.status === 'approved')

export const implantBusy = (p: Patient | undefined) => !!p && (p.sessions.some((s) => s.results.some(isPending)) || Object.values(p.photos).some(isPending))

export const shortDay = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '')

// crop is x,y,w,h as fractions; only the height is cut, so the face stays out of the picture
export const cropBox = (top: number, bottom: number) => `0,${+(top / 100).toFixed(3)},1,${+((bottom - top) / 100).toFixed(3)}`

async function multipart<T>(path: string, fields: Record<string, string | Blob>) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return (await (await send(path, { method: 'POST', body: form })).json()) as T
}

const base = (id: string) => `/implant/patients/${id}`

export const implantApi = {
  list: () => request<PatientSummary[]>('GET', '/implant/patients'),
  get: (id: string) => request<Patient>('GET', base(id)),
  create: (body: PatientCreate) => request<Patient>('POST', '/implant/patients', body),
  patch: (id: string, body: PatientPatch) => request<Patient>('PATCH', base(id), body),
  remove: (id: string) => request<void>('DELETE', base(id)),
  end: (id: string) => request<void>('POST', `${base(id)}/end`),
  consentForm: (id: string, file: File) => multipart<Patient>(`${base(id)}/consent-form`, { file }),
  photo: (id: string, body: { file: File; view: View; garment: Garment; crop?: string }) =>
    multipart<ImplantPicture>(`${base(id)}/photos`, { file: body.file, view: body.view, garment: body.garment, ...(body.crop ? { crop: body.crop } : {}) }),
  chestBox: (genId: string, box: ChestBox) => request<ImplantPicture>('PATCH', `/implant/photos/${genId}`, { chest_box: box }),
  check: (id: string, options: ImplantOption[]) => request<OptionCheck[]>('POST', `${base(id)}/check`, { options }),
  render: (id: string, options: ImplantOption[], engines: Engine[]) => request<Patient>('POST', `${base(id)}/sessions`, { options, engines }),
  approve: (id: string, sessionId: string, body: { option: number; engine: Engine; notes: string }) => request<Patient>('POST', `${base(id)}/sessions/${sessionId}/approve`, body),
  retry: (jobId: string) => request<Job>('POST', `/jobs/${jobId}/retry`, {}),
  chartUrl: (id: string) => `/api${base(id)}/chart.pdf`,
  consultationUrl: (id: string, sessionId: string) => `/api${base(id)}/sessions/${sessionId}/consultation.pdf`,
}
