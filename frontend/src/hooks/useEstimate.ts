import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { LONGTAKE_MAX_S, localEstimate } from '@/lib/duration'
import type { ShotEstimate } from '@/lib/types'
import { qk } from './keys'

const looksLikeEstimate = (x: unknown): x is ShotEstimate =>
  !!x && typeof (x as ShotEstimate).chunks === 'number' && typeof (x as ShotEstimate).est_gpu_s === 'number'

/**
 * GET /shots/{id}/estimate for a duration. Falls back to a local guess while it loads or when the
 * server doesn't know the route yet, so the picker always has something honest-ish to say.
 */
export function useShotEstimate(shotId: string | undefined, durationS: number | null) {
  const valid = durationS !== null && durationS >= 1
  const q = useQuery({
    queryKey: qk.shotEstimate(shotId ?? '', durationS ?? 0),
    queryFn: () => api.shots.estimate(shotId!, durationS!),
    enabled: !!shotId && valid,
    staleTime: 5 * 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  })
  const server = looksLikeEstimate(q.data) && !q.isPlaceholderData ? q.data : null
  return {
    estimate: server ?? (valid ? localEstimate(durationS!) : null),
    exact: !!server,
    max: (looksLikeEstimate(q.data) && q.data.max_s) || LONGTAKE_MAX_S,
  }
}
