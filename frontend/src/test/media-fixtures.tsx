import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Job, MediaItem, SystemStatus } from '@/lib/types'

export const T = '2026-10-07T10:00:00Z'

export const media = (id: string, extra: Partial<MediaItem> = {}): MediaItem => ({
  id,
  workspace_id: 'w1',
  kind: 'image',
  origin: 'generated',
  title: `Image ${id}`,
  tags: [],
  generation_id: `g-${id}`,
  width: 1024,
  height: 1024,
  media_url: `/media/${id}.png`,
  created_at: T,
  updated_at: T,
  versions_count: 1,
  ...extra,
})

export const job = (id: string, extra: Partial<Job> = {}): Job => ({
  id,
  type: 'image_generate',
  status: 'queued',
  progress: 0,
  message: '',
  attempts: 0,
  created_at: T,
  ...extra,
})

export const systemOk: SystemStatus = {
  comfy: { ok: true, url: 'http://gpu:8188', version: '0.3' },
  llm: { ok: false, url: 'http://gpu:11434', error: 'connection refused' },
  driver: 'comfy',
  worker: { alive: true },
}

export interface ApiCall {
  method: string
  path: string
  query: Record<string, string>
  body: unknown
}

type Handler = (method: string, path: string, query: Record<string, string>, body: unknown) => unknown

/** Like quick-fixtures' mockFetch, but keeps the query string so list filters can be asserted. */
export function mockApi(handler: Handler) {
  const calls: ApiCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x')
      const path = url.pathname.replace(/^\/api/, '')
      const query = Object.fromEntries(url.searchParams.entries())
      const method = init?.method ?? 'GET'
      // multipart uploads (FormData) are passed through as they are
      const body = init?.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : undefined
      calls.push({ method, path, query, body })
      const data = handler(method, path, query, body)
      if (data instanceof Response) return data
      return new Response(JSON.stringify(data ?? []), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  return calls
}

function Where() {
  const loc = useLocation()
  return <output data-testid="location">{loc.pathname + loc.search}</output>
}

export function renderAt(
  path: string,
  routes: { path: string; element: React.ReactElement }[],
  seed: (qc: QueryClient) => void = () => {},
  // rendered beside the routes, on every path (the rail, a top bar…)
  chrome?: React.ReactElement,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(['jobs'], [])
  seed(qc)
  const result = render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          {chrome}
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
