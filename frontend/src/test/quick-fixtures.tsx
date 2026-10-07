import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Generation, Job, Project, QuickStage, UpscaleOptions } from '@/lib/types'
import type { Call } from './storyboard-fixtures'

export const T = '2026-10-07T10:00:00Z'

export const quickProject: Project = {
  id: 'q1',
  title: 'Lighthouse Fox',
  logline: '',
  authoring_mode: 'quick',
  aspect_ratio: '16:9',
  target_runtime_s: 30,
  quality: 'draft',
  takes_per_shot: 1,
  overnight: true,
  status: 'rendering',
  created_at: T,
  updated_at: T,
  counts: { scenes: 1, shots: 3, characters: 1 },
}

export const stage = (key: QuickStage['key'], label: string, status: QuickStage['status'], extra: Partial<QuickStage> = {}): QuickStage => ({
  key,
  label,
  status,
  ...extra,
})

export const autopilotJob = (extra: Partial<Job> = {}, result: Record<string, unknown> = {}): Job => ({
  id: 'j1',
  type: 'quick_autopilot',
  status: 'running',
  progress: 0.4,
  message: 'Rendering shot 2 of 3',
  project_id: 'q1',
  attempts: 1,
  created_at: T,
  result,
  ...extra,
})

export const video = (id: string, extra: Partial<Generation> = {}): Generation => ({
  id,
  target_type: 'project',
  target_id: 'q1',
  kind: 'render',
  version: 1,
  status: 'ready',
  prompt: '',
  params: { title: 'Full film', full: true, duration_s: 30 },
  seed: null,
  media_url: `/media/${id}.mp4`,
  created_at: T,
  ...extra,
})

export const upscaleOptions: UpscaleOptions = {
  engines: [
    { id: 'best', label: 'SeedVR2', available: false, reason: 'SeedVR2 nodes are missing', scales: [2, 4], est_gpu_s_per_output_s: 40 },
    { id: 'fast', label: 'FlashVSR', available: true, scales: [2, 4], est_gpu_s_per_output_s: 8 },
    { id: 'quick', label: 'RealESRGAN', available: true, scales: [4], est_gpu_s_per_output_s: 3 },
  ],
  default_engine: 'fast',
  targets: ['1080p', '1440p', '4k'],
}

type Handler = (method: string, path: string, body: unknown) => unknown

/** Stubs fetch; `handler` answers by path, anything it returns undefined for gets []. */
export function mockFetch(handler: Handler) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input).replace(/^\/api/, '').split('?')[0]
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, path, body })
      const data = handler(method, path, body)
      if (data instanceof Response) return data
      return new Response(JSON.stringify(data ?? []), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  return calls
}

function Where() {
  const loc = useLocation()
  return <output data-testid="location">{loc.pathname}</output>
}

export function renderRoutes(
  path: string,
  routes: { path: string; element: React.ReactElement }[],
  seed: (qc: QueryClient) => void = () => {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(['jobs'], [])
  seed(qc)
  const result = render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            {routes.map((r) => (
              <Route key={r.path} path={r.path} element={r.element} />
            ))}
            <Route path="*" element={<p>elsewhere</p>} />
          </Routes>
          <Where />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
  return { ...result, qc }
}
