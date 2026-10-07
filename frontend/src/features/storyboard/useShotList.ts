import { useMutation, useQueryClient } from '@tanstack/react-query'
import { qk } from '@/hooks/keys'
import { upsertJob } from '@/hooks/useJobs'
import { api } from '@/lib/api'
import type { Job, Scene } from '@/lib/types'
import { trackJobs } from '@/stores/toasts'

// Mutations for the shot-list review gate, merge/split/extend and per-shot re-render (UI polish P3).
export function useShotListActions(projectId: string) {
  const qc = useQueryClient()
  const refreshShots = () => {
    qc.invalidateQueries({ queryKey: qk.shots(projectId) })
    qc.invalidateQueries({ queryKey: qk.project(projectId) })
  }
  const putScene = (scene: Scene) =>
    qc.setQueryData<Scene[]>(qk.scenes(projectId), (old) => old?.map((s) => (s.id === scene.id ? scene : s)))
  const queued = (jobs: Job[], label: string) => {
    jobs.forEach((j) => upsertJob(qc, j))
    if (jobs.length) trackJobs(jobs, label)
  }

  const merge = useMutation({ mutationFn: api.shots.merge, onSuccess: refreshShots })
  const split = useMutation({
    mutationFn: ({ id, ...body }: { id: string; at_ratio?: number; descriptions?: [string, string] }) => api.shots.split(id, body),
    onSuccess: refreshShots,
  })
  const extend = useMutation({
    mutationFn: ({ id, ...body }: { id: string; duration_s?: number; prompt?: string }) => api.shots.extend(id, body),
    onSuccess: (res) => {
      refreshShots()
      queued([res.job], 'Writing the next beat')
    },
  })
  const rerender = useMutation({
    mutationFn: ({ id, ...body }: { id: string; what: 'frames' | 'takes'; count?: number; params?: Record<string, unknown> }) =>
      api.shots.rerender(id, body),
    onSuccess: (res, v) => {
      queued(res.jobs, v.what === 'frames' ? 'Shot frames' : 'Shot takes')
      qc.invalidateQueries({ queryKey: ['generations', 'shot', v.id] })
      refreshShots()
    },
  })
  const setReview = useMutation({
    mutationFn: ({ sceneId, status }: { sceneId: string; status: 'pending' | null }) => api.shots.setReview(sceneId, status),
    onSuccess: putScene,
  })
  const approve = useMutation({
    mutationFn: ({ sceneId, params }: { sceneId: string; params?: Record<string, unknown> }) =>
      api.shots.approveShotList(sceneId, params),
    onSuccess: (res) => {
      putScene(res.scene)
      queued(res.jobs, 'Storyboard frames')
      refreshShots()
    },
  })
  return { merge, split, extend, rerender, setReview, approve }
}
