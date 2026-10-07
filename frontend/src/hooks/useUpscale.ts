import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Generation, ImageUpscaleRequest, UpscaleRequest } from '@/lib/types'
import type { Size } from '@/lib/upscale'
import { qk } from './keys'
import { upsertJob } from './useJobs'

export function useUpscaleOptions(enabled = true) {
  return useQuery({
    queryKey: qk.upscaleOptions,
    queryFn: api.system.upscaleOptions,
    enabled,
    // template checks don't change while you look at a dialog
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useUpscale(projectId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpscaleRequest }) => api.generations.upscale(id, body),
    onSuccess: (job) => {
      upsertJob(qc, job)
      // the new render row exists as soon as the job is queued
      if (projectId) qc.invalidateQueries({ queryKey: qk.renders(projectId) })
      // standalone videos get the result as a new version of the library item
      else qc.invalidateQueries({ queryKey: ['media'] })
    },
  })
}

export function useImageUpscaleOptions(generationId: string) {
  return useQuery({
    queryKey: [...qk.upscaleOptions, generationId],
    queryFn: () => api.system.imageUpscaleOptions(generationId),
    staleTime: 60_000,
    retry: false,
  })
}

export function useImageUpscale(source: Pick<Generation, 'target_type' | 'target_id' | 'kind'>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ImageUpscaleRequest }) => api.generations.upscale(id, body),
    onSuccess: (job) => {
      upsertJob(qc, job)
      // the new version is queued already; pull it into Versions without waiting for SSE
      qc.invalidateQueries({ queryKey: qk.generationsFor(source.target_type, source.target_id, source.kind) })
      if (source.target_type === 'media') qc.invalidateQueries({ queryKey: ['media'] })
    },
  })
}

/** Reads width/height from the file itself when the render's params don't carry them. */
export function useVideoSize(url: string | null | undefined, known: Size | null) {
  const [probed, setProbed] = useState<{ url: string; size: Size } | null>(null)
  useEffect(() => {
    if (known || !url || typeof document === 'undefined') return
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    const done = () => {
      if (v.videoWidth && v.videoHeight) setProbed({ url, size: { w: v.videoWidth, h: v.videoHeight } })
    }
    v.addEventListener('loadedmetadata', done)
    v.src = url
    return () => {
      v.removeEventListener('loadedmetadata', done)
      v.removeAttribute('src')
    }
  }, [url, known])
  return known ?? (probed && probed.url === url ? probed.size : null)
}
