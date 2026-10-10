import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Script, ScriptCreate, ScriptPatch, SplitMode } from '@/lib/dialogue'
import type { Job } from '@/lib/types'
import { qk } from './keys'
import { upsertJob } from './useJobs'

const POLL_MS = 1500
const busy = (j: Job | null | undefined) => j?.status === 'queued' || j?.status === 'running'

// the editor polls while anything of the script is on its way (contract-v17: line jobs, mix, stems)
export const scriptBusy = (s: Script | undefined) => !!s && (s.lines.some((l) => l.status === 'rendering') || busy(s.mix_job) || busy(s.stems_job))

export function useScripts() {
  return useQuery({ queryKey: qk.scripts, queryFn: () => api.scripts.list() })
}

export function useScript(id: string | undefined) {
  return useQuery({
    queryKey: qk.script(id ?? ''),
    queryFn: () => api.scripts.get(id!),
    enabled: !!id,
    refetchInterval: (q) => (scriptBusy(q.state.data) ? POLL_MS : false),
  })
}

const put = (qc: QueryClient, s: Script) => {
  qc.setQueryData(qk.script(s.id), s)
  qc.invalidateQueries({ queryKey: qk.scripts })
}

export function useCreateScript() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (body: ScriptCreate) => api.scripts.create(body), onSuccess: (s) => put(qc, s) })
}

export function usePatchScript(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (body: ScriptPatch) => api.scripts.update(id, body), onSuccess: (s) => put(qc, s) })
}

export function useDeleteScript() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.scripts.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.scripts }),
  })
}

export function useSplitScript(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { text: string; mode: SplitMode; speaker_id?: string | null }) => api.scripts.split(id, body),
    onSuccess: (s) => put(qc, s),
  })
}

export function useImportProject(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { project_id: string; scene_ids?: string[]; include_action?: boolean }) => api.scripts.importProject(id, body),
    onSuccess: (s) => put(qc, s),
  })
}

function afterJobs(qc: QueryClient, id: string, jobs: Job[]) {
  jobs.forEach((j) => upsertJob(qc, j))
  qc.invalidateQueries({ queryKey: qk.jobs })
  qc.invalidateQueries({ queryKey: qk.script(id) })
}

export function useRenderLines(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (lineIds?: string[]) => api.scripts.render(id, lineIds),
    onSuccess: (res) => afterJobs(qc, id, res.jobs ?? []),
  })
}

export function useMixScript(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: () => api.scripts.mix(id), onSuccess: (job) => afterJobs(qc, id, [job]) })
}

export function useStemsScript(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: () => api.scripts.stems(id), onSuccess: (job) => afterJobs(qc, id, [job]) })
}
