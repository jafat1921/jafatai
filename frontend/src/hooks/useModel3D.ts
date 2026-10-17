import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Make3DRequest } from '@/lib/types'
import { qk } from './keys'
import { upsertJob } from './useJobs'
import { upsertMedia } from './useMedia'

// contract v40: one picture in, one Library item of kind "model" and its job out
export function useMake3D() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Make3DRequest) => api.models3d.make(body),
    onSuccess: (res) => {
      upsertMedia(qc, res.item)
      upsertJob(qc, res.job)
      qc.invalidateQueries({ queryKey: qk.jobs })
      qc.invalidateQueries({ queryKey: qk.dashboard })
    },
  })
}

// part 3: what the viewer records or snaps goes back to the Library
export function useTurntable(mediaId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (video: Blob) => api.models3d.turntable(mediaId, video),
    onSuccess: (res) => {
      upsertMedia(qc, res.item)
      upsertMedia(qc, res.model)
    },
  })
}

export function useModelThumbnail(mediaId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (picture: Blob) => api.models3d.thumbnail(mediaId, picture),
    onSuccess: (model) => upsertMedia(qc, model),
  })
}
