import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { UpscalePage, VisualKind } from '@/lib/types'
import { qk } from './keys'

const RUNNING = new Set(['queued', 'generating'])
export const UPSCALE_PAGE = 12

/** The workspace's upscales, newest first; polls while any of them is still being made. */
export function useUpscaleList(kind: VisualKind) {
  return useInfiniteQuery({
    queryKey: qk.upscales(kind),
    queryFn: ({ pageParam }) => api.upscales.list({ kind, limit: UPSCALE_PAGE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: UpscalePage) => last.next_cursor || undefined,
    // SSE covers jobs, but a finished upscale also moves its item's thumbnail; a slow poll is simplest
    refetchInterval: (q) => (q.state.data?.pages.some((p) => (p.items ?? []).some((r) => RUNNING.has(r.status))) ? 4000 : false),
  })
}

export function useDeleteUpscale() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (generationId: string) => api.upscales.remove(generationId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.upscalesAll })
      qc.invalidateQueries({ queryKey: qk.mediaLists })
      qc.invalidateQueries({ queryKey: ['media', 'item'] })
    },
  })
}
