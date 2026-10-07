import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'
import type { EstimateQuery, EstimateResult, PromptEnhanceRequest } from '@/lib/types'

// once the server says it has no /estimate, stop asking for the rest of the visit
const missing = new WeakSet<QueryClient>()

const valid = (x: unknown): x is EstimateResult =>
  !!x && Number.isFinite((x as EstimateResult).low_s) && Number.isFinite((x as EstimateResult).high_s)

/**
 * GET /estimate for what the dock is about to run. Falls back to `local` (built from the catalog)
 * while loading or when the server doesn't know the route, so the button always says something.
 */
export function useGenEstimate(q: EstimateQuery | null, local: EstimateResult | null) {
  const qc = useQueryClient()
  const res = useQuery({
    queryKey: ['estimate', q],
    queryFn: async () => {
      try {
        return await api.estimate(q!)
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 405)) missing.add(qc)
        throw e
      }
    },
    enabled: !!q && !missing.has(qc),
    staleTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  })
  const server = valid(res.data) && !res.isError ? { ...res.data, basis: res.data.basis === 'measured' ? ('measured' as const) : ('rough' as const) } : null
  return server ?? local
}

export function usePromptEnhance() {
  return useMutation({ mutationFn: (body: PromptEnhanceRequest) => api.prompts.enhance(body) })
}
