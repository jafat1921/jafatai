import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { qk } from '@/hooks/keys'
import type { Generation, Project, Scene, Shot } from '@/lib/types'

export const PID = 'p1'
const T = '2026-10-04T00:00:00Z'

export const scene = (id: string, order: number, extra: Partial<Scene> = {}): Scene => ({
  id,
  project_id: PID,
  order,
  heading: `SCENE ${id.toUpperCase()}`,
  logline: '',
  script_text: 'Something happens.',
  summary: '',
  time_of_day: null,
  mood: null,
  lighting: null,
  source: 'user',
  locked: false,
  version: 1,
  stale: false,
  created_at: T,
  updated_at: T,
  ...extra,
})

export const frame = (id: string, kind: Generation['kind'], target: string, status: Generation['status'] = 'ready'): Generation => ({
  id,
  target_type: 'shot',
  target_id: target,
  kind,
  version: 1,
  status,
  prompt: '',
  params: {},
  seed: 7,
  media_url: `/media/${id}.png`,
  created_at: T,
})

export const shot = (id: string, sceneId: string, order: number, extra: Partial<Shot> = {}): Shot => ({
  id,
  scene_id: sceneId,
  project_id: PID,
  order,
  shot_type: 'medium',
  duration_s: 5,
  description: `shot ${id}`,
  camera: '',
  prompt: '',
  prompt_mode: 'auto',
  character_ids: [],
  location_id: null,
  seam_in: 'cut',
  handoff_text: '',
  status: 'draft',
  stale: false,
  source: 'ai',
  locked: false,
  takes_count: 0,
  created_at: T,
  updated_at: T,
  ...extra,
})

export const project: Project = {
  id: PID,
  title: 'Reef',
  logline: '',
  authoring_mode: 'scene_by_scene',
  aspect_ratio: '16:9',
  target_runtime_s: 120,
  quality: 'draft',
  takes_per_shot: 3,
  overnight: false,
  status: 'in_progress',
  created_at: T,
  updated_at: T,
  counts: { scenes: 2, shots: 2, characters: 0 },
}

export interface Call {
  method: string
  path: string
  body: unknown
}

/** Stubs fetch: records every call and answers PATCH /shots/:id by echoing the merged shot. */
export function mockApi(shots: Shot[]) {
  const calls: Call[] = []
  const json = (data: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input).replace(/^\/api/, '').split('?')[0]
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, path, body })
      const m = path.match(/^\/shots\/([^/]+)$/)
      if (m && method === 'PATCH') {
        const s = shots.find((x) => x.id === m[1])!
        return json({ ...s, ...(body as object) })
      }
      if (method === 'GET') return json([])
      return json({ id: 'job1', type: 'storyboard', status: 'queued', progress: 0, message: '', attempts: 0, created_at: T })
    }),
  )
  return calls
}

export function renderStage(
  ui: React.ReactElement,
  {
    scenes,
    shots,
    takes = {},
    stage = 'storyboard',
    seed,
  }: { scenes: Scene[]; shots: Shot[]; takes?: Record<string, Generation[]>; stage?: string; seed?: (qc: QueryClient) => void },
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(qk.project(PID), project)
  qc.setQueryData(qk.scenes(PID), scenes)
  qc.setQueryData(qk.shots(PID), shots)
  qc.setQueryData(qk.characters(PID), [])
  qc.setQueryData(qk.locations(PID), [])
  qc.setQueryData(qk.jobs, [])
  for (const [shotId, list] of Object.entries(takes)) {
    qc.setQueryData(qk.generations('shot', shotId, 'take', false), list)
  }
  seed?.(qc)
  const result = render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/projects/${PID}/${stage}`]}>
          <Routes>
            <Route path="/projects/:projectId/:stage" element={ui} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
  return { ...result, qc }
}
