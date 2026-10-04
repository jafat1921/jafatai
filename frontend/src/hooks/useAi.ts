import { useState } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import { api } from '@/lib/api'
import type { Job, Scene, Suggestion } from '@/lib/types'
import { qk } from './keys'
import { upsertJob, useJob, useJobs } from './useJobs'

// Editors keep a local draft; bumping a scene's revision remounts its editor with the server text.
interface AiRevisionState {
  rev: Record<string, number>
  bump: (ids: string[]) => void
}

export const useAiRevisions = create<AiRevisionState>((set) => ({
  rev: {},
  bump: (ids) =>
    set((s) => {
      const rev = { ...s.rev }
      for (const id of ids) rev[id] = (rev[id] ?? 0) + 1
      return { rev }
    }),
}))

export const useSceneRevision = (sceneId: string) => useAiRevisions((s) => s.rev[sceneId] ?? 0)

const isAi = (job: Job) => job.type.startsWith('ai_')

/** Called from the SSE handler for every job event: keeps scenes, cast and suggestions in step with AI jobs. */
export function syncAiJob(qc: QueryClient, job: Job, before: Job | undefined) {
  if (!isAi(job) || !job.project_id || job.type === 'ai_summarize') return
  const pid = job.project_id
  const r = job.result ?? {}
  const finished = job.status === 'done' && before?.status !== 'done'
  const seen = new Set(before?.result?.drafted_ids ?? [])
  const fresh = (r.drafted_ids ?? []).filter((id) => !seen.has(id))
  const grew = (r.scene_ids?.length ?? 0) !== (before?.result?.scene_ids?.length ?? 0)

  if (fresh.length || grew || (finished && job.type !== 'ai_portrait_prompt')) {
    const toBump = finished ? [...(r.scene_ids ?? []), ...fresh] : fresh
    void qc.invalidateQueries({ queryKey: qk.scenes(pid) }).then(() => useAiRevisions.getState().bump(toBump))
  }
  if (finished) {
    void qc.invalidateQueries({ queryKey: qk.suggestions(pid) })
    void qc.invalidateQueries({ queryKey: qk.characters(pid) })
    void qc.invalidateQueries({ queryKey: qk.project(pid) })
  }
}

/** Starts an AI job and follows it through SSE. `job` is the live row once the worker picks it up. */
export function useAiJob<A>(start: (args: A) => Promise<Job>) {
  const qc = useQueryClient()
  const [jobId, setJobId] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: start,
    onSuccess: (job) => {
      upsertJob(qc, job)
      setJobId(job.id)
    },
  })
  const live = useJob(jobId)
  const job = live ?? (mutation.data?.id === jobId ? mutation.data : undefined)
  const working = mutation.isPending || job?.status === 'queued' || job?.status === 'running'
  const failed = mutation.error ?? (job?.status === 'failed' ? new Error(job.error || 'The AI job failed') : null)
  return {
    run: (args: A) => mutation.mutate(args),
    job,
    working,
    error: failed,
    reset: () => {
      mutation.reset()
      setJobId(null)
    },
  }
}

export function useLatestJob(projectId: string, type: string) {
  const { data } = useJobs()
  return data?.find((j) => j.project_id === projectId && j.type === type)
}

export function useSuggestions(projectId: string) {
  return useQuery({ queryKey: qk.suggestions(projectId), queryFn: () => api.ai.suggestions(projectId), enabled: !!projectId })
}

export function useResolveSuggestion(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) => (accept ? api.ai.accept(id) : api.ai.reject(id)),
    onSuccess: (res) => {
      qc.setQueryData<Suggestion[]>(qk.suggestions(projectId), (old) => old?.filter((s) => s.id !== res.suggestion.id))
      if (res.scene) {
        const scene = res.scene
        qc.setQueryData<Scene[]>(qk.scenes(projectId), (old) => old?.map((s) => (s.id === scene.id ? scene : s)))
        useAiRevisions.getState().bump([scene.id])
      }
      if (res.character) void qc.invalidateQueries({ queryKey: qk.characters(projectId) })
    },
  })
}
