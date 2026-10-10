import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { qk } from './keys'

// both are cached on the server and keyed by version here, so a new version fetches fresh ones
export function usePeaks(id: string | null | undefined, version: string | null = null, n = 4000) {
  return useQuery({
    queryKey: qk.peaks(id ?? '', version, n),
    queryFn: () => api.audio.peaks(id!, { n, version: version ?? undefined }),
    enabled: !!id,
    staleTime: 5 * 60_000,
  })
}

export function useAudioAnalysis(id: string | null | undefined, version: string | null = null) {
  return useQuery({
    queryKey: qk.audioAnalysis(id ?? '', version),
    queryFn: () => api.audio.analysis(id!, version ?? undefined),
    enabled: !!id,
    staleTime: 5 * 60_000,
  })
}
