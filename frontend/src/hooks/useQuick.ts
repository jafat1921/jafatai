import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { isQuickJob, quickJobFor, quickResult } from '@/lib/quick'
import type { Generation, Job, Project, QuickRequest } from '@/lib/types'
import { qk } from './keys'
import { upsertJob, useJobs } from './useJobs'
import { useCharacters } from './useCharacters'
import { useLocations } from './useLocations'
import { useProjectShots } from './useShots'
import { useRenders } from './useReel'

export function useQuickRecent() {
  return useQuery({ queryKey: qk.quickRecent, queryFn: api.quick.recent, retry: false })
}

export function useCreateQuick() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: QuickRequest) => api.quick.create(body),
    onSuccess: ({ project, job }) => {
      upsertJob(qc, job)
      qc.setQueryData(qk.project(project.id), project)
      qc.setQueryData(qk.quickJob(project.id), [job])
      qc.setQueryData<Project[]>(qk.projects, (old) => (old ? [project, ...old.filter((p) => p.id !== project.id)] : old))
      qc.invalidateQueries({ queryKey: qk.quickRecent })
    },
  })
}

/** The project's autopilot job: SSE keeps the shared jobs list live, the per-project fetch covers a cold load. */
export function useQuickJob(projectId: string) {
  const live = useJobs()
  const own = useQuery({
    queryKey: qk.quickJob(projectId),
    queryFn: () => api.jobs.list({ project_id: projectId }),
    enabled: !!projectId,
  })
  const fromLive = quickJobFor(live.data, projectId)
  const fromOwn = quickJobFor(own.data, projectId)
  // whichever copy is newer wins (the live list may not have it at all after a reload)
  const job = fromLive && fromOwn?.id === fromLive.id ? fromLive : (fromLive ?? fromOwn)
  return { job, isPending: own.isPending && !job, isError: own.isError && !job, error: own.error, refetch: own.refetch }
}

const lastPreview = (j: Job | undefined) => {
  const ids = quickResult(j).preview_ids
  return Array.isArray(ids) ? `${ids.length}:${ids[ids.length - 1] ?? ''}` : ''
}

export function syncQuickJob(qc: QueryClient, job: Job, before: Job | undefined) {
  if (!job.project_id || !isQuickJob(job)) return
  const pid = job.project_id
  if (before?.status !== job.status) {
    qc.invalidateQueries({ queryKey: qk.quickRecent })
    qc.invalidateQueries({ queryKey: qk.project(pid) })
    if (job.status === 'done' || job.status === 'failed') qc.invalidateQueries({ queryKey: qk.projects })
  }
  // new thumbnails: refresh the lists their media urls come from (only the ones on screen refetch)
  if (lastPreview(job) !== lastPreview(before)) {
    qc.invalidateQueries({ queryKey: qk.characters(pid) })
    qc.invalidateQueries({ queryKey: qk.locations(pid) })
    qc.invalidateQueries({ queryKey: qk.shots(pid) })
    qc.invalidateQueries({ queryKey: qk.renders(pid) })
  }
}

/**
 * Resolves preview_ids to generations with media. There's no GET /generations/{id}, so this
 * looks in the project's lists and in single generations the event stream has delivered.
 * TODO: swap for a batch GET /generations?ids= once the backend has one; cold reloads miss unapproved frames.
 */
export function usePreviewGenerations(projectId: string, ids: string[]): Generation[] {
  const characters = useCharacters(projectId).data
  const locations = useLocations(projectId).data
  const shots = useProjectShots(projectId).data
  const renders = useRenders(projectId).data
  const seen = useQueries({
    queries: ids.map((id) => ({
      queryKey: qk.generation(id),
      queryFn: () => Promise.resolve(null as Generation | null),
      enabled: false,
    })),
  })

  const index = new Map<string, Generation>()
  const add = (g: Generation | null | undefined) => g && index.set(g.id, g)
  characters?.forEach((c) => add(c.approved_portrait))
  locations?.forEach((l) => add(l.approved_establishing))
  shots?.forEach((s) => {
    add(s.start_frame)
    add(s.end_frame)
    add(s.approved_take)
  })
  renders?.forEach(add)
  seen.forEach((q) => add(q.data))

  return ids.map((id) => index.get(id)).filter((g): g is Generation => !!g?.media_url)
}
